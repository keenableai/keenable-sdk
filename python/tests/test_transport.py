"""Retries, timeouts, request ids, redirects and malformed bodies, end to end.

Every scenario runs through both the sync and the async client, so the two
stay in step. The retry decision for each code in the API's error catalog is
checked against the same fixture the Go and TypeScript SDKs test.
"""

from __future__ import annotations

import json
import math
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from typing import Any, Union

import httpx
import pytest

from keenable import (
    AsyncKeenable,
    Keenable,
    KeenableAPIError,
    KeenableAuthError,
    KeenableConnectionError,
    KeenableError,
    KeenableInsufficientCreditsError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
    KeenableTimeoutError,
)
from keenable import client as client_module
from keenable.client import _backoff

FIXTURE = Path(__file__).parent / "fixtures" / "error_contract.json"
CASES: list[dict[str, Any]] = json.loads(FIXTURE.read_text("utf-8"))["cases"]
KINDS: dict[str, type[KeenableAPIError]] = {
    "auth": KeenableAuthError,
    "rate_limit": KeenableRateLimitError,
    "insufficient_credits": KeenableInsufficientCreditsError,
    "api": KeenableAPIError,
}
CLIENTS = ["sync", "async"]
SEARCH_BODY = {
    "query": "q",
    "results": [{"title": "t", "url": "https://e.com", "snippet": "s"}],
}
YEAR = 365 * 24 * 60 * 60

# A reply is a response, or a transport error class httpx raises for it.
Reply = Union[httpx.Response, type[httpx.TransportError]]


def ok(headers: dict[str, str] | None = None, **body: Any) -> httpx.Response:
    return httpx.Response(200, json={**SEARCH_BODY, **body}, headers=headers)


class Outcome:
    """What one call did: its result or error, every request, every wait."""

    def __init__(self, waits: list[float]) -> None:
        self.result: Any = None
        self.error: KeenableError | None = None
        self.requests: list[httpx.Request] = []
        self.waits = waits

    @property
    def attempts(self) -> int:
        return len(self.requests)


@pytest.fixture
def waits(monkeypatch: pytest.MonkeyPatch) -> list[float]:
    """Record the waits between attempts instead of sleeping through them."""
    recorded: list[float] = []
    monkeypatch.setattr(client_module.time, "sleep", recorded.append)

    async def fake_sleep(delay: float) -> None:
        recorded.append(delay)

    monkeypatch.setattr(client_module.asyncio, "sleep", fake_sleep)
    return recorded


Runner = Callable[..., Any]


@pytest.fixture(params=CLIENTS)
def run(request: pytest.FixtureRequest, waits: list[float]) -> Runner:
    """Call search or fetch on a sync or async client answering with ``replies``.

    Attempt n gets ``replies[n]``; the last reply repeats.
    """
    kind = request.param

    async def runner(
        replies: list[Reply],
        *,
        method: str = "search",
        arg: str = "q",
        call: dict[str, Any] | None = None,
        own_client: dict[str, Any] | None = None,
        **options: Any,
    ) -> Outcome:
        outcome = Outcome(waits)

        def handler(req: httpx.Request) -> httpx.Response:
            outcome.requests.append(req)
            reply = replies[min(len(outcome.requests), len(replies)) - 1]
            if isinstance(reply, httpx.Response):
                # A copy: parametrized replies are shared by both clients.
                reply.read()
                return httpx.Response(
                    reply.status_code, headers=reply.headers, content=reply.content
                )
            raise reply("scripted", request=req)

        options.setdefault("api_key", "k")
        transport = httpx.MockTransport(handler)
        try:
            if kind == "sync":
                with Keenable(
                    client=httpx.Client(transport=transport, **(own_client or {})),
                    **options,
                ) as client:
                    outcome.result = getattr(client, method)(arg, **(call or {}))
            else:
                async with AsyncKeenable(
                    client=httpx.AsyncClient(transport=transport, **(own_client or {})),
                    **options,
                ) as aclient:
                    outcome.result = await getattr(aclient, method)(arg, **(call or {}))
        except KeenableError as error:
            outcome.error = error
        return outcome

    return runner


