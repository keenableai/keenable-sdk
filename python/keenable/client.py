"""Sync and async clients for the Keenable API."""

from __future__ import annotations

import asyncio
import enum
import ipaddress
import math
import random
import time
from collections.abc import Iterator, Mapping
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
    KeenableError,
    KeenableInsufficientCreditsError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
    KeenableTimeoutError,
    RateLimitInfo,
)
from .models import Page, SearchResponse

__all__ = ["Keenable", "AsyncKeenable", "DEFAULT_MAX_RETRIES"]

DEFAULT_BASE_URL = "https://api.keenable.ai"
DEFAULT_TIMEOUT = 30.0
DEFAULT_MAX_RETRIES = 2

# Retry timing, the same in the TypeScript and Go SDKs.
_INITIAL_RETRY_DELAY = 0.5
_MAX_RETRY_DELAY = 8.0
# A server-requested wait longer than this (seconds) is not waited out.
_MAX_RETRY_AFTER_WAIT = 60.0

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

    payload: dict[str, Any] = {"query": query, "mode": mode or "pro"}
    payload.update(
        {name: value for name, value in filters.items() if value is not None}
    )
    return payload


# Codes about the page being fetched rather than about Keenable or the caller,
# besides every ``target_*`` code. Servers before error format v1 send no
# ``type``, so it is derived from these and the status.
_TARGET_CODES = frozenset({"page_not_found", "content_not_extracted"})


def _derive_type(status: int, code: str | None) -> str:
    """The error ``type`` for a response that did not send one.

    Matches the API's catalog for every code it had when ``type`` was added.
    """
    if code and (code.startswith("target_") or code in _TARGET_CODES):
        return "target_error"
    if status == 401:
        return "authentication_error"
    if status == 403:
        return "permission_error"
    if status in (402, 451):
        return "billing_error"
    if status == 429:
        return "rate_limit_error"
    if 400 <= status < 500:
        return "invalid_request_error"
    return "api_error"


def _str_field(body: dict[str, Any], key: str) -> str | None:
    value = body.get(key)
    return value if isinstance(value, str) and value.strip() else None


# The longest Retry-After delay reported, in seconds (a year).
_MAX_RETRY_AFTER = 365 * 24 * 60 * 60


