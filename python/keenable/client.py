"""Sync and async clients for the Keenable API."""

from __future__ import annotations

import ipaddress
from collections.abc import Iterator
from contextlib import contextmanager
from os import environ
from typing import Any, Literal, NamedTuple, Union
from urllib.parse import urlsplit

import httpx

from ._version import __version__
from .errors import (
    KeenableAPIError,
    KeenableAuthError,
    KeenableConnectionError,
    KeenableCreditsError,
    KeenableForbiddenError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
    KeenableValidationError,
)
from .models import Page, SearchResponse

__all__ = ["Keenable", "AsyncKeenable", "Mode"]

DEFAULT_BASE_URL = "https://api.keenable.ai"
DEFAULT_TIMEOUT = 30.0

# Endpoints are named once; the keyless variant of each is the same path with a
# `/public` suffix, so a new endpoint is one name rather than two constants.
_SEARCH = "search"
_FETCH = "fetch"

Mode = Union[Literal["pro", "realtime"], str]
"""``"pro"`` (default) or ``"realtime"``. Other strings are passed through, so a
mode the API adds later works before this SDK names it."""

_BLOCKED_HOSTS = frozenset({"localhost", "metadata.google.internal"})
_LOCAL_HOSTS = frozenset({"localhost", "127.0.0.1", "::1"})

_STATUS_LABELS = {
    400: "Keenable rejected the request (400)",
    401: "Keenable authentication failed (401)",
    402: "Keenable: insufficient credits (402)",
    403: "Keenable: forbidden (403)",
    422: "Keenable rejected the request (422)",
    429: "Keenable rate limit exceeded (429)",
}

_CONSOLE_URL = "https://keenable.ai/console"


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


class _Reply(NamedTuple):
    """A decoded response body and the request id the API assigned to it."""

    data: dict[str, Any]
    request_id: str | None


def _header_int(response: httpx.Response, name: str) -> int | None:
    try:
        return int(response.headers.get(name, ""))
    except ValueError:
        return None


def _hint(status: int, keyless: bool, reset: str | None) -> str:
    """The one next step that ends an API error message."""
    if status in (400, 422):
        return (
            "Fix the request (the message says what was rejected); "
            "retrying unchanged fails the same way."
        )
    if status == 401:
        return (
            "Check KEENABLE_API_KEY or the api_key you passed; "
            "unset both to use the keyless tier."
        )
    if status == 402:
        return (
            f"Add credits at {_CONSOLE_URL}; retrying before that fails the same way."
        )
    if status == 403:
        if keyless:
            return (
                "This needs an API key: set KEENABLE_API_KEY "
                f"(create one at {_CONSOLE_URL})."
            )
        return f"Your plan does not include this; check it at {_CONSOLE_URL}."
    if status == 429:
        when = (
            f"Retry after {reset}"
            if reset
            else "Retry after the rate limit window resets"
        )
        if keyless:
            return f"{when}, or set KEENABLE_API_KEY to lift the keyless hourly cap."
        return f"{when}."
    if status == 404:
        return "Check the URL; retrying unchanged fails the same way."
    if status >= 500:
        return "Retry the request; search and fetch are safe to repeat."
    return "If it keeps failing, confirm KEENABLE_API_URL."


def _fetch_params(
    url: str,
    max_chars: int | None,
    live: bool | None,
    prompt: str | None,
    session_id: str | None,
) -> dict[str, Any]:
    """Build the fetch query string, dropping options the caller left unset.

    Ranges are the API's to enforce; a bad value comes back as a
    :class:`KeenableValidationError` naming the parameter.
    """
    _reject_private_fetch_target(url)
    if max_chars is not None and (
        isinstance(max_chars, bool) or not isinstance(max_chars, int)
    ):
        raise KeenableInvalidRequestError(
            f"max_chars must be an integer, got {max_chars!r}"
        )
    params: dict[str, Any] = {"url": url}
    if max_chars is not None:
        params["max_chars"] = max_chars
    if live is not None:
        params["live"] = "true" if live else "false"
    if prompt:
        params["prompt"] = prompt
    if session_id:
        params["session_id"] = session_id
    return params


