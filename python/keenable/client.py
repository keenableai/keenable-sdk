"""Sync and async clients for the Keenable API."""

from __future__ import annotations

import ipaddress
import math
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from os import environ
from typing import Any, Literal
from urllib.parse import urlsplit

import httpx

from ._version import __version__
from .errors import (
    KeenableAPIError,
    KeenableAuthError,
    KeenableConnectionError,
    KeenableInsufficientCreditsError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
    KeenableTargetError,
    RateLimitInfo,
)
from .models import Page, SearchResponse

__all__ = ["Keenable", "AsyncKeenable"]

DEFAULT_BASE_URL = "https://api.keenable.ai"
DEFAULT_TIMEOUT = 90.0

# Endpoints are named once; the keyless variant of each is the same path with a
# `/public` suffix, so a new endpoint is one name rather than two constants.
_SEARCH = "search"
_FETCH = "fetch"

_BLOCKED_HOSTS = frozenset({"localhost", "metadata.google.internal"})
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

_STATUS_LABELS = {
    401: "Keenable authentication failed (401)",
    403: "Keenable authentication failed (403)",
    402: "Keenable: insufficient credits (402)",
    429: "Keenable rate limit exceeded (429)",
}


def _resolve_base_url(base_url: str | None) -> str:
    """Resolve and validate the API base URL, enforcing HTTPS off-localhost."""
    base = (base_url or environ.get("KEENABLE_API_URL") or DEFAULT_BASE_URL).rstrip("/")
    parsed = urlsplit(base)
    if parsed.hostname:
        if parsed.scheme == "https":
            return base
        if parsed.scheme == "http" and parsed.hostname in _LOCAL_HOSTS:
            return base
    raise KeenableInvalidRequestError(
        f"base_url must be an https:// URL with a host, got {base!r}"
    )


def _reject_private_fetch_target(url: str) -> None:
    """Refuse obviously internal fetch targets before a request leaves the host.

    The backend enforces this too, but stopping here keeps an internal hostname
    out of an outbound request in the first place.
    """
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"}:
        raise KeenableInvalidRequestError(f"fetch() needs an http(s) URL, got {url!r}")

    # A trailing dot resolves to the same host but does not match it as a
    # string, which is enough to walk past the blocklist below.
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if not host:
        raise KeenableInvalidRequestError(f"fetch() URL has no host: {url!r}")
    if host in _BLOCKED_HOSTS:
        raise KeenableInvalidRequestError(f"refusing to fetch internal host {host!r}")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return  # A hostname; the backend's SSRF guard is the backstop.
    if (
        ip.is_loopback
        or ip.is_private
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    ):
        raise KeenableInvalidRequestError(f"refusing to fetch private address {host!r}")


def _search_payload(query: str, mode: str | None, **filters: Any) -> dict[str, Any]:
    """Build the search request body, dropping filters the caller left unset."""
    if not query or not query.strip():
        raise KeenableInvalidRequestError("search() needs a non-empty query")

    payload: dict[str, Any] = {"query": query}
    if mode:
        payload["mode"] = mode
    payload.update(
        {name: value for name, value in filters.items() if value is not None}
    )
    return payload


# A 403 with one of these codes is about the page being fetched or the URL
# asked for, not about the caller's credentials, so it is not reported as an
# authentication failure.
_NOT_AUTH_CODES = frozenset({"private_url_not_allowed"})

# Codes for a page that failed, besides every code starting with "target_".
_TARGET_CODES = frozenset({"page_not_found", "content_not_extracted"})

# The API's title for a 403 from the fetched site, before it sent codes.
_UPSTREAM_FORBIDDEN = "upstream forbidden"

_TARGET_403_ADVICE = (
    "The site refused the fetch. This is not about your API key, and retrying "
    "the same URL will not help: fetch another source."
)


def _is_target_error(status: int, code: str | None, title: str | None) -> bool:
    """True when the page being fetched failed, not the caller's request."""
    if status == 429:
        return False
    if code is not None:
        return code.startswith("target_") or code in _TARGET_CODES
    return status == 403 and (title or "").strip().lower() == _UPSTREAM_FORBIDDEN


def _str_field(body: dict[str, Any], key: str) -> str | None:
    value = body.get(key)
    return value if isinstance(value, str) and value.strip() else None