def in_backoff(wait: float, retry: int) -> bool:
    base = min(0.5 * 2**retry, 8.0)
    return base * 0.75 <= wait <= base


# --- the retry decision for every code the API documents -------------------


def _expected_wait(case: dict[str, Any]) -> float | None | str:
    """The wait before the retry, "backoff", or None when it is not retried."""
    want = case["expect"]
    retryable = want["retryable"]
    if retryable is None:
        status = case["status"]
        retryable = status in (408, 429) or status >= 500
    if not retryable:
        return None
    after = want["retry_after_seconds"]
    if after is None:
        return "backoff"
    return float(after) if after <= 60 else None


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
async def test_each_catalog_code_is_retried_as_the_api_says(
    run: Runner, case: dict[str, Any]
) -> None:
    failure = httpx.Response(case["status"], json=case["body"], headers=case["headers"])
    outcome = await run([failure, ok()], max_retries=1)
    expected = _expected_wait(case)

    if expected is None:
        assert type(outcome.error) is KINDS[case["expect"]["kind"]]
        assert outcome.attempts == 1
        assert outcome.waits == []
    else:
        assert outcome.error is None, outcome.error
        assert outcome.attempts == 2
        assert len(outcome.waits) == 1
        if expected == "backoff":
            assert in_backoff(outcome.waits[0], 0)
        else:
            assert outcome.waits[0] == expected


# --- by status, when the API sends no ``retryable`` -------------------------


@pytest.mark.parametrize("status", [400, 401, 402, 403, 404, 409, 413, 422, 451])
async def test_a_4xx_other_than_408_and_429_is_not_retried(
    run: Runner, status: int
) -> None:
    outcome = await run([httpx.Response(status, json={"message": "no"}), ok()])
    assert isinstance(outcome.error, KeenableAPIError)
    assert outcome.error.status_code == status
    assert outcome.attempts == 1 and outcome.waits == []


@pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504, 529])
async def test_408_429_and_5xx_are_retried_with_backoff(
    run: Runner, status: int
) -> None:
    outcome = await run([httpx.Response(status, json={"message": "busy"}), ok()])
    assert outcome.error is None
    assert outcome.attempts == 2
    assert in_backoff(outcome.waits[0], 0)


async def test_the_apis_retryable_overrides_the_status(run: Runner) -> None:
    outcome = await run([httpx.Response(400, json={"retryable": True}), ok()])
    assert outcome.error is None and outcome.attempts == 2

    outcome = await run([httpx.Response(503, json={"retryable": False}), ok()])
    assert isinstance(outcome.error, KeenableAPIError)
    assert outcome.attempts == 1


async def test_a_retryable_false_error_is_not_retried_even_with_a_retry_after(
    run: Runner,
) -> None:
    body = {"retryable": False, "retry_after_seconds": 1}
    outcome = await run([httpx.Response(429, json=body), ok()])
    assert isinstance(outcome.error, KeenableRateLimitError)
    assert outcome.attempts == 1 and outcome.waits == []


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectError,
        httpx.ReadError,
        httpx.WriteError,
        httpx.RemoteProtocolError,
        httpx.ConnectTimeout,
        httpx.ReadTimeout,
        httpx.WriteTimeout,
        httpx.PoolTimeout,
    ],
)
async def test_network_failures_and_timeouts_are_retried(
    run: Runner, error: type[httpx.TransportError]
) -> None:
    outcome = await run([error, ok()])
    assert outcome.error is None
    assert outcome.attempts == 2
    assert in_backoff(outcome.waits[0], 0)


async def test_search_and_fetch_are_retried_alike(run: Runner) -> None:
    # Search is a POST but reads only, so the SDKs retry it like fetch's GET.
    page = httpx.Response(200, json={"url": "https://e.com", "content": "c"})
    outcome = await run(
        [httpx.Response(503), page], method="fetch", arg="https://e.com"
    )
    assert outcome.error is None and outcome.attempts == 2
    assert outcome.requests[0].method == "GET"

    outcome = await run([httpx.Response(503), ok()])
    assert outcome.error is None and outcome.attempts == 2
    assert outcome.requests[1].method == "POST"
    assert outcome.requests[1].content == outcome.requests[0].content


