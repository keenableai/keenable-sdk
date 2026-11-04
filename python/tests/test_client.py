"""Unit tests for the Keenable client, run against a mock transport."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from keenable import (
    AsyncKeenable,
    Keenable,
    KeenableAPIError,
    KeenableAuthError,
    KeenableConnectionError,
    KeenableCreditsError,
    KeenableForbiddenError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
    KeenableValidationError,
    arun_tool_call,
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
            "snippet": "The WSE keeps the whole model\nin on-chip memory.",
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

Handler = Any
Seen = list[httpx.Request]


def _recording(handler: Handler, seen: Seen) -> Handler:
    """Wrap a response handler so every request it serves is logged."""

    def _record(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    return _record


def _client(
    handler: Handler,
    api_key: str | None = None,
    client_source: str = "Keenable SDK",
) -> tuple[Keenable, Seen]:
    """A Keenable client wired to a mock transport, plus the request log."""
    seen: Seen = []
    transport = httpx.MockTransport(_recording(handler, seen))
    client = Keenable(
        api_key,
        client_source=client_source,
        client=httpx.Client(transport=transport),
    )
    return client, seen


def _aclient(
    handler: Handler, api_key: str | None = None
) -> tuple[AsyncKeenable, Seen]:
    """The async sibling of :func:`_client`, sharing its request log shape."""
    seen: Seen = []
    transport = httpx.MockTransport(_recording(handler, seen))
    return AsyncKeenable(api_key, client=httpx.AsyncClient(transport=transport)), seen


def _ok(body: dict[str, Any], status: int = 200) -> Handler:
    return lambda request: httpx.Response(status, json=body)


def _routed(request: httpx.Request) -> httpx.Response:
    """Serve whichever endpoint was asked for."""
    if request.url.path.startswith("/v1/search"):
        return httpx.Response(200, json=SEARCH_BODY)
    return httpx.Response(200, json=FETCH_BODY)


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


def test_search_sends_max_results_and_query_time() -> None:
    keenable, seen = _client(_ok(SEARCH_BODY))
    keenable.search("un security council", max_results=25, query_time="2026-05-01")

    payload = json.loads(seen[0].content)
    assert payload["max_results"] == 25
    assert payload["query_time"] == "2026-05-01"


def test_keyless_client_uses_public_endpoint_and_identifies_itself() -> None:
    keenable, seen = _client(_ok(SEARCH_BODY))
    keenable.search("hello")

    assert keenable.keyless is True
    assert seen[0].url.path == "/v1/search/public"
    assert "X-API-Key" not in seen[0].headers
    # The public tier rejects requests without this header.
    assert seen[0].headers["X-Keenable-Title"] == "Keenable SDK"
    assert seen[0].headers["Accept"] == "application/json"


def test_client_source_is_overridable_for_wrapping_integrations() -> None:
    keenable, seen = _client(_ok(SEARCH_BODY), client_source="Acme Agent")
    keenable.search("hello")

    assert seen[0].headers["X-Keenable-Title"] == "Acme Agent"


def test_api_key_switches_to_the_keyed_endpoint() -> None:
    keenable, seen = _client(_ok(SEARCH_BODY), api_key="keen_test")
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
    # Snippets are raw page text; their newlines would otherwise collide with
    # the blank line that separates one source from the next.
    assert "The WSE keeps the whole model in on-chip memory." in context

    # A budget that only fits the first block drops the second one whole.
    trimmed = response.to_context(max_chars=120)
    assert "[1]" in trimmed
    assert "[2]" not in trimmed
    assert trimmed.endswith("memory.")

    assert response.to_context(max_results=1) == trimmed


def test_to_context_stops_at_the_first_result_that_does_not_fit() -> None:
    """Citation numbers stay contiguous: no [1] followed by [3].

    An oversized middle result ends the block rather than being skipped over,
    because a gap in the numbering breaks the mapping from the model's
    citations back to the results.
    """
    body = {
        "query": "q",
        "results": [
            {"title": "First", "url": "https://example.com/1", "snippet": "short"},
            {"title": "Second", "url": "https://example.com/2", "snippet": "x" * 500},
            {"title": "Third", "url": "https://example.com/3", "snippet": "also short"},
        ],
    }
    keenable, _ = _client(_ok(body))
    context = keenable.search("q").to_context(max_chars=120)

    assert "[1] First" in context
    assert "[2]" not in context
    assert "Third" not in context


def test_cited_reports_the_results_that_were_rendered() -> None:
    keenable, _ = _client(_ok(SEARCH_BODY))
    response = keenable.search("wafer scale engine")

    assert [r.title for r in response.cited()] == ["How Cerebras works", "MoE guide"]
    # Whatever the budget keeps is what to_context numbered, so a caller can
    # print a source list that matches the model's citations.
    assert [r.title for r in response.cited(max_chars=120)] == ["How Cerebras works"]


def test_fetch_returns_markdown() -> None:
    keenable, seen = _client(_ok(FETCH_BODY))
    page = keenable.fetch("https://example.com")

    assert seen[0].url.path == "/v1/fetch/public"
    assert seen[0].url.params["url"] == "https://example.com"
    assert page.title == "Example Domain"
    assert page.content.startswith("# Example Domain")


def test_page_to_context_is_citable_like_search_results() -> None:
    keenable, _ = _client(_ok(FETCH_BODY))
    page = keenable.fetch("https://example.com")

    context = page.to_context()
    assert context.startswith("[1] Example Domain (https://example.com/)")
    assert "This domain is for use in examples." in context
    # One document, so an oversized page is cut rather than dropped entirely.
    assert page.to_context(max_chars=60).startswith("[1] Example Domain")


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:8080/admin",
        "http://127.0.0.1/",
        "https://169.254.169.254/latest/meta-data/",
        "file:///etc/passwd",
        "https://metadata.google.internal/",
        # A trailing dot resolves to the same host without matching it as a
        # string, and IPv4-mapped IPv6 reaches the same address as the bare v4
        # form. Both are ways past a naive blocklist.
        "https://localhost./",
        "https://metadata.google.internal./",
        "https://[::ffff:169.254.169.254]/latest/meta-data/",
        "https://[::ffff:127.0.0.1]/",
        "https://[::ffff:10.0.0.1]/",
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
    keenable, _ = _client(_ok({"message": "hourly cap reached"}, status=429))
    with pytest.raises(KeenableRateLimitError) as excinfo:
        keenable.search("q")
    assert excinfo.value.status_code == 429
    assert "hourly cap reached" in str(excinfo.value)

    keenable, _ = _client(_ok({"error": "bad key"}, status=401))
    with pytest.raises(KeenableAuthError):
        keenable.search("q")


def _replying(
    status: int, body: dict[str, Any], headers: dict[str, str] | None = None
) -> Handler:
    def _reply(request: httpx.Request) -> httpx.Response:
        return httpx.Response(status, json=body, headers=headers or {})

    return _reply


@pytest.mark.parametrize(
    ("status", "error", "message", "expected", "hint_part"),
    [
        (
            400,
            "Invalid parameter",
            '"max_results": must be an integer between 1 and 50',
            KeenableValidationError,
            "retrying unchanged fails",
        ),
        (422, "Unprocessable", "bad body", KeenableValidationError, "Fix the"),
        (
            401,
            "Authentication failed",
            "Malformed API key",
            KeenableAuthError,
            "KEENABLE_API_KEY",
        ),
        (
            402,
            "Payment required",
            "out of credits",
            KeenableCreditsError,
            "Add credits",
        ),
        (
            403,
            "Forbidden",
            'mode "webql" requires authentication',
            KeenableForbiddenError,
            "This needs an API key",
        ),
        (503, "Unavailable", "try later", KeenableAPIError, "safe to repeat"),
    ],
)
def test_api_errors_map_by_status_and_carry_the_api_fields(
    status: int,
    error: str,
    message: str,
    expected: type[KeenableAPIError],
    hint_part: str,
) -> None:
    body = {"error": error, "message": message, "details": {"param": "x"}}
    keenable, _ = _client(_replying(status, body, {"X-Request-Id": "req-123"}))
    with pytest.raises(expected) as excinfo:
        keenable.search("q")
    err = excinfo.value
    assert type(err) is expected
    assert err.status_code == status
    assert err.body == message
    assert err.api_error == error
    assert err.details == {"param": "x"}
    assert err.request_id == "req-123"
    assert err.hint is not None and hint_part in err.hint
    # One line a reader can act on: what failed, the request id, the next step.
    text = str(err)
    assert message in text and "(request_id: req-123)" in text
    assert text.endswith(err.hint)


def test_missing_page_says_check_the_url_without_a_double_period() -> None:
    body = {"error": "Not found", "message": "The page does not exist at this URL."}
    keenable, _ = _client(_replying(404, body))
    with pytest.raises(KeenableAPIError) as excinfo:
        keenable.fetch("https://example.com/missing")
    err = excinfo.value
    assert err.hint == "Check the URL; retrying unchanged fails the same way."
    assert str(err) == (
        "Keenable API error (404): The page does not exist at this URL. "
        "Check the URL; retrying unchanged fails the same way."
    )
    assert err.body == "The page does not exist at this URL."  # body untouched


def test_forbidden_is_still_an_auth_error_for_existing_handlers() -> None:
    keenable, _ = _client(_replying(403, {"error": "Forbidden", "message": "no"}))
    with pytest.raises(KeenableAuthError) as excinfo:
        keenable.search("q")
    assert isinstance(excinfo.value, KeenableForbiddenError)
    assert "authentication failed" not in str(excinfo.value)


def test_forbidden_hint_depends_on_whether_a_key_is_set() -> None:
    keyed, _ = _client(_replying(403, {"message": "no"}), api_key="keen_x")
    with pytest.raises(KeenableForbiddenError) as excinfo:
        keyed.search("q")
    assert "KEENABLE_API_KEY" not in (excinfo.value.hint or "")
    assert "plan" in (excinfo.value.hint or "")


def test_rate_limit_error_reads_the_rate_limit_headers() -> None:
    headers = {
        "X-RateLimit-Limit": "1000",
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": "2026-11-02T19:48:53.100Z",
    }
    keyless, _ = _client(_replying(429, {"message": "cap"}, headers))
    with pytest.raises(KeenableRateLimitError) as excinfo:
        keyless.search("q")
    err = excinfo.value
    assert (err.limit, err.remaining, err.reset) == (
        1000,
        0,
        "2026-11-02T19:48:53.100Z",
    )
    assert "Retry after 2026-11-02T19:48:53.100Z" in str(err)
    assert "KEENABLE_API_KEY" in str(err)

    keyed, _ = _client(_replying(429, {"message": "cap"}, headers), api_key="keen_x")
    with pytest.raises(KeenableRateLimitError) as excinfo:
        keyed.search("q")
    # A caller who already has a key must not be told to set one.
    assert "KEENABLE_API_KEY" not in str(excinfo.value)


def test_api_key_never_appears_in_error_messages() -> None:
    keenable, _ = _client(_replying(401, {"message": "bad"}), api_key="keen_secret")
    with pytest.raises(KeenableAuthError) as excinfo:
        keenable.search("q")
    assert "keen_secret" not in str(excinfo.value)


def test_responses_carry_the_request_id() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        body = SEARCH_BODY if request.url.path.endswith("search/public") else FETCH_BODY
        return httpx.Response(200, json=body, headers={"X-Request-Id": "req-ok"})

    keenable, _ = _client(handler)
    assert keenable.search("q").request_id == "req-ok"
    assert keenable.fetch("https://example.com/").request_id == "req-ok"


def test_connection_errors_say_retrying_is_safe() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("dns failure", request=request)

    keenable, _ = _client(handler)
    with pytest.raises(KeenableConnectionError, match="Retrying is safe"):
        keenable.search("q")

    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    # A client the SDK built itself: its own timeout= is the knob to raise.
    keenable = Keenable(timeout=5)
    keenable._client = httpx.Client(transport=httpx.MockTransport(slow))
    with pytest.raises(KeenableConnectionError, match=r"within 5s.*raise timeout="):
        keenable.search("q")


def test_response_dataclasses_keep_their_positional_order() -> None:
    # raw stays the fifth/eighth positional field, as before request_id existed.
    from keenable import Page, SearchResponse

    resp = SearchResponse("q", [], "pro", {"k": 1})
    assert resp.raw == {"k": 1} and resp.request_id is None
    page = Page("https://a.example/", "t", "c", None, None, None, {"k": 1})
    assert page.raw == {"k": 1} and page.request_id is None


def test_malformed_success_reply_keeps_the_request_id_in_the_message() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, text="<html>", headers={"X-Request-Id": "req-bad"})

    keenable, _ = _client(handler)
    with pytest.raises(KeenableAPIError) as excinfo:
        keenable.search("q")
    assert "(request_id: req-bad)" in str(excinfo.value)
    assert excinfo.value.request_id == "req-bad"


def test_timeout_message_points_at_the_callers_own_client() -> None:
    def slow(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    keenable = Keenable(client=httpx.Client(transport=httpx.MockTransport(slow)))
    with pytest.raises(KeenableConnectionError) as excinfo:
        keenable.search("q")
    assert "httpx client you passed" in str(excinfo.value)
    assert "timeout=" not in str(excinfo.value)


def test_bad_base_url_is_rejected() -> None:
    with pytest.raises(KeenableInvalidRequestError):
        Keenable(base_url="ftp://api.keenable.ai")
    with pytest.raises(KeenableInvalidRequestError):
        Keenable(base_url="http://api.keenable.ai")  # plain http off-localhost


def test_run_tool_call_dispatches_search_and_fetch() -> None:
    keenable, seen = _client(_routed)

    searched = run_tool_call(
        keenable, "keenable_search", '{"query": "wafer scale", "site": "cerebras.ai"}'
    )
    assert searched.startswith("[1] How Cerebras works")
    assert json.loads(seen[0].content)["site"] == "cerebras.ai"

    fetched = run_tool_call(keenable, "keenable_fetch", {"url": "https://example.com"})
    # Both tools render the same citable shape, so a model can cite either.
    assert fetched.startswith("[1] Example Domain (https://example.com/)")

    with pytest.raises(KeenableInvalidRequestError):
        run_tool_call(keenable, "keenable_search", "not json")
    with pytest.raises(KeenableInvalidRequestError):
        run_tool_call(keenable, "nope", "{}")


@pytest.mark.parametrize("arguments", [123, None, [], b"{}"])
def test_tool_arguments_of_the_wrong_type_stay_inside_the_error_contract(
    arguments: Any,
) -> None:
    """A caller catching KeenableError should never see a raw TypeError."""
    keenable, _ = _client(_routed)
    with pytest.raises(KeenableInvalidRequestError):
        run_tool_call(keenable, "keenable_search", arguments)


def test_tool_call_forwards_only_the_filters_the_schema_offers() -> None:
    keenable, seen = _client(_routed)
    run_tool_call(
        keenable,
        "keenable_search",
        {"query": "q", "site": "cerebras.ai", "acquired_after": "2026-01-01"},
    )

    payload = json.loads(seen[0].content)
    assert payload["site"] == "cerebras.ai"
    # acquired_after is a real client filter but is not in the tool schema, so
    # a model cannot reach past the subset it was offered.
    assert "acquired_after" not in payload


def test_tool_schema_keeps_max_results_and_query_time_out() -> None:
    from keenable import TOOLS

    search = next(t for t in TOOLS if t["function"]["name"] == "keenable_search")
    props = search["function"]["parameters"]["properties"]
    assert "max_results" not in props
    assert "query_time" not in props


async def test_async_client_mirrors_the_sync_one() -> None:
    keenable, seen = _aclient(_routed)
    async with keenable:
        response = await keenable.search("wafer scale engine")
        rendered = await arun_tool_call(
            keenable, "keenable_fetch", {"url": "https://example.com"}
        )

    assert [r.title for r in response] == ["How Cerebras works", "MoE guide"]
    assert rendered.startswith("[1] Example Domain")
    assert seen[0].url.path == "/v1/search/public"
    assert seen[0].headers["X-Keenable-Title"] == "Keenable SDK"
