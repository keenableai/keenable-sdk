"""Sync and async clients for the Keenable API."""

from __future__ import annotations

import ipaddress
import os
from typing import Any
from urllib.parse import urlsplit

import httpx

from .errors import (
    KeenableAPIError,
    KeenableAuthError,
    KeenableConnectionError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
)
from .models import Page, SearchResponse

__all__ = ["Keenable", "AsyncKeenable"]

try:  # pragma: no cover - trivial
    from importlib import metadata

    _VERSION = metadata.version("keenable")
except Exception:  # pragma: no cover - source checkouts
    _VERSION = "unknown"

DEFAULT_BASE_URL = "https://api.keenable.ai"
DEFAULT_TIMEOUT = 30.0

# Keyless endpoints. A key is not a prerequisite for any call: it only lifts
# the hourly rate limit, so the client picks the endpoint by key presence.
_SEARCH_PUBLIC = "/v1/search/public"
_SEARCH_KEYED = "/v1/search"
_FETCH_PUBLIC = "/v1/fetch/public"
_FETCH_KEYED = "/v1/fetch"


def _resolve_base_url(base_url: str | None) -> str:
    """Resolve and validate the API base URL, enforcing HTTPS off-localhost."""
    base = (base_url or os.environ.get("KEENABLE_API_URL") or DEFAULT_BASE_URL).rstrip(
        "/"
    )
    parsed = urlsplit(base)
    if parsed.hostname:
        if parsed.scheme == "https":
            return base
        if parsed.scheme == "http" and parsed.hostname in {
            "localhost",
            "127.0.0.1",
            "::1",
        }:
            return base
    raise KeenableInvalidRequestError(
        f"base_url must be an https:// URL with a host, got {base!r}"
    )


def _reject_private_fetch_target(url: str) -> None:
    """Refuse obviously internal fetch targets before a request leaves the host.

    The backend enforces this too, but stopping here keeps an internal hostname
    out of an outbound request in the first place.
    """
    if not url.lower().startswith(("http://", "https://")):
        raise KeenableInvalidRequestError(f"fetch() needs an http(s) URL, got {url!r}")

    host = (urlsplit(url).hostname or "").strip().lower()
    if not host:
        raise KeenableInvalidRequestError(f"fetch() URL has no host: {url!r}")
    if host in {"localhost", "metadata.google.internal"}:
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


def _search_payload(
    query: str,
    mode: str | None,
    site: str | None,
    published_after: str | None,
    published_before: str | None,
    acquired_after: str | None,
    acquired_before: str | None,
    snippet_max_length: int | None,
) -> dict[str, Any]:
    if not query or not query.strip():
        raise KeenableInvalidRequestError("search() needs a non-empty query")

    payload: dict[str, Any] = {"query": query, "mode": mode or "pro"}
    optional = (
        ("site", site),
        ("published_after", published_after),
        ("published_before", published_before),
        ("acquired_after", acquired_after),
        ("acquired_before", acquired_before),
        ("snippet_max_length", snippet_max_length),
    )
    for name, value in optional:
        if value is not None:
            payload[name] = value
    return payload


def _raise_for_status(response: httpx.Response) -> None:
    """Turn a non-2xx response into the most specific SDK error available."""
    if response.is_success:
        return

    detail = ""
    try:
        body = response.json()
        if isinstance(body, dict):
            detail = str(
                body.get("message") or body.get("error") or body.get("detail") or ""
            )
    except ValueError:
        detail = (response.text or "").strip()

    status = response.status_code
    label = {
        401: "Keenable authentication failed (401)",
        403: "Keenable authentication failed (403)",
        402: "Keenable: insufficient credits (402)",
        429: "Keenable rate limit exceeded (429)",
    }.get(status, f"Keenable API error ({status})")
    message = f"{label}: {detail}" if detail else label

    if status in (401, 403):
        raise KeenableAuthError(message, status, detail or None)
    if status == 429:
        raise KeenableRateLimitError(message, status, detail or None)
    raise KeenableAPIError(message, status, detail or None)


def _decode(response: httpx.Response) -> dict[str, Any]:
    _raise_for_status(response)
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