# --- the retry budget --------------------------------------------------------


async def test_the_default_budget_is_two_retries(run: Runner) -> None:
    outcome = await run([httpx.Response(503)])
    assert isinstance(outcome.error, KeenableAPIError)
    assert outcome.attempts == 3
    assert in_backoff(outcome.waits[0], 0) and in_backoff(outcome.waits[1], 1)


@pytest.mark.parametrize(
    ("client_retries", "call_retries", "attempts"),
    [(0, None, 1), (0, 3, 4), (5, 1, 2), (5, 0, 1), (1, None, 2)],
)
async def test_a_per_call_budget_overrides_the_clients(
    run: Runner, client_retries: int, call_retries: int | None, attempts: int
) -> None:
    call = {} if call_retries is None else {"max_retries": call_retries}
    outcome = await run([httpx.Response(503)], max_retries=client_retries, call=call)
    assert isinstance(outcome.error, KeenableAPIError)
    assert outcome.attempts == attempts
    assert len(outcome.waits) == attempts - 1


async def test_the_last_error_is_raised_when_the_budget_runs_out(
    run: Runner,
) -> None:
    replies: list[Reply] = [
        httpx.Response(503, json={"code": "first"}),
        httpx.Response(502, json={"code": "last"}, headers={"X-Request-Id": "r2"}),
    ]
    outcome = await run(replies, max_retries=1)
    assert isinstance(outcome.error, KeenableAPIError)
    assert outcome.error.code == "last"
    assert outcome.error.request_id == "r2"


@pytest.mark.parametrize("bad", [-1, True, 1.5, "2"])
async def test_a_bad_per_call_budget_is_rejected_before_sending(
    run: Runner, bad: Any
) -> None:
    outcome = await run([ok()], call={"max_retries": bad})
    assert isinstance(outcome.error, KeenableInvalidRequestError)
    assert outcome.attempts == 0


@pytest.mark.parametrize("bad", [-1, True, 1.5, "2", None])
def test_a_bad_client_budget_is_rejected(bad: Any) -> None:
    with pytest.raises(KeenableInvalidRequestError):
        Keenable("k", max_retries=bad)
    with pytest.raises(KeenableInvalidRequestError):
        AsyncKeenable("k", max_retries=bad)


# --- backoff and jitter ------------------------------------------------------


def test_backoff_doubles_from_half_a_second_to_eight() -> None:
    assert [_backoff(n, 0) for n in range(7)] == [0.5, 1, 2, 4, 8, 8, 8]


def test_jitter_shortens_the_wait_by_at_most_a_quarter() -> None:
    for retry in range(8):
        base = _backoff(retry, 0)
        assert _backoff(retry, 1) == base * 0.75
        for _ in range(200):
            assert base * 0.75 <= _backoff(retry) <= base


def test_a_long_retry_budget_does_not_overflow_the_backoff() -> None:
    # Bug: 0.5 * 2.0**1024 raised OverflowError on the 1025th retry.
    assert _backoff(1024, 0) == 8.0
    assert _backoff(10_000, 0.5) == 7.0


async def test_jitter_comes_from_random(
    run: Runner, monkeypatch: pytest.MonkeyPatch
) -> None:
    draws = iter([0.0, 0.5])
    monkeypatch.setattr(client_module.random, "random", lambda: next(draws))
    outcome = await run([httpx.Response(503), httpx.Response(503), ok()])
    assert outcome.waits == [0.5, 0.875]


# --- Retry-After -------------------------------------------------------------


def _limited(headers: dict[str, str] | None = None, **body: Any) -> httpx.Response:
    return httpx.Response(429, json={"message": "slow", **body}, headers=headers)


