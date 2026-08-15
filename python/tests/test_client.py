"""Unit tests for the Keenable client, run against a mock transport."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from keenable import (
    AsyncKeenable,
    Keenable,
    KeenableAuthError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
    run_tool_call,
)

SEARCH_BODY: dict[str, Any] = {
    "query": "wafer scale engine",
    "mode": "pro",
    "results": [
        {
            "title": "How Cerebras works",
            "url": "https://cerebras.ai/chip",
            "description": "",
            "snippet": "The WSE keeps the whole model in on-chip memory.",
            "published_at": "2026-05-31T23:57:19Z",
            "acquired_at": "2026-07-24T01:32:23Z",
        },
        {
            "title": "MoE guide",
            "url": "https://cerebras.ai/blog/moe-guide-scale",
            "snippet": "Mixture-of-experts routing at scale.",
        },
    ],
}

FETCH_BODY: dict[str, Any] = {
    "url": "https://example.com/",
    "title": "Example Domain",
    "content": "# Example Domain\n\nThis domain is for use in examples.",
    "description": "",
}


def _client(handler: Any) -> tuple[Keenable, list[httpx.Request]]:
    """A Keenable client wired to a mock transport, plus the request log."""
    seen: list[httpx.Request] = []

    def _record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    transport = httpx.MockTransport(_record)
    return Keenable(client=httpx.Client(transport=transport)), seen


def _ok(body: dict[str, Any]) -> Any:
    return lambda request: httpx.Response(200, json=body)


def test_search_parses_results_and_prefers_snippet() -> None:
    keenable, _ = _client(_ok(SEARCH_BODY))
    response = keenable.search("wafer scale engine")

    assert len(response) == 2
    assert response[0].title == "How Cerebras works"
    assert response[0].snippet.startswith("The WSE")
    # The API sends description="" for most pages; it must not become a str "".
    assert response[0].description is None
    assert response[0].published_at == "2026-05-31T23:57:19Z"


def test_search_sends_filters_and_defaults_to_pro() -> None:
    keenable, seen = _client(_ok(SEARCH_BODY))
    keenable.search(
        "wafer scale engine", site="cerebras.ai", published_after="2026-01-01"
    )

    payload = json.loads(seen[0].content)
    assert payload == {
        "query": "wafer scale engine",
        "mode": "pro",
        "site": "cerebras.ai",
        "published_after": "2026-01-01",
    }


def test_keyless_client_uses_public_endpoint_and_identifies_itself() -> None:
    keenable, seen = _client(_ok(SEARCH_BODY))
    keenable.search("hello")

    assert keenable.keyless is True
    assert seen[0].url.path == "/v1/search/public"
    assert "X-API-Key" not in seen[0].headers
    # The public tier rejects requests without this header.
    assert seen[0].headers["X-Keenable-Title"] == "Keenable SDK (Python)"


def test_api_key_switches_to_the_keyed_endpoint() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=SEARCH_BODY)

    keenable = Keenable(
        "keen_test", client=httpx.Client(transport=httpx.MockTransport(handler))
    )
    keenable.search("hello")

    assert keenable.keyless is False
    assert seen[0].url.path == "/v1/search"
    assert seen[0].headers["X-API-Key"] == "keen_test"


def test_to_context_numbers_results_and_respects_the_budget() -> None:
    keenable, _ = _client(_ok(SEARCH_BODY))
    response = keenable.search("wafer scale engine")

    context = response.to_context()
    assert context.startswith("[1] How Cerebras works (https://cerebras.ai/chip)")
    assert "[2] MoE guide" in context

    # A budget that only fits the first block drops the second one whole.
    trimmed = response.to_context(max_chars=120)
    assert "[1]" in trimmed
    assert "[2]" not in trimmed
    assert trimmed.endswith("memory.")


def test_to_context_max_results() -> None:
    keenable, _ = _client(_ok(SEARCH_BODY))
    context = keenable.search("q").to_context(max_results=1)
    assert "[2]" not in context


def test_fetch_returns_markdown() -> None:
    keenable, seen = _client(_ok(FETCH_BODY))
    page = keenable.fetch("https://example.com")

    assert seen[0].url.path == "/v1/fetch/public"
    assert seen[0].url.params["url"] == "https://example.com"
    assert page.title == "Example Domain"
    assert page.content.startswith("# Example Domain")


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8080/admin",
        "http://127.0.0.1/",
        "https://169.254.169.254/latest/meta-data/",
        "file:///etc/passwd",
        "https://metadata.google.internal/",
    ],
)
def test_fetch_refuses_internal_targets_before_sending(url: str) -> None:
    keenable, seen = _client(_ok(FETCH_BODY))
    with pytest.raises(KeenableInvalidRequestError):
        keenable.fetch(url)
    assert seen == []


def test_empty_query_is_rejected_locally() -> None:
    keenable, seen = _client(_ok(SEARCH_BODY))
    with pytest.raises(KeenableInvalidRequestError):
        keenable.search("   ")
    assert seen == []


def test_rate_limit_and_auth_errors_carry_the_api_message() -> None:
    keenable, _ = _client(
        lambda request: httpx.Response(429, json={"message": "hourly cap reached"})
    )
    with pytest.raises(KeenableRateLimitError) as excinfo:
        keenable.search("q")
    assert excinfo.value.status_code == 429
    assert "hourly cap reached" in str(excinfo.value)

    keenable, _ = _client(
        lambda request: httpx.Response(401, json={"error": "bad key"})
    )
    with pytest.raises(KeenableAuthError):
        keenable.search("q")


def test_bad_base_url_is_rejected() -> None:
    with pytest.raises(KeenableInvalidRequestError):
        Keenable(base_url="ftp://api.keenable.ai")
    with pytest.raises(KeenableInvalidRequestError):
        Keenable(base_url="http://api.keenable.ai")  # plain http off-localhost


def test_run_tool_call_dispatches_search_and_fetch() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.startswith("/v1/search"):
            return httpx.Response(200, json=SEARCH_BODY)
        return httpx.Response(200, json=FETCH_BODY)

    keenable = Keenable(client=httpx.Client(transport=httpx.MockTransport(handler)))

    searched = run_tool_call(
        keenable, "keenable_search", '{"query": "wafer scale", "site": "cerebras.ai"}'
    )
    assert searched.startswith("[1] How Cerebras works")

    fetched = run_tool_call(keenable, "keenable_fetch", {"url": "https://example.com"})
    assert fetched.startswith("# Example Domain")

    with pytest.raises(KeenableInvalidRequestError):
        run_tool_call(keenable, "keenable_search", "not json")
    with pytest.raises(KeenableInvalidRequestError):
        run_tool_call(keenable, "nope", "{}")


async def test_async_client_mirrors_the_sync_one() -> None:
    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, json=SEARCH_BODY)
    )
    async with AsyncKeenable(client=httpx.AsyncClient(transport=transport)) as keenable:
        response = await keenable.search("wafer scale engine")
    assert [r.title for r in response] == ["How Cerebras works", "MoE guide"]
