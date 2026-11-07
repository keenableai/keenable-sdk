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
    KeenableTargetError,
    RateLimitInfo,
)

CASES: list[dict[str, Any]] = json.loads(
    (Path(__file__).parent / "fixtures" / "error_contract.json").read_text("utf-8")
)["cases"]

KINDS: dict[str, type[KeenableAPIError]] = {
    "auth": KeenableAuthError,
    "rate_limit": KeenableRateLimitError,
    "insufficient_credits": KeenableInsufficientCreditsError,
    "target": KeenableTargetError,
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


def test_a_target_refusal_without_a_code_is_a_target_error() -> None:
    err = _raise(
        httpx.Response(
            403,
            json={
                "error": "Upstream forbidden",
                "message": "The target server denied access to this URL",
            },
        )
    )

    assert isinstance(err, KeenableTargetError)
    assert not isinstance(err, KeenableAuthError)
    assert str(err) == (
        "Keenable API error (403): The target server denied access to this URL. "
        "The site refused the fetch. This is not about your API key, and "
        "retrying the same URL will not help: fetch another source."
    )
    assert "KEENABLE_API_KEY" not in str(err)


@pytest.mark.parametrize(
    "code",
    [
        "target_blocked",
        "target_forbidden",
        "target_bot_wall",
        "target_unreachable",
        "page_not_found",
        "content_not_extracted",
    ],
)
def test_every_target_code_is_a_target_error_not_an_auth_error(code: str) -> None:
    err = _raise(
        httpx.Response(403, json={"error": "Forbidden", "message": "no", "code": code})
    )

    assert type(err) is KeenableTargetError
    assert err.code == code


def test_a_target_rate_limit_stays_a_rate_limit_error() -> None:
    err = _raise(
        httpx.Response(429, json={"message": "busy", "code": "target_rate_limited"})
    )

    assert type(err) is KeenableRateLimitError


def test_a_private_url_refusal_is_not_an_auth_error() -> None:
    err = _raise(
        httpx.Response(
            403,
            json={
                "error": "Forbidden",
                "message": "private",
                "code": "private_url_not_allowed",
            },
        )
    )

    assert type(err) is KeenableAPIError


def test_a_credentials_403_without_a_code_is_still_an_auth_error() -> None:
    err = _raise(
        httpx.Response(403, json={"error": "Forbidden", "message": "Key revoked"})
    )

    assert type(err) is KeenableAuthError
    assert str(err) == "Keenable authentication failed (403): Key revoked"


@pytest.mark.parametrize("status", [400, 404, 422, 500])
def test_errors_without_a_fix_never_add_retry_advice(status: int) -> None:
    err = _raise(httpx.Response(status, json={"message": "nope", "retryable": False}))

    assert "retry" not in str(err).lower()
    assert err.retryable is False


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


def test_an_oversized_retry_after_header_is_capped_not_raised() -> None:
    err = _raise(
        httpx.Response(429, json={"message": "m"}, headers={"Retry-After": "9" * 5000})
    )

    assert isinstance(err, KeenableRateLimitError)
    assert err.retry_after_seconds == 365 * 24 * 60 * 60


def test_a_zero_padded_retry_after_header_keeps_its_value() -> None:
    for header, want in (("0000000001", 1), ("0" * 5000 + "7", 7), ("000", 0)):
        err = _raise(
            httpx.Response(429, json={"message": "m"}, headers={"Retry-After": header})
        )
        assert err.retry_after_seconds == want, header


def test_the_message_ends_with_the_apis_fix() -> None:
    err = _raise(
        httpx.Response(403, json={"error": "Forbidden", "fix": "Create a new key."})
    )

    assert (
        str(err) == "Keenable authentication failed (403): Forbidden. Create a new key."
    )


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