@pytest.mark.parametrize(
    ("reply", "wait"),
    [
        (_limited({"Retry-After": "0"}), 0),
        (_limited({"Retry-After": "60"}), 60),
        (_limited({"Retry-After": " 7 "}), 7),
        (_limited({"Retry-After": "007"}), 7),
        (_limited(retry_after_seconds=0.25), 0.25),
        (_limited(retry_after_seconds=60), 60),
        # The body wins over the header, and the header over legacy retryAfter.
        (_limited({"Retry-After": "30"}, retry_after_seconds=1), 1),
        (_limited({"Retry-After": "4"}, retryAfter=9), 4),
        (_limited(retryAfter=3), 3),
        # A malformed body value falls through to the next source.
        (_limited({"Retry-After": "2"}, retry_after_seconds=-5), 2),
        (_limited({"Retry-After": "2"}, retry_after_seconds="5"), 2),
        (_limited({"Retry-After": "2"}, retry_after_seconds=True), 2),
        (_limited({"Retry-After": "2"}, retry_after_seconds=10**400), 2),
        (_limited({"Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT"}), 0),
    ],
)
async def test_retry_after_sets_the_wait(
    run: Runner, reply: httpx.Response, wait: float
) -> None:
    outcome = await run([reply, ok()])
    assert outcome.error is None
    assert outcome.waits == [wait]


async def test_a_retry_after_date_is_waited_until(run: Runner) -> None:
    when = datetime.now(timezone.utc) + timedelta(seconds=30)
    outcome = await run(
        [_limited({"Retry-After": format_datetime(when, usegmt=True)}), ok()]
    )
    assert outcome.error is None
    assert 28 <= outcome.waits[0] <= 31


@pytest.mark.parametrize(
    "header", ["1.5", "-1", "+5", "5s", "soon", "Jan 1", "2015-10-21"]
)
async def test_a_malformed_retry_after_falls_back_to_backoff(
    run: Runner, header: str
) -> None:
    outcome = await run([_limited({"Retry-After": header}), ok()])
    assert outcome.error is None
    assert in_backoff(outcome.waits[0], 0)


@pytest.mark.parametrize(
    ("reply", "reported"),
    [
        (_limited({"Retry-After": "61"}), 61),
        (_limited(retry_after_seconds=60.5), 60.5),
        (_limited(retry_after_seconds=1800), 1800),
        # The clamps from #48: a huge delay is a year, not an overflow.
        (_limited({"Retry-After": "9" * 400}), YEAR),
        (_limited({"Retry-After": "Fri, 31 Dec 9999 23:59:59 GMT"}), YEAR),
        (_limited(retry_after_seconds=1e300), YEAR),
        (_limited(retryAfter=10**30), YEAR),
    ],
)
async def test_a_retry_after_over_a_minute_is_raised_at_once(
    run: Runner, reply: httpx.Response, reported: float
) -> None:
    outcome = await run([reply, ok()])
    assert isinstance(outcome.error, KeenableRateLimitError)
    assert outcome.error.retry_after_seconds == reported
    assert outcome.attempts == 1 and outcome.waits == []


# --- timeouts ----------------------------------------------------------------


async def test_the_timeout_error_after_the_last_attempt(run: Runner) -> None:
    outcome = await run([httpx.ReadTimeout], timeout=30.0)
    assert isinstance(outcome.error, KeenableTimeoutError)
    assert isinstance(outcome.error, KeenableConnectionError)
    assert "within 30.0 s" in str(outcome.error)
    assert outcome.attempts == 3


async def test_a_timeout_is_not_retried_with_retries_off(run: Runner) -> None:
    outcome = await run([httpx.ConnectTimeout, ok()], max_retries=0)
    assert isinstance(outcome.error, KeenableTimeoutError)
    assert outcome.attempts == 1


async def test_a_timeout_during_retries_then_success(run: Runner) -> None:
    outcome = await run([httpx.ReadTimeout, httpx.Response(503), ok()])
    assert outcome.error is None
    assert outcome.attempts == 3
    assert in_backoff(outcome.waits[0], 0) and in_backoff(outcome.waits[1], 1)


