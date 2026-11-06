"""The API's agent-ready error contract, parsed into typed errors.

Fixtures in ``fixtures/error_contract.json`` are the bodies and headers the
backend sends (keenable-backend-ts PRs #663 and #666), generated from its own
error constructors.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from typing import Any

import httpx
import pytest

from keenable import (
    AsyncKeenable,
    Keenable,
    KeenableAPIError,
    KeenableAuthError,
    KeenableCreditsError,
    KeenableInsufficientCreditsError,
    KeenableRateLimitError,
    RateLimitInfo,
)

CASES: list[dict[str, Any]] = json.loads(
    (Path(__file__).parent / "fixtures" / "error_contract.json").read_text("utf-8")
)["cases"]

KINDS: dict[str, type[KeenableAPIError]] = {
    "auth": KeenableAuthError,
    "rate_limit": KeenableRateLimitError,
    "insufficient_credits": KeenableInsufficientCreditsError,
    "api": KeenableAPIError,
}


def _client(response: httpx.Response, api_key: str | None = "k") -> Keenable:
    transport = httpx.MockTransport(lambda request: response)
    return Keenable(api_key, client=httpx.Client(transport=transport))


def _raise(response: httpx.Response) -> KeenableAPIError:
    with pytest.raises(KeenableAPIError) as excinfo:
        _client(response).search("q")
    return excinfo.value


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_backend_error_bodies_parse_into_typed_errors(case: dict[str, Any]) -> None:
    response = httpx.Response(
        case["status"], json=case["body"], headers=case["headers"]
    )
    err = _raise(response)
    want = case["expect"]

    assert type(err) is KINDS[want["kind"]]
    assert err.status_code == case["status"]
    assert err.code == want["code"]
    assert err.error == case["body"]["error"]
    assert err.fix == want["fix"]
    assert err.docs_url == want["docs_url"]
    assert err.retryable is want["retryable"]
    assert err.retry_after_seconds == want["retry_after_seconds"]
    assert err.request_id == want["request_id"]
    assert err.param == want["param"]
    assert err.billing_url == want["billing_url"]
    assert err.auto_top_up_url == want["auto_top_up_url"]
    assert err.pay_per_request == want["pay_per_request"]
    assert err.raw == case["body"]
    assert want["message_contains"] in str(err)
    if want["limit"] is None:
        assert err.limit is None
    else:
        assert err.limit == RateLimitInfo(**want["limit"])


def test_a_blocked_fetch_target_is_not_an_auth_failure() -> None:
    case = next(c for c in CASES if c["name"] == "target_blocked")
    err = _raise(httpx.Response(403, json=case["body"]))

    assert not isinstance(err, KeenableAuthError)
    assert str(err).startswith("Keenable API error (403): ")


def test_insufficient_credits_is_still_an_api_error_with_the_old_message() -> None:
    err = _raise(httpx.Response(402, json={"detail": "no credits"}))

    assert isinstance(err, KeenableInsufficientCreditsError)
    assert isinstance(err, KeenableCreditsError)
    assert isinstance(err, KeenableAPIError)
    assert str(err) == "Keenable: insufficient credits (402): no credits"
    assert err.billing_url is None


def test_todays_api_without_the_new_fields_leaves_them_none() -> None:
    err = _raise(httpx.Response(429, json={"message": "hourly cap reached"}))

    assert isinstance(err, KeenableRateLimitError)
    assert str(err) == "Keenable rate limit exceeded (429): hourly cap reached"
    assert err.body == "hourly cap reached"
    for field in (
        "code",
        "fix",
        "docs_url",
        "retryable",
        "retry_after_seconds",
        "request_id",
        "param",
        "limit",
        "billing_url",
        "auto_top_up_url",
        "pay_per_request",
    ):
        assert getattr(err, field) is None, field


def test_non_json_error_body_keeps_raw_none() -> None:
    err = _raise(httpx.Response(502, text="upstream exploded"))

    assert err.raw is None
    assert err.code is None
    assert str(err) == "Keenable API error (502): upstream exploded"


def test_retry_after_header_is_used_when_the_body_has_no_seconds() -> None:
    err = _raise(
        httpx.Response(
            429,
            json={"message": "slow down"},
            headers={"Retry-After": "7", "X-Request-Id": "req-h"},
        )
    )

    assert err.retry_after_seconds == 7
    assert err.request_id == "req-h"


def test_retry_after_http_date_becomes_seconds_from_now() -> None:
    when = datetime.now(timezone.utc) + timedelta(seconds=30)
    err = _raise(
        httpx.Response(
            503,
            json={"error": "x"},
            headers={"Retry-After": format_datetime(when, usegmt=True)},
        )
    )

    assert err.retry_after_seconds is not None
    assert 25 <= err.retry_after_seconds <= 31


def test_the_older_retry_after_body_field_is_a_last_resort() -> None:
    err = _raise(httpx.Response(429, json={"message": "m", "retryAfter": 3}))

    assert err.retry_after_seconds == 3


def test_the_body_wins_over_the_header_and_bad_values_are_ignored() -> None:
    err = _raise(
        httpx.Response(
            429,
            json={"retry_after_seconds": 4, "retryable": "yes", "limit": "nope"},
            headers={"Retry-After": "9"},
        )
    )
    assert err.retry_after_seconds == 4
    assert err.retryable is None
    assert err.limit is None

    err = _raise(
        httpx.Response(
            429,
            json={"retry_after_seconds": -1},
            headers={"Retry-After": "soon"},
        )
    )
    assert err.retry_after_seconds is None


async def test_the_async_client_parses_the_same_contract() -> None:
    case = next(c for c in CASES if c["name"] == "insufficient_credits")
    response = httpx.Response(402, json=case["body"], headers=case["headers"])
    transport = httpx.MockTransport(lambda request: response)
    client = AsyncKeenable("k", client=httpx.AsyncClient(transport=transport))

    with pytest.raises(KeenableInsufficientCreditsError) as excinfo:
        await client.fetch("https://example.com")

    assert excinfo.value.code == "insufficient_credits"
    assert excinfo.value.retryable is False
    assert excinfo.value.billing_url == "https://app.keenable.ai/console/billing"