class _BaseClient:
    """Shared configuration for the sync and async clients."""

    _sdk_flavor = "python"

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        key = api_key if api_key is not None else os.environ.get("KEENABLE_API_KEY")
        self._api_key = (key or "").strip() or None
        self._base_url = _resolve_base_url(base_url)
        self._timeout = timeout

    @property
    def keyless(self) -> bool:
        """True when no API key is configured and the public tier is in use."""
        return self._api_key is None

    def _headers(self) -> dict[str, str]:
        headers = {
            "User-Agent": f"keenable-{self._sdk_flavor}/{_VERSION}",
            "X-Keenable-Title": "Keenable SDK (Python)",
        }
        if self._api_key is not None:
            headers["X-API-Key"] = self._api_key
        return headers

    def _search_url(self) -> str:
        path = _SEARCH_PUBLIC if self._api_key is None else _SEARCH_KEYED
        return f"{self._base_url}{path}"

    def _fetch_url(self) -> str:
        path = _FETCH_PUBLIC if self._api_key is None else _FETCH_KEYED
        return f"{self._base_url}{path}"


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
    """

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        client: httpx.Client | None = None,
    ) -> None:
        super().__init__(api_key, base_url=base_url, timeout=timeout)
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

    def search(
        self,
        query: str,
        *,
        mode: str | None = None,
        site: str | None = None,
        published_after: str | None = None,
        published_before: str | None = None,
        acquired_after: str | None = None,
        acquired_before: str | None = None,
        snippet_max_length: int | None = None,
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

        Returns:
            A :class:`SearchResponse`; iterate it for results or call
            :meth:`SearchResponse.to_context` to build a prompt block.
        """
        payload = _search_payload(
            query,
            mode,
            site,
            published_after,
            published_before,
            acquired_after,
            acquired_before,
            snippet_max_length,
        )
        try:
            response = self._client.post(
                self._search_url(), json=payload, headers=self._headers()
            )
        except httpx.HTTPError as exc:
            raise KeenableConnectionError(
                f"could not reach the Keenable API: {exc!r}"
            ) from exc
        return SearchResponse._from_json(_decode(response), query)

    def fetch(self, url: str) -> Page:
        """Fetch one URL and return its main content as markdown.

        Use this after :meth:`search` when a snippet is not enough and the
        model needs the full page.
        """
        _reject_private_fetch_target(url)
        try:
            response = self._client.get(
                self._fetch_url(), params={"url": url}, headers=self._headers()
            )
        except httpx.HTTPError as exc:
            raise KeenableConnectionError(
                f"could not reach the Keenable API: {exc!r}"
            ) from exc
        return Page._from_json(_decode(response), url)


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
        client: httpx.AsyncClient | None = None,
    ) -> None:
        super().__init__(api_key, base_url=base_url, timeout=timeout)
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

    async def search(
        self,
        query: str,
        *,
        mode: str | None = None,
        site: str | None = None,
        published_after: str | None = None,
        published_before: str | None = None,
        acquired_after: str | None = None,
        acquired_before: str | None = None,
        snippet_max_length: int | None = None,
    ) -> SearchResponse:
        """Search the web. See :meth:`Keenable.search` for the arguments."""
        payload = _search_payload(
            query,
            mode,
            site,
            published_after,
            published_before,
            acquired_after,
            acquired_before,
            snippet_max_length,
        )
        try:
            response = await self._client.post(
                self._search_url(), json=payload, headers=self._headers()
            )
        except httpx.HTTPError as exc:
            raise KeenableConnectionError(
                f"could not reach the Keenable API: {exc!r}"
            ) from exc
        return SearchResponse._from_json(_decode(response), query)

    async def fetch(self, url: str) -> Page:
        """Fetch one URL as markdown. See :meth:`Keenable.fetch`."""
        _reject_private_fetch_target(url)
        try:
            response = await self._client.get(
                self._fetch_url(), params={"url": url}, headers=self._headers()
            )
        except httpx.HTTPError as exc:
            raise KeenableConnectionError(
                f"could not reach the Keenable API: {exc!r}"
            ) from exc
        return Page._from_json(_decode(response), url)