async def test_the_timeout_message_names_the_calls_deadline(run: Runner) -> None:
    outcome = await run([httpx.ReadTimeout], call={"timeout": 2})
    assert "within 2 s" in str(outcome.error)

    outcome = await run([httpx.ReadTimeout], timeout=httpx.Timeout(5.0))
    assert isinstance(outcome.error, KeenableTimeoutError)
    assert "within" not in str(outcome.error)


def _read_timeout(request: httpx.Request) -> Any:
    return request.extensions["timeout"]["read"]


@pytest.mark.parametrize(
    ("options", "own", "call", "read"),
    [
        # A client of your own keeps its timeout (httpx's default is 5 s).
        ({}, None, {}, 5.0),
        ({"timeout": 3}, None, {}, 3),
        # None per call keeps the client's timeout; it does not mean "no limit".
        ({"timeout": 3}, None, {"timeout": None}, 3),
        ({"timeout": 3}, None, {"timeout": 1.5}, 1.5),
        ({"timeout": None}, None, {}, None),
        ({"timeout": None}, None, {"timeout": 4}, 4),
        ({}, {"timeout": 7}, {}, 7),
        ({}, {"timeout": 7}, {"timeout": None}, 7),
        ({}, {"timeout": 7}, {"timeout": 2}, 2),
        ({"timeout": 3}, {"timeout": 7}, {}, 3),
    ],
)
async def test_per_call_and_client_timeouts(
    run: Runner,
    options: dict[str, Any],
    own: dict[str, Any] | None,
    call: dict[str, Any],
    read: float | None,
) -> None:
    outcome = await run(
        [httpx.Response(503), ok()], own_client=own, call=call, **options
    )
    assert outcome.error is None
    # Every attempt gets the deadline, the retry included.
    assert [_read_timeout(r) for r in outcome.requests] == [read, read]


@pytest.mark.parametrize("bad", [0, -1, math.nan, math.inf, True, "5"])
async def test_a_bad_timeout_is_rejected_before_sending(run: Runner, bad: Any) -> None:
    outcome = await run([ok()], call={"timeout": bad})
    assert isinstance(outcome.error, KeenableInvalidRequestError)
    assert outcome.attempts == 0
    with pytest.raises(KeenableInvalidRequestError):
        Keenable("k", timeout=bad)
    with pytest.raises(KeenableInvalidRequestError):
        AsyncKeenable("k", timeout=bad)


# --- request ids -------------------------------------------------------------


def _page(headers: dict[str, str] | None = None, **body: Any) -> httpx.Response:
    return httpx.Response(
        200, json={"url": "https://e.com", "content": "c", **body}, headers=headers
    )


@pytest.mark.parametrize(
    ("method", "reply", "request_id"),
    [
        ("search", ok({"X-Request-Id": "h"}), "h"),
        ("search", ok({"X-Request-Id": "h"}, request_id="b"), "b"),
        ("search", ok({"X-Request-Id": "  "}), None),
        ("search", ok({"X-Request-Id": "h"}, request_id=""), "h"),
        ("search", ok({"X-Request-Id": "h"}, request_id=7), "h"),
        ("search", ok(), None),
        ("fetch", _page({"X-Request-Id": "h"}), "h"),
        ("fetch", _page({"X-Request-Id": "h"}, request_id="b"), "b"),
        ("fetch", _page(), None),
    ],
)
async def test_request_id_on_success(
    run: Runner, method: str, reply: httpx.Response, request_id: str | None
) -> None:
    arg = "https://e.com" if method == "fetch" else "q"
    outcome = await run([reply], method=method, arg=arg)
    assert outcome.error is None
    assert outcome.result.request_id == request_id


@pytest.mark.parametrize(
    ("reply", "request_id"),
    [
        (
            httpx.Response(400, json={"message": "m"}, headers={"X-Request-Id": "h"}),
            "h",
        ),
        (
            httpx.Response(
                400, json={"request_id": "b"}, headers={"X-Request-Id": "h"}
            ),
            "b",
        ),
        (httpx.Response(400, text="<html>", headers={"X-Request-Id": "h"}), "h"),
        (httpx.Response(400, json={"message": "m"}), None),
    ],
)
async def test_request_id_on_error(
    run: Runner, reply: httpx.Response, request_id: str | None
) -> None:
    outcome = await run([reply])
    assert isinstance(outcome.error, KeenableAPIError)
    assert outcome.error.request_id == request_id
    if request_id:
        assert str(outcome.error).endswith(f"(request_id: {request_id})")
    else:
        assert "request_id" not in str(outcome.error)