def _seconds(value: Any) -> float | None:
    """A non-negative, finite number of seconds, or None for anything else."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    seconds: float = value
    if not math.isfinite(seconds) or seconds < 0:
        return None
    return seconds


# The longest Retry-After delay reported, in seconds (a year).
_MAX_RETRY_AFTER = 365 * 24 * 60 * 60


def _retry_after_header(value: str | None) -> float | None:
    """Parse a Retry-After header: delay-seconds or an HTTP date."""
    if not value or not value.strip():
        return None
    text = value.strip()
    if text.isascii() and text.isdigit():
        # Cap at a year, as the Go SDK does; checking the length first keeps
        # int() clear of Python's integer-string length limit. Leading zeros
        # do not count: "0000000001" is one second.
        text = text.lstrip("0") or "0"
        if len(text) > len(str(_MAX_RETRY_AFTER)):
            return _MAX_RETRY_AFTER
        return min(int(text), _MAX_RETRY_AFTER)
    try:
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError):
        return None
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    delay = math.ceil((when - datetime.now(timezone.utc)).total_seconds())
    return min(max(0, delay), _MAX_RETRY_AFTER)


def _limit_info(value: Any) -> RateLimitInfo | None:
    if not isinstance(value, dict):
        return None
    max_ = value.get("max")
    return RateLimitInfo(
        scope=_str_field(value, "scope"),
        window=_str_field(value, "window"),
        max=max_ if isinstance(max_, int) and not isinstance(max_, bool) else None,
        resets_at=_str_field(value, "resets_at"),
    )


def _error_fields(
    raw: dict[str, Any] | None, response: httpx.Response
) -> dict[str, Any]:
    """The agent-ready fields of an error body, None where the API left one out.

    ``retry_after_seconds`` prefers the body, then the ``Retry-After`` header,
    then the older ``retryAfter`` body field; ``request_id`` prefers the body,
    then the ``X-Request-Id`` header.
    """
    body = raw or {}
    retryable = body.get("retryable")
    retry_after = _seconds(body.get("retry_after_seconds"))
    if retry_after is None:
        retry_after = _retry_after_header(response.headers.get("Retry-After"))
    if retry_after is None:
        retry_after = _seconds(body.get("retryAfter"))
    header_id = (response.headers.get("X-Request-Id") or "").strip() or None
    return {
        "code": _str_field(body, "code"),
        "error": _str_field(body, "error"),
        "fix": _str_field(body, "fix"),
        "docs_url": _str_field(body, "docs_url"),
        "retryable": retryable if isinstance(retryable, bool) else None,
        "retry_after_seconds": retry_after,
        "request_id": _str_field(body, "request_id") or header_id,
        "param": _str_field(body, "param"),
        "limit": _limit_info(body.get("limit")),
        "billing_url": _str_field(body, "billing_url"),
        "auto_top_up_url": _str_field(body, "auto_top_up_url"),
        "pay_per_request": _str_field(body, "pay_per_request"),
        "raw": raw,
    }


def _to_api_error(response: httpx.Response) -> KeenableAPIError:
    """Map a non-2xx response to the most specific SDK error available."""
    detail = ""
    body: dict[str, Any] | None = None
    try:
        decoded = response.json()
        if isinstance(decoded, dict):
            body = decoded
            detail = str(
                body.get("message") or body.get("error") or body.get("detail") or ""
            )
    except ValueError:
        detail = (response.text or "").strip()

    fields = _error_fields(body, response)
    status = response.status_code
    target = _is_target_error(status, fields["code"], fields["error"])
    auth = status in (401, 403) and not target and fields["code"] not in _NOT_AUTH_CODES
    if status in (401, 403) and not auth:
        label = f"Keenable API error ({status})"
    else:
        label = _STATUS_LABELS.get(status, f"Keenable API error ({status})")
    message = f"{label}: {detail}" if detail else label
    if fields["fix"]:
        # The API's next step, appended the same way in the Go and TS SDKs.
        message = f"{message}. {fields['fix']}"
    elif target and status == 403:
        message = f"{message}. {_TARGET_403_ADVICE}"

    if target:
        return KeenableTargetError(message, status, detail or None, **fields)
    if auth:
        return KeenableAuthError(message, status, detail or None, **fields)
    if status == 402:
        return KeenableInsufficientCreditsError(
            message, status, detail or None, **fields
        )
    if status == 429:
        return KeenableRateLimitError(message, status, detail or None, **fields)
    return KeenableAPIError(message, status, detail or None, **fields)


def _decode(response: httpx.Response) -> dict[str, Any]:
    """Validate the status and decode a JSON object body."""
    if not response.is_success:
        raise _to_api_error(response)
    try:
        data = response.json()
    except ValueError as exc:
        snippet = (response.text or "")[:200]
        raise KeenableAPIError(
            f"Keenable API returned a non-JSON response: {snippet!r}",
            response.status_code,
        ) from exc
    if not isinstance(data, dict):
        raise KeenableAPIError(
            f"Unexpected response from the Keenable API: {data!r}",
            response.status_code,
        )
    return data


@contextmanager
def _transport_errors() -> Iterator[None]:
    """Translate httpx transport failures into a KeenableConnectionError.

    Wrapping the ``await`` inside the ``with`` body works for the async client
    too, so both clients share one definition of "could not reach the API".
    """
    try:
        yield
    except httpx.HTTPError as exc:
        raise KeenableConnectionError(
            f"could not reach the Keenable API: {exc!r}"
        ) from exc


class _BaseClient:
    """Shared configuration for the sync and async clients."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        client_source: str = "Keenable SDK",
    ) -> None:
        key = api_key if api_key is not None else environ.get("KEENABLE_API_KEY")
        self._api_key = (key or "").strip() or None
        self._base_url = _resolve_base_url(base_url)
        self._client_source = client_source

    @property
    def keyless(self) -> bool:
        """True when no API key is configured and the public tier is in use."""
        return self._api_key is None

    def _headers(self) -> dict[str, str]:
        headers = {
            "Accept": "application/json",
            "User-Agent": f"keenable-python/{__version__}",
            # The public tier rejects requests without this header.
            "X-Keenable-Title": self._client_source,
        }
        if self._api_key is not None:
            headers["X-API-Key"] = self._api_key
        return headers

    def _url(self, endpoint: str) -> str:
        """The endpoint URL, keyless or keyed depending on the configured key."""
        suffix = "/public" if self.keyless else ""
        return f"{self._base_url}/v1/{endpoint}{suffix}"


