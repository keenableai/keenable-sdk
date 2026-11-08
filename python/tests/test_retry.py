"""Retries, timeouts, per-call options, headers, request ids and redirects."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

import httpx
import pytest

from keenable import (
    AsyncKeenable,
    Keenable,
    KeenableAPIError,
    KeenableConnectionError,
    KeenableInsufficientCreditsError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
    KeenableTimeoutError,
)
from keenable import client as client_module
from keenable.client import _backoff, _retry_delay

SEARCH_BODY = {
    "query": "q",
    "results": [{"title": "t", "url": "https://e.com", "snippet": "s"}],
}
Reply = Callable[[httpx.Request], httpx.Response]


@pytest.fixture
def waits(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Record the waits between attempts instead of sleeping through them."""
    recorded: list[float] = []
    monkeypatch.setattr(client_module.time, "sleep", recorded.append)

    async def fake_sleep(delay: float) -> None:
        recorded.append(delay)

    monkeypatch.setattr(client_module.asyncio, "sleep", fake_sleep)
    return recorded


def scripted(
    replies: list[Reply], **options: Any
) -> tuple[Keenable, list[httpx.Request]]:
    """A client answering each attempt with the next reply (the last repeats)."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return replies[min(len(seen) - 1, len(replies) - 1)](request)

    options.setdefault("api_key", "k")
    client = Keenable(
        client=httpx.Client(transport=httpx.MockTransport(handler)), **options
    )
    return client, seen


def busy(request: httpx.Request) -> httpx.Response:
    return httpx.Response(529, json={"code": "search_overloaded", "retryable": True})


def ok(request: httpx.Request) -> httpx.Response:
    return httpx.Response(200, json=SEARCH_BODY)


def test_retries_then_succeeds_with_backoff(waits: list[float]) -> None:
    client, seen = scripted([busy, busy, ok])
    assert len(client.search("q")) == 1
    assert len(seen) == 3
    assert len(waits) == 2
    assert 0.375 <= waits[0] <= 0.5 and 0.75 <= waits[1] <= 1.0


def test_gives_up_after_max_retries(waits: list[float]) -> None:
    client, seen = scripted([busy], max_retries=1)
    with pytest.raises(KeenableAPIError):
        client.search("q")
    assert len(seen) == 2


def test_max_retries_zero_per_client_and_per_call(waits: list[float]) -> None:
    client, seen = scripted([busy], max_retries=0)
    with pytest.raises(KeenableAPIError):
        client.search("q")
    assert len(seen) == 1

    client, seen = scripted([busy])
    with pytest.raises(KeenableAPIError):
        client.search("q", max_retries=0)
    assert len(seen) == 1


def test_waits_the_retry_after_header(waits: list[float]) -> None:
    def limited(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429, json={"message": "slow"}, headers={"Retry-After": "3"}
        )

    client, _ = scripted([limited, ok])
    client.search("q")
    assert waits == [3]


def test_never_retries_not_retryable(waits: list[float]) -> None:
    def broke(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            402, json={"code": "insufficient_credits", "retryable": False}
        )

    client, seen = scripted([broke])
    with pytest.raises(KeenableInsufficientCreditsError):
        client.search("q")
    assert len(seen) == 1 and waits == []


def test_does_not_wait_out_the_hourly_cap(waits: list[float]) -> None:
    def hourly(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            429,
            json={
                "code": "public_rate_limit_hourly",
                "retryable": True,
                "retry_after_seconds": 1800,
            },
        )

    client, seen = scripted([hourly])
    with pytest.raises(KeenableRateLimitError) as info:
        client.search("q")
    assert info.value.retry_after_seconds == 1800
    assert len(seen) == 1 and waits == []


def test_retries_connection_errors_and_raises_timeout_error(waits: list[float]) -> None:
    def down(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused", request=request)

    client, seen = scripted([down, ok])
    client.search("q")
    assert len(seen) == 2

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    client, seen = scripted([slow])
    with pytest.raises(KeenableTimeoutError) as info:
        client.search("q")
    assert isinstance(info.value, KeenableConnectionError)
    assert len(seen) == 3


def test_policy_by_status() -> None:
    def err(status: int, **fields: Any) -> KeenableAPIError:
        return KeenableAPIError("x", status, **fields)

    for status in (408, 429, 500, 502, 503, 504, 529):
        assert _retry_delay(err(status), 0) is not None
    for status in (400, 401, 402, 403, 404, 409, 422):
        assert _retry_delay(err(status), 0) is None
    assert _retry_delay(err(422, retryable=True), 0) is not None
    assert _retry_delay(err(500, retryable=False), 0) is None
    assert _retry_delay(err(429, retry_after_seconds=60), 0) == 60
    assert _retry_delay(err(429, retry_after_seconds=61), 0) is None
    assert _retry_delay(KeenableInvalidRequestError("bad"), 0) is None
    assert [_backoff(n, 0) for n in range(6)] == [0.5, 1, 2, 4, 8, 8]
    assert _backoff(0, 1) == 0.375


def test_rejects_bad_settings() -> None:
    with pytest.raises(KeenableInvalidRequestError):
        Keenable(max_retries=-1)
    with pytest.raises(KeenableInvalidRequestError):
        Keenable(timeout=0)
    client, _ = scripted([ok])
    with pytest.raises(KeenableInvalidRequestError):
        client.search("q", timeout=-1)


def test_per_call_timeout_reaches_httpx() -> None:
    client, seen = scripted([ok])
    client.search("q", timeout=4.5)
    assert seen[0].extensions["timeout"]["read"] == 4.5


def test_own_client_keeps_its_timeout_unless_one_is_passed() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok(request)

    own = httpx.Client(transport=httpx.MockTransport(handler), timeout=7)
    Keenable("k", client=own).search("q")
    assert seen[-1].extensions["timeout"]["read"] == 7
    Keenable("k", client=own, timeout=2).search("q")
    assert seen[-1].extensions["timeout"]["read"] == 2


def test_headers_layering_and_key_protection() -> None:
    client, seen = scripted(
        [ok], default_headers={"X-Gateway": "a", "X-Team": "search"}
    )
    client.search("q", extra_headers={"x-gateway": "b", "X-API-Key": "stolen"})
    sent = seen[0].headers
    assert sent["X-Gateway"] == "b"
    assert sent["X-Team"] == "search"
    assert sent["X-API-Key"] == "k"

    client, seen = scripted([ok], api_key="", default_headers={"X-API-Key": "nope"})
    client.search("q")
    assert "X-API-Key" not in seen[0].headers
    assert seen[0].url.path.endswith("/public")


def test_request_id_from_header_and_body() -> None:
    def with_id(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/v1/fetch"):
            return httpx.Response(
                200, json={"url": "https://e.com"}, headers={"X-Request-Id": "f"}
            )
        return httpx.Response(200, json=SEARCH_BODY, headers={"X-Request-Id": "s"})

    client, _ = scripted([with_id])
    assert client.search("q").request_id == "s"
    assert client.fetch("https://e.com").request_id == "f"

    def body_id(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            json={**SEARCH_BODY, "request_id": "body"},
            headers={"X-Request-Id": "h"},
        )

    client, _ = scripted([body_id])
    assert client.search("q").request_id == "body"


def test_redirect_is_not_followed_even_by_a_following_client(
    waits: list[float],
) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(302, headers={"Location": "https://evil.example/"})

    own = httpx.Client(transport=httpx.MockTransport(handler), follow_redirects=True)
    with pytest.raises(KeenableConnectionError, match="evil.example"):
        Keenable("k", client=own).search("q")
    assert len(seen) == 1


async def test_async_retries_and_request_id(waits: list[float]) -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            return busy(request)
        return httpx.Response(200, json=SEARCH_BODY, headers={"X-Request-Id": "a"})

    transport = httpx.MockTransport(handler)
    async with AsyncKeenable(
        "k", client=httpx.AsyncClient(transport=transport)
    ) as client:
        response = await client.search("q", extra_headers={"X-Trace": "1"})
    assert response.request_id == "a"
    assert len(seen) == 2 and len(waits) == 1
    assert seen[0].headers["X-Trace"] == "1"


def test_timeout_none_means_no_deadline_and_httpx_timeout_is_accepted() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return ok(request)

    transport = httpx.MockTransport(handler)
    Keenable("k", timeout=None, client=httpx.Client(transport=transport)).search("q")
    assert seen[-1].extensions["timeout"]["read"] is None

    granular = httpx.Timeout(5.0, read=40.0)
    Keenable("k", timeout=granular, client=httpx.Client(transport=transport)).search(
        "q"
    )
    assert seen[-1].extensions["timeout"]["read"] == 40.0
    assert Keenable("k", timeout=None)._timeout is None