async def test_the_request_id_is_the_answering_attempts(run: Runner) -> None:
    replies: list[Reply] = [
        httpx.Response(503, headers={"X-Request-Id": "first"}),
        ok({"X-Request-Id": "second"}),
    ]
    outcome = await run(replies)
    assert outcome.result.request_id == "second"


# --- redirects: the API key never leaves the configured host -----------------

API_HOST = "api.keenable.ai"


@pytest.mark.parametrize("status", [300, 301, 302, 303, 304, 307, 308])
@pytest.mark.parametrize(
    "location",
    [
        "https://evil.example/v1/search",  # another host
        "https://api.keenable.ai.evil.example/v1/search",  # a lookalike
        "https://user@evil.example/v1/search",
        "https://api.keenable.ai:8443/v1/search",  # same host, another port
        "http://api.keenable.ai/v1/search",  # a scheme downgrade
        "https://api.keenable.ai/v1/search/elsewhere",  # the same host
        "/v1/elsewhere",
        None,
    ],
)
@pytest.mark.parametrize("follow", [False, True])
async def test_a_redirect_is_never_followed(
    run: Runner, status: int, location: str | None, follow: bool
) -> None:
    headers = {"Location": location} if location else {}
    outcome = await run(
        [httpx.Response(status, headers=headers), ok()],
        api_key="keen_secret",
        own_client={"follow_redirects": follow},
    )
    assert isinstance(outcome.error, KeenableConnectionError)
    assert not isinstance(outcome.error, (KeenableTimeoutError, KeenableAPIError))
    # One request, to the configured host, and no retry of the refusal.
    assert outcome.attempts == 1 and outcome.waits == []
    assert outcome.requests[0].url.host == API_HOST
    assert "keen_secret" not in str(outcome.error)
    assert "KEENABLE_API_URL" in str(outcome.error)
    if location:
        assert location in str(outcome.error)


# --- malformed and empty bodies ----------------------------------------------


@pytest.mark.parametrize(
    ("reply", "detail", "raw", "error_type"),
    [
        (httpx.Response(400), None, None, "invalid_request_error"),
        (httpx.Response(400, text="   "), None, None, "invalid_request_error"),
        (
            httpx.Response(400, text='{"code": "x"'),
            '{"code": "x"',
            None,
            "invalid_request_error",
        ),
        (httpx.Response(400, text="[1, 2]"), None, None, "invalid_request_error"),
        (httpx.Response(400, text='"oops"'), None, None, "invalid_request_error"),
        (httpx.Response(400, text="null"), None, None, "invalid_request_error"),
        (
            httpx.Response(403, text="<h1>Forbidden</h1>"),
            "<h1>Forbidden</h1>",
            None,
            "permission_error",
        ),
        (
            httpx.Response(400, json={"message": " ", "error": "Bad", "detail": "d"}),
            "Bad",
            {"message": " ", "error": "Bad", "detail": "d"},
            "invalid_request_error",
        ),
        (
            httpx.Response(400, json={"detail": "only"}),
            "only",
            {"detail": "only"},
            "invalid_request_error",
        ),
        (httpx.Response(400, json={}), None, {}, "invalid_request_error"),
        (httpx.Response(451, json={}), None, {}, "billing_error"),
    ],
)
async def test_a_malformed_error_body_still_maps_by_status(
    run: Runner,
    reply: httpx.Response,
    detail: str | None,
    raw: Any,
    error_type: str,
) -> None:
    outcome = await run([reply])
    error = outcome.error
    assert isinstance(error, KeenableAPIError)
    assert error.status_code == reply.status_code
    assert error.body == detail
    assert error.raw == raw
    assert error.type == error_type
    assert error.code is None
    assert str(error).startswith("Keenable ")
    if detail:
        assert detail in str(error)
    assert outcome.attempts == 1