def _seconds(value: Any) -> float | None:
    """A non-negative, finite number of seconds capped at a year, else None.

    An integer too large for a float is treated like the non-finite number
    the Go and TypeScript SDKs see for it, and dropped, so the next source of
    the delay is used; ``math.isfinite`` would raise OverflowError on it.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        seconds = float(value)
    except OverflowError:
        return None
    if not math.isfinite(seconds) or seconds < 0:
        return None
    if seconds > _MAX_RETRY_AFTER:
        return _MAX_RETRY_AFTER
    # The value itself, so an integer delay stays an int.
    exact: float = value
    return exact


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
    except (TypeError, ValueError, IndexError, OverflowError):
        # OverflowError: a year too large for a C long.
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
    then the ``X-Request-Id`` header; ``type`` is derived from the status and
    code when the API did not send it.
    """
    body = raw or {}
    retryable = body.get("retryable")
    retry_after = _seconds(body.get("retry_after_seconds"))
    if retry_after is None:
        retry_after = _retry_after_header(response.headers.get("Retry-After"))
    if retry_after is None:
        retry_after = _seconds(body.get("retryAfter"))
    header_id = (response.headers.get("X-Request-Id") or "").strip() or None
    code = _str_field(body, "code")
    return {
        "code": code,
        "type": _str_field(body, "type") or _derive_type(response.status_code, code),
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


def _sentence(message: str, more: str) -> str:
    """Append ``more`` as a new sentence, without doubling a final period."""
    return f"{message}{' ' if message.endswith('.') else '. '}{more}"


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
    # A 401/403 about the page being fetched is not an authentication failure.
    auth = status in (401, 403) and fields["type"] != "target_error"
    if status in (401, 403) and not auth:
        label = f"Keenable API error ({status})"
    else:
        label = _STATUS_LABELS.get(status, f"Keenable API error ({status})")
    message = f"{label}: {detail}" if detail else label
    if fields["fix"]:
        # The API's next step, appended the same way in the Go and TS SDKs.
        message = _sentence(message, fields["fix"])
    # Where to read more and what to quote, as Stripe's SDKs print them; the
    # same tail as the Go and TS SDKs. The code goes in its own parentheses so
    # the "(request_id: ...)" Go has shipped reads the same everywhere.
    if fields["docs_url"]:
        message = _sentence(message, f"Docs: {fields['docs_url']}")
    if fields["code"]:
        message = f"{message} (code: {fields['code']})"
    if fields["request_id"]:
        message = f"{message} (request_id: {fields['request_id']})"

    if auth:
        return KeenableAuthError(message, status, detail or None, **fields)
    if status == 402:
        return KeenableInsufficientCreditsError(
            message, status, detail or None, **fields
        )
    if status == 429:
        return KeenableRateLimitError(message, status, detail or None, **fields)
    return KeenableAPIError(message, status, detail or None, **fields)


class _RedirectError(KeenableConnectionError):
    """A redirect this SDK refused to follow; retrying would refuse it again."""


def _decode(response: httpx.Response) -> tuple[dict[str, Any], str | None]:
    """Validate the status and decode a JSON object body, with the request id."""
    if response.is_redirect or 300 <= response.status_code < 400:
        location = response.headers.get("Location")
        where = f" to {location}" if location else ""
        raise _RedirectError(
            f"the Keenable API redirected{where}. The redirect was not followed, "
            "so the API key was not sent. Check KEENABLE_API_URL."
        )
    if not response.is_success:
        raise _to_api_error(response)
    request_id = (response.headers.get("X-Request-Id") or "").strip() or None
    try:
        data = response.json()
    except ValueError as exc:
        snippet = (response.text or "")[:200]
        raise KeenableAPIError(
            f"Keenable API returned a non-JSON response: {snippet!r}",
            response.status_code,
            request_id=request_id,
        ) from exc
    if not isinstance(data, dict):
        raise KeenableAPIError(
            f"Unexpected response from the Keenable API: {data!r}",
            response.status_code,
            request_id=request_id,
        )
    return data, request_id


@contextmanager
def _transport_errors(timeout: Any) -> Iterator[None]:
    """Translate httpx transport failures into a KeenableConnectionError.

    Wrapping the ``await`` inside the ``with`` body works for the async client
    too, so both clients share one definition of "could not reach the API".
    """
    try:
        yield
    except httpx.TimeoutException as exc:
        within = f" within {timeout} s" if isinstance(timeout, (int, float)) else ""
        raise KeenableTimeoutError(
            f"the Keenable API did not respond{within}: {exc!r}"
        ) from exc
    except httpx.HTTPError as exc:
        raise KeenableConnectionError(
            f"could not reach the Keenable API: {exc!r}"
        ) from exc


def _backoff(retry: int, jitter: float | None = None) -> float:
    """The exponential backoff in seconds before retry number ``retry`` (0 first).

    0.5 s doubling up to 8 s, shortened by up to 25% of jitter so clients that
    failed together do not retry together. Kept in step with TS and Go.
    """
    base = min(_INITIAL_RETRY_DELAY * 2.0**retry, _MAX_RETRY_DELAY)
    return base * (1 - 0.25 * (random.random() if jitter is None else jitter))


def _retry_delay(error: Exception, retry: int) -> float | None:
    """Seconds to wait before retrying after ``error``, or None not to retry.

    The API's ``retryable`` decides when it sent one; otherwise 408, 429 and
    5xx are retried, and so are network failures and timeouts. A
    ``Retry-After`` over a minute is not waited out.
    """
    if isinstance(error, KeenableAPIError):
        status = error.status_code
        retryable = error.retryable
        if retryable is None:
            retryable = status in (408, 429) or status >= 500
        if not retryable:
            return None
        if error.retry_after_seconds is not None:
            wait = float(error.retry_after_seconds)
            return wait if wait <= _MAX_RETRY_AFTER_WAIT else None
        return _backoff(retry)
    if isinstance(error, _RedirectError):
        return None
    if isinstance(error, KeenableConnectionError):
        return _backoff(retry)
    return None


def _check_max_retries(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise KeenableInvalidRequestError(
            f"max_retries must be a non-negative integer, got {value!r}"
        )
    return value


class _Unset(enum.Enum):
    """Marks a ``timeout`` the caller did not pass, as distinct from ``None``."""

    TOKEN = 0


_UNSET = _Unset.TOKEN


def _check_client_timeout(value: Any) -> Any:
    """Validate a timeout: ``None`` (no deadline) and ``httpx.Timeout`` pass."""
    if value is None or isinstance(value, httpx.Timeout):
        return value
    return _check_timeout(value)


def _check_timeout(value: float) -> float:
    if (
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not math.isfinite(value)
        or value <= 0
    ):
        raise KeenableInvalidRequestError(
            f"timeout must be a positive number of seconds, got {value!r}"
        )
    return value


class _BaseClient:
    """Shared configuration for the sync and async clients."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float | httpx.Timeout | None = DEFAULT_TIMEOUT,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        client_source: str = "Keenable SDK",
    ) -> None:
        key = api_key if api_key is not None else environ.get("KEENABLE_API_KEY")
        self._api_key = (key or "").strip() or None
        self._base_url = _resolve_base_url(base_url)
        self._client_source = client_source
        self._timeout: Any = _check_client_timeout(timeout)
        self._max_retries = _check_max_retries(max_retries)
        self._default_headers = dict(default_headers or {})

    @property
    def keyless(self) -> bool:
        """True when no API key is configured and the public tier is in use."""
        return self._api_key is None

    def _headers(
        self, extra: Mapping[str, str] | None = None, *, json: bool = False
    ) -> httpx.Headers:
        """The SDK's headers, then ``default_headers``, then the call's.

        The API key is always the configured one, so a stray header cannot
        send a different key or turn a keyless call keyed.
        """
        headers = httpx.Headers(
            {
                "Accept": "application/json",
                "User-Agent": f"keenable-python/{__version__}",
                # The public tier rejects requests without this header.
                "X-Keenable-Title": self._client_source,
            }
        )
        for source in (self._default_headers, extra or {}):
            for name, value in source.items():
                if name.lower() != "x-api-key":
                    headers[name] = value
        if self._api_key is not None:
            headers["X-API-Key"] = self._api_key
        if json:
            headers["Content-Type"] = "application/json"
        return headers

    def _url(self, endpoint: str) -> str:
        """The endpoint URL, keyless or keyed depending on the configured key."""
        suffix = "/public" if self.keyless else ""
        return f"{self._base_url}/v1/{endpoint}{suffix}"

    def _call_settings(
        self, timeout: float | httpx.Timeout | None, max_retries: int | None
    ) -> tuple[Any, int]:
        """The per-call timeout (or the client's) and retry budget."""
        call_timeout: Any = (
            _check_client_timeout(timeout)
            if timeout is not None
            else self._call_default_timeout()
        )
        retries = (
            _check_max_retries(max_retries)
            if max_retries is not None
            else self._max_retries
        )
        return call_timeout, retries

    def _call_default_timeout(self) -> Any:
        return self._timeout


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
        timeout: Deadline in seconds for each attempt, or an
            ``httpx.Timeout``; ``None`` means no deadline. With your own
            ``client``, that client's timeout applies unless you pass this.
        max_retries: How many times to retry a failed request (default 2,
            ``0`` turns retries off). Connection errors, timeouts, 408, 429
            and 5xx are retried, unless the API says the error is not
            retryable. The wait is the API's ``Retry-After`` when it sent one,
            else exponential backoff from 0.5 s to 8 s with jitter. A
            ``Retry-After`` over 60 s (such as the keyless hourly cap) is not
            waited out: the error is raised at once.
        default_headers: Headers sent with every request.
        client_source: Name this client reports as its traffic source. Leave it
            alone unless you are building an integration on top of this SDK and
            want your own attribution.
        client: Bring your own ``httpx.Client`` (proxies, transport).
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float | httpx.Timeout | None | _Unset = _UNSET,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        client_source: str = "Keenable SDK",
        client: httpx.Client | None = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=DEFAULT_TIMEOUT if isinstance(timeout, _Unset) else timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            client_source=client_source,
        )
        # A client you pass keeps its own timeout unless you set one here.
        self._use_client_timeout = client is not None and isinstance(timeout, _Unset)
        self._client = client or httpx.Client(timeout=self._timeout)
        self._owns_client = client is None

    def _call_default_timeout(self) -> Any:
        return httpx.USE_CLIENT_DEFAULT if self._use_client_timeout else self._timeout

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
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], str | None]:
        """Send a request, retrying what can be retried, and decode the body.

        Every transport concern lives here: endpoint selection, headers,
        timeout, retries, error translation and decoding.
        """
        call_timeout, retries = self._call_settings(timeout, max_retries)
        headers = self._headers(extra_headers, json=json is not None)
        retry = 0
        while True:
            try:
                with _transport_errors(call_timeout):
                    response = self._client.request(
                        "GET" if json is None else "POST",
                        self._url(endpoint),
                        params=params,
                        json=json,
                        headers=headers,
                        timeout=call_timeout,
                        # Never follow: httpx would carry X-API-Key to the
                        # host a redirect names.
                        follow_redirects=False,
                    )
                return _decode(response)
            except KeenableError as error:
                delay = _retry_delay(error, retry) if retry < retries else None
                if delay is None:
                    raise
                time.sleep(delay)
                retry += 1

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
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> SearchResponse:
        """Search the web and return ranked results with page text.

        Args:
            query: What to look for. Describe the ideal page in natural
                language ("blog post comparing React and Vue performance")
                rather than typing keywords; the index is semantic.
            mode: Search mode. ``"pro"`` (the default) does deeper retrieval.
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
            timeout: Deadline in seconds for each attempt of this call.
            max_retries: Retry budget for this call; ``0`` turns retries off.
            extra_headers: Headers for this call, over ``default_headers``.

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
        body, request_id = self._request(
            _SEARCH,
            json=payload,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        return SearchResponse._from_json(body, query, request_id)

    def fetch(
        self,
        url: str,
        *,
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Page:
        """Fetch one URL and return its main content as markdown.

        Use this after :meth:`search` when a snippet is not enough and the
        model needs the full page. ``timeout``, ``max_retries`` and
        ``extra_headers`` apply to this call only, as in :meth:`search`.
        """
        _reject_private_fetch_target(url)
        body, request_id = self._request(
            _FETCH,
            params={"url": url},
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        return Page._from_json(body, url, request_id)


class AsyncKeenable(_BaseClient):
    """Asynchronous client for the Keenable web search API.

    Mirrors :class:`Keenable` with awaitable methods and the same arguments.

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
        timeout: float | httpx.Timeout | None | _Unset = _UNSET,
        max_retries: int = DEFAULT_MAX_RETRIES,
        default_headers: Mapping[str, str] | None = None,
        client_source: str = "Keenable SDK",
        client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(
            api_key,
            base_url=base_url,
            timeout=DEFAULT_TIMEOUT if isinstance(timeout, _Unset) else timeout,
            max_retries=max_retries,
            default_headers=default_headers,
            client_source=client_source,
        )
        self._use_client_timeout = client is not None and isinstance(timeout, _Unset)
        self._client = client or httpx.AsyncClient(timeout=self._timeout)
        self._owns_client = client is None

    def _call_default_timeout(self) -> Any:
        return httpx.USE_CLIENT_DEFAULT if self._use_client_timeout else self._timeout

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
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> tuple[dict[str, Any], str | None]:
        """Async counterpart of :meth:`Keenable._request`."""
        call_timeout, retries = self._call_settings(timeout, max_retries)
        headers = self._headers(extra_headers, json=json is not None)
        retry = 0
        while True:
            try:
                with _transport_errors(call_timeout):
                    response = await self._client.request(
                        "GET" if json is None else "POST",
                        self._url(endpoint),
                        params=params,
                        json=json,
                        headers=headers,
                        timeout=call_timeout,
                        follow_redirects=False,
                    )
                return _decode(response)
            except KeenableError as error:
                delay = _retry_delay(error, retry) if retry < retries else None
                if delay is None:
                    raise
                await asyncio.sleep(delay)
                retry += 1

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
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
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
        body, request_id = await self._request(
            _SEARCH,
            json=payload,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        return SearchResponse._from_json(body, query, request_id)

    async def fetch(
        self,
        url: str,
        *,
        timeout: float | httpx.Timeout | None = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Page:
        """Fetch one URL as markdown. See :meth:`Keenable.fetch`."""
        _reject_private_fetch_target(url)
        body, request_id = await self._request(
            _FETCH,
            params={"url": url},
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )
        return Page._from_json(body, url, request_id)