class Keenable(_BaseClient):
    """Synchronous client for the Keenable web search API.

    Keyless by default: with no API key the client calls the public endpoints,
    which are rate limited per hour. Pass ``api_key`` (or set
    ``KEENABLE_API_KEY``) to lift that limit. Create a key at
    https://keenable.ai/console.

    Example:
        >>> from keenable import Keenable
        >>> keenable = Keenable()
        >>> results = keenable.search("cerebras inference benchmarks")
        >>> print(results.to_context())

    The client can be reused across calls and is safe to keep for the lifetime
    of your process. Use it as a context manager (or call :meth:`close`) to
    release the underlying connection pool.

    Args:
        api_key: Falls back to ``KEENABLE_API_KEY``; omit it for the free tier.
        base_url: Falls back to ``KEENABLE_API_URL``.
        timeout: Request timeout in seconds. The default, 90, outlasts the
            API's own 60-second wait on a slow fetch, so a page you are
            billed for is not abandoned.
        client_source: Name this client reports as its traffic source. Leave it
            alone unless you are building an integration on top of this SDK and
            want your own attribution.
        client: Bring your own ``httpx.Client`` (proxies, retries, transport).
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        client_source: str = "Keenable SDK",
        client: httpx.Client | None = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=timeout,
            client_source=client_source,
        )
        self._client = client or httpx.Client(timeout=timeout)
        self._owns_client = client is None

    def __enter__(self) -> Keenable:
        return self

    def __exit__(self, *exc_info: Any) -> None:
        self.close()

    def close(self) -> None:
        """Close the underlying HTTP connection pool."""
        if self._owns_client:
            self._client.close()

    def _request(
        self,
        endpoint: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Send one request and return its decoded body.

        Every transport concern lives here: endpoint selection, headers, error
        translation and decoding, so a retry or a logging hook is one edit.
        """
        headers = self._headers()
        with _transport_errors():
            if json is None:
                response = self._client.get(
                    self._url(endpoint), params=params, headers=headers
                )
            else:
                headers["Content-Type"] = "application/json"
                response = self._client.post(
                    self._url(endpoint), json=json, headers=headers
                )
        return _decode(response)

    def search(
        self,
        query: str,
        *,
        mode: Literal["pro"] | None = None,
        site: str | None = None,
        published_after: str | None = None,
        published_before: str | None = None,
        acquired_after: str | None = None,
        acquired_before: str | None = None,
        snippet_max_length: int | None = None,
        max_results: int | None = None,
        query_time: str | None = None,
    ) -> SearchResponse:
        """Search the web and return ranked results with page text.

        Args:
            query: What to look for. Describe the ideal page in natural
                language ("blog post comparing React and Vue performance")
                rather than typing keywords; the index is semantic.
            mode: Search mode, e.g. ``"pro"`` for deeper retrieval. Leave it
                unset to use your organization's default mode.
            site: Restrict results to one domain, e.g. ``"arxiv.org"``.
            published_after: Keep pages published on or after ``YYYY-MM-DD``.
            published_before: Keep pages published on or before ``YYYY-MM-DD``.
            acquired_after: Keep pages Keenable indexed on or after
                ``YYYY-MM-DD``. Use this for "what is new since ..." queries,
                where the publication date is unreliable or missing.
            acquired_before: Keep pages indexed on or before ``YYYY-MM-DD``.
            snippet_max_length: Cap the characters of page text per result.
            max_results: How many results to return, 1 to 50. The API
                default is 10.
            query_time: Search the index as it stood at this moment; pages
                newer than it are excluded. It sets no lower bound, so it is
                not a recency filter: use ``published_after`` for that.
                Accepts an ISO 8601 datetime, ``YYYY-MM-DD``, or an offset
                back from now such as ``"7d"`` (as of 7 days ago).

        Returns:
            A :class:`SearchResponse`; iterate it for results or call
            :meth:`SearchResponse.to_context` to build a prompt block.
        """
        payload = _search_payload(
            query,
            mode,
            site=site,
            published_after=published_after,
            published_before=published_before,
            acquired_after=acquired_after,
            acquired_before=acquired_before,
            snippet_max_length=snippet_max_length,
            max_results=max_results,
            query_time=query_time,
        )
        return SearchResponse._from_json(self._request(_SEARCH, json=payload), query)

    def fetch(self, url: str) -> Page:
        """Fetch one URL and return its main content as markdown.

        Use this after :meth:`search` when a snippet is not enough and the
        model needs the full page.
        """
        _reject_private_fetch_target(url)
        return Page._from_json(self._request(_FETCH, params={"url": url}), url)