async def test_a_5xx_html_page_from_a_proxy_is_retried(run: Runner) -> None:
    outcome = await run([httpx.Response(502, text="<html>Bad Gateway</html>"), ok()])
    assert outcome.error is None and outcome.attempts == 2

    outcome = await run([httpx.Response(502, text="<html>Bad Gateway</html>")])
    assert isinstance(outcome.error, KeenableAPIError)
    assert outcome.error.body == "<html>Bad Gateway</html>"
    assert outcome.error.type == "api_error"


@pytest.mark.parametrize(
    ("text", "message"),
    [
        ("", "non-JSON"),
        ("<html>", "non-JSON"),
        ('{"results": [', "non-JSON"),
        ("[]", "Unexpected response"),
        ('"text"', "Unexpected response"),
        ("null", "Unexpected response"),
    ],
)
async def test_a_success_that_is_not_a_json_object_is_an_error_not_retried(
    run: Runner, text: str, message: str
) -> None:
    reply = httpx.Response(200, text=text, headers={"X-Request-Id": "r"})
    outcome = await run([reply, ok()])
    assert isinstance(outcome.error, KeenableAPIError)
    assert message in str(outcome.error)
    assert outcome.error.status_code == 200
    assert outcome.error.request_id == "r"
    assert outcome.attempts == 1


async def test_a_lenient_success_body_parses(run: Runner) -> None:
    body = {"query": "  ", "results": [None, 3, {"title": "t", "url": "u"}]}
    outcome = await run([httpx.Response(200, json=body)])
    assert outcome.result.query == "q"
    assert [r.title for r in outcome.result.results] == ["t"]

    outcome = await run([httpx.Response(200, json={"query": 5, "results": "x"})])
    assert outcome.result.query == "q"
    assert outcome.result.results == []

    page = httpx.Response(200, json={"url": "", "title": None})
    outcome = await run([page], method="fetch", arg="https://e.com/a")
    assert outcome.result.url == "https://e.com/a"
    assert outcome.result.title == ""


# --- fetch targets -------------------------------------------------------------


@pytest.mark.parametrize(
    "url",
    [
        # Hosts spelled as numbers reach 127.0.0.1 in a URL parser (the
        # TypeScript SDK refuses them too).
        "http://2130706433/",
        "http://0x7f.0.0.1/",
        "http://0x7F000001/",
        "http://017700000001/",
        "http://0177.0.0.1/",
        "http://127.1/",
        "http://10.1/",
        "http://0/",
        "http://0x/",
        # Fullwidth digits and ideographic full stops fold to ASCII.
        "http://１２７.０.０.１/",
        "http://127。0。0。1/",
        "http://ｌｏｃａｌｈｏｓｔ/",
        "https://user:pass@127.0.0.1/",
        "https://example.com@10.0.0.1/",
        "http://127.0.0.1:8080/",
        "http://[::]/",
        "http://[::1]/",
        "http://[::ffff:7f00:1]/",
        "http://[fd00::1]/",
        "http://[fe80::1]/",
        "http://[ff02::1]/",
        "http://224.0.0.1/",
        "http://240.0.0.1/",
        "http://255.255.255.255/",
        "http://0.0.0.0/",
        "http://METADATA.google.internal./",
        "https:///nohost",
        "ftp://example.com/",
        "javascript:alert(1)",
    ],
)
async def test_fetch_refuses_internal_targets(run: Runner, url: str) -> None:
    outcome = await run([_page()], method="fetch", arg=url)
    assert isinstance(outcome.error, KeenableInvalidRequestError)
    assert outcome.attempts == 0