def _to_api_error(response: httpx.Response, keyless: bool) -> KeenableAPIError:
    """Map a non-2xx response to the most specific SDK error available."""
    detail = ""
    api_error: str | None = None
    details: Any = None
    try:
        body = response.json()
        if isinstance(body, dict):
            detail = str(
                body.get("message") or body.get("error") or body.get("detail") or ""
            )
            api_error = _str_or_none(body.get("error"))
            details = body.get("details")
    except ValueError:
        detail = (response.text or "").strip()

    status = response.status_code
    request_id = response.headers.get("X-Request-Id") or None
    reset = response.headers.get("X-RateLimit-Reset") or None
    label = _STATUS_LABELS.get(status, f"Keenable API error ({status})")
    hint = _hint(status, keyless, reset)

    # The API's messages often end in a period; drop one so the ". <hint>"
    # below doesn't produce "..".
    shown = detail[:-1] if detail.endswith(".") else detail
    message = f"{label}: {shown}" if detail else label
    if request_id:
        message += f" (request_id: {request_id})"
    message += f". {hint}"

    fields: dict[str, Any] = {
        "api_error": api_error,
        "details": details,
        "request_id": request_id,
        "hint": hint,
    }
    body_text = detail or None
    if status in (400, 422):
        return KeenableValidationError(message, status, body_text, **fields)
    if status == 401:
        return KeenableAuthError(message, status, body_text, **fields)
    if status == 402:
        return KeenableCreditsError(message, status, body_text, **fields)
    if status == 403:
        return KeenableForbiddenError(message, status, body_text, **fields)
    if status == 429:
        return KeenableRateLimitError(
            message,
            status,
            body_text,
            limit=_header_int(response, "X-RateLimit-Limit"),
            remaining=_header_int(response, "X-RateLimit-Remaining"),
            reset=reset,
            **fields,
        )
    return KeenableAPIError(message, status, body_text, **fields)