class AsyncKeenable(_BaseClient):
    """Asynchronous client for the Keenable web search API.

    Mirrors :class:`Keenable` with awaitable methods.

    Example:
        >>> import asyncio
        >>> from keenable import AsyncKeenable
        >>> async def main():
        ...     async with AsyncKeenable() as keenable:
        ...         results = await keenable.search("wafer scale engine")
        ...         print(results.to_context())
        >>> asyncio.run(main())
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        client_source: str = "Keenable SDK",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=timeout,
            client_source=client_source,
        )
        self._client = client or httpx.AsyncClient(timeout=timeout)
        self._owns_client = client is None

    async def __aenter__(self) -> AsyncKeenable:
        return self

    async def __aexit__(self, *exc_info: Any) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        """Close the underlying HTTP connection pool."""
        if self._owns_client:
            await self._client.aclose()

    async def _request(
        self,
        endpoint: str,
        *,
        json: dict[str, Any] | None = None,
        params: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Async counterpart of :meth:`Keenable._request`."""
        headers = self._headers()
        with _transport_errors():
            if json is None:
                response = await self._client.get(
                    self._url(endpoint), params=params, headers=headers
                )
            else:
                headers["Content-Type"] = "application/json"
                response = await self._client.post(
                    self._url(endpoint), json=json, headers=headers
                )
        return _decode(response)

    async def search(
        self,
        query: str,
        *,
        mode: Literal["pro"] | None = None,
        site: str | None = None,
        published_after: str | None = None,
        published_before: str | None = None,
        acquired_after: str | None = None,
        acquired_before: str | None = None,
        snippet_max_length: int | None = None,
        max_results: int | None = None,
        query_time: str | None = None,
    ) -> SearchResponse:
        """Search the web. See :meth:`Keenable.search` for the arguments."""
        payload = _search_payload(
            query,
            mode,
            site=site,
            published_after=published_after,
            published_before=published_before,
            acquired_after=acquired_after,
            acquired_before=acquired_before,
            snippet_max_length=snippet_max_length,
            max_results=max_results,
            query_time=query_time,
        )
        body = await self._request(_SEARCH, json=payload)
        return SearchResponse._from_json(body, query)

    async def fetch(self, url: str) -> Page:
        """Fetch one URL as markdown. See :meth:`Keenable.fetch`."""
        _reject_private_fetch_target(url)
        body = await self._request(_FETCH, params={"url": url})
        return Page._from_json(body, url)