@pytest.mark.parametrize(
    "url",
    [
        "https://fdic.gov/",
        "https://fcbarcelona.com/",
        "https://febreze.com/",
        "https://ff02.example/",
        "https://localhost.example.com/",
        "https://127.0.0.1.nip.io.example/",
        "https://127.0.0.1@example.com/",
        "https://example.com:8443/x",
        "https://1e100.net/",
        "https://0x7f.example/",
        "https://8.8.8.8/",
        "https://134744072/",  # 8.8.8.8 spelled as a number
        "https://172.32.0.1/",
        "https://例え.jp/",
        "https://xn--r8jz45g.jp/",
    ],
)
async def test_fetch_allows_public_targets(run: Runner, url: str) -> None:
    outcome = await run([_page()], method="fetch", arg=url)
    assert outcome.error is None
    assert outcome.requests[0].url.params["url"] == url


# --- client setup ----------------------------------------------------------------


@pytest.mark.parametrize(
    "base",
    [
        "http://localhost:8080",
        "http://127.0.0.1",
        "http://[::1]:9000",
        "https://proxy.example/api/",
    ],
)
def test_http_is_allowed_only_for_a_local_base_url(base: str) -> None:
    assert Keenable("k", base_url=base)._base_url == base.rstrip("/")


@pytest.mark.parametrize(
    "base",
    [
        "http://example.com",
        "http://localhost.example.com",
        "ftp://localhost",
        "https://",
        "not a url",
    ],
)
def test_a_remote_http_or_hostless_base_url_is_rejected(base: str) -> None:
    with pytest.raises(KeenableInvalidRequestError):
        Keenable("k", base_url=base)


def test_closing_closes_only_a_client_the_sdk_made() -> None:
    owned = Keenable("k")
    with owned:
        pass
    assert owned._client.is_closed

    mine = httpx.Client()
    with Keenable("k", client=mine):
        pass
    assert not mine.is_closed
    mine.close()


async def test_async_closing_closes_only_a_client_the_sdk_made() -> None:
    owned = AsyncKeenable("k")
    async with owned:
        pass
    assert owned._client.is_closed

    mine = httpx.AsyncClient()
    async with AsyncKeenable("k", client=mine):
        pass
    assert not mine.is_closed
    await mine.aclose()


# --- smaller branches ------------------------------------------------------------


@pytest.mark.parametrize(
    "host", ["256.0.0.1", "1.16777216", "1.2.3.4.5", "0x1g", "08", "1..2", "-1", "1_0"]
)
def test_a_host_that_is_not_a_numeric_ipv4_is_left_to_the_hostname_path(
    host: str,
) -> None:
    assert client_module._numeric_ipv4(host) is None


async def test_a_zoneless_retry_after_date_is_read_as_gmt(run: Runner) -> None:
    when = datetime.now(timezone.utc) + timedelta(seconds=30)
    header = when.strftime("%a, %d %b %Y %H:%M:%S")
    outcome = await run([_limited({"Retry-After": header}), ok()])
    assert outcome.error is None
    assert 28 <= outcome.waits[0] <= 31


@pytest.mark.parametrize(
    ("text", "cleaned"),
    [
        ("see [docs]() now", "see docs now"),
        ("[x](//[bad/y)", "x"),
        ("a \x00 [x](/y)", "a \x00 [x](https://e.com/y)"),
    ],
)
def test_context_cleaning_edge_links(text: str, cleaned: str) -> None:
    assert (
        client_module.Page(url="https://e.com/a", title="T", content=text).to_context()
        == f"[1] T (https://e.com/a)\n{cleaned}"
    )


def test_a_page_context_too_small_for_any_content_is_the_header() -> None:
    page = client_module.Page(
        url="https://e.com", title="T", content="body", published_at="2024-01-01"
    )
    assert (
        page.to_context(max_chars=10) == "[1] T (https://e.com) - published 2024-01-01"
    )


@pytest.mark.parametrize(
    "arguments", ["[]", "3", '{"query": ""}', '{"query": 5}', '{"url": "  "}']
)
def test_tool_arguments_that_are_not_usable_are_rejected(arguments: str) -> None:
    from keenable.tools import run_tool_call

    name = "keenable_fetch" if "url" in arguments else "keenable_search"
    with pytest.raises(KeenableInvalidRequestError):
        run_tool_call(Keenable("k"), name, arguments)