def _str_or_none(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _decode(response: httpx.Response, keyless: bool) -> _Reply:
    """Validate the status and decode a JSON object body."""
    if not response.is_success:
        raise _to_api_error(response, keyless)
    request_id = response.headers.get("X-Request-Id") or None
    retry = "Retry the request; if it keeps failing, confirm KEENABLE_API_URL."
    rid = f" (request_id: {request_id})" if request_id else ""
    try:
        data = response.json()
    except ValueError as exc:
        snippet = (response.text or "")[:200]
        raise KeenableAPIError(
            f"Keenable API returned a non-JSON response: {snippet!r}{rid}. {retry}",
            response.status_code,
            request_id=request_id,
            hint=retry,
        ) from exc
    if not isinstance(data, dict):
        raise KeenableAPIError(
            f"Unexpected response from the Keenable API: {data!r}{rid}. {retry}",
            response.status_code,
            request_id=request_id,
            hint=retry,
        )
    return _Reply(data, request_id)


@contextmanager
def _transport_errors(timeout: float | None) -> Iterator[None]:
    """Translate httpx transport failures into a KeenableConnectionError.

    Wrapping the ``await`` inside the ``with`` body works for the async client
    too, so both clients share one definition of "could not reach the API".
    """
    try:
        yield
    except httpx.TimeoutException as exc:
        # ``timeout`` is None when the caller passed their own httpx client:
        # its own timeout applies then, and ``timeout=`` would change nothing.
        if timeout is None:
            raise KeenableConnectionError(
                f"the Keenable API did not respond before the deadline of the "
                f"httpx client you passed ({exc!r}). Retrying is safe; raise "
                "that client's timeout if it keeps happening."
            ) from exc
        raise KeenableConnectionError(
            f"the Keenable API did not respond within {timeout:g}s ({exc!r}). "
            "Retrying is safe; raise timeout= if it keeps happening."
        ) from exc
    except httpx.HTTPError as exc:
        raise KeenableConnectionError(
            f"could not reach the Keenable API: {exc!r}. "
            "Retrying is safe; check your network and KEENABLE_API_URL."
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
        self._timeout = timeout

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
        timeout: Request timeout in seconds.
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
    ) -> _Reply:
        """Send one request and return its decoded body.

        Every transport concern lives here: endpoint selection, headers, error
        translation and decoding, so a retry or a logging hook is one edit.
        """
        headers = self._headers()
        with _transport_errors(self._timeout if self._owns_client else None):
            if json is None:
                response = self._client.get(
                    self._url(endpoint), params=params, headers=headers
                )
            else:
                headers["Content-Type"] = "application/json"
                response = self._client.post(
                    self._url(endpoint), json=json, headers=headers
                )
        return _decode(response, self.keyless)

    def search(
        self,
        query: str,
        *,
        mode: Mode | None = None,
        site: str | None = None,
        published_after: str | None = None,
        published_before: str | None = None,
        acquired_after: str | None = None,
        acquired_before: str | None = None,
        snippet_max_length: int | None = None,
        max_results: int | None = None,
        query_time: str | None = None,
        enable_wizards: bool | None = None,
        session_id: str | None = None,
    ) -> SearchResponse:
        """Search the web and return ranked results with page text.

        Args:
            query: What to look for. Describe the ideal page in natural
                language ("blog post comparing React and Vue performance")
                rather than typing keywords; the index is semantic.
            mode: ``"pro"`` (the default) does deeper retrieval;
                ``"realtime"`` is the fastest, for latency-sensitive calls.
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
            enable_wizards: Experimental structured-data extraction. Only valid
                in ``"pro"`` mode, and not under a zero data retention policy.
            session_id: An id for the agent session making this call. Send the
                same value on every call in one session so its requests can be
                grouped.

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
            enable_wizards=enable_wizards,
            session_id=session_id,
        )
        reply = self._request(_SEARCH, json=payload)
        return SearchResponse._from_json(reply.data, query, reply.request_id)

    def fetch(
        self,
        url: str,
        *,
        max_chars: int | None = None,
        live: bool | None = None,
        prompt: str | None = None,
        session_id: str | None = None,
    ) -> Page:
        """Fetch one URL and return its main content as markdown.

        Use this after :meth:`search` when a snippet is not enough and the
        model needs the full page.

        Args:
            url: The page to read.
            max_chars: Cap the content at this many characters (the API
                default is 50,000). A cut page ends with a short note saying
                it was truncated.
            live: Fetch from the source when the page is not in the index.
                Without it, an unindexed URL fails.
            prompt: Instead of the full page, return the answer to this
                instruction, extracted from the page by a model.
            session_id: Same as on :meth:`search`.
        """
        params = _fetch_params(url, max_chars, live, prompt, session_id)
        reply = self._request(_FETCH, params=params)
        return Page._from_json(reply.data, url, reply.request_id)


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
    ) -> _Reply:
        """Async counterpart of :meth:`Keenable._request`."""
        headers = self._headers()
        with _transport_errors(self._timeout if self._owns_client else None):
            if json is None:
                response = await self._client.get(
                    self._url(endpoint), params=params, headers=headers
                )
            else:
                headers["Content-Type"] = "application/json"
                response = await self._client.post(
                    self._url(endpoint), json=json, headers=headers
                )
        return _decode(response, self.keyless)

    async def search(
        self,
        query: str,
        *,
        mode: Mode | None = None,
        site: str | None = None,
        published_after: str | None = None,
        published_before: str | None = None,
        acquired_after: str | None = None,
        acquired_before: str | None = None,
        snippet_max_length: int | None = None,
        max_results: int | None = None,
        query_time: str | None = None,
        enable_wizards: bool | None = None,
        session_id: str | None = None,
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
            enable_wizards=enable_wizards,
            session_id=session_id,
        )
        reply = await self._request(_SEARCH, json=payload)
        return SearchResponse._from_json(reply.data, query, reply.request_id)

    async def fetch(
        self,
        url: str,
        *,
        max_chars: int | None = None,
        live: bool | None = None,
        prompt: str | None = None,
        session_id: str | None = None,
    ) -> Page:
        """Fetch one URL as markdown. See :meth:`Keenable.fetch`."""
        params = _fetch_params(url, max_chars, live, prompt, session_id)
        reply = await self._request(_FETCH, params=params)
        return Page._from_json(reply.data, url, reply.request_id)
