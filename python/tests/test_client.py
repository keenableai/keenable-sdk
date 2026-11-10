"""Unit tests for the Keenable client, run against a mock transport."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import httpx
import pytest

from keenable import (
    TOOLS,
    AsyncKeenable,
    Keenable,
    KeenableAuthError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
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
        max_retries=0,
    )
    return client, seen


def _aclient(
    handler: Handler, api_key: str | None = None
) -> tuple[AsyncKeenable, Seen]:
    """The async sibling of :func:`_client`, sharing its request log shape."""
    seen: Seen = []
    transport = httpx.MockTransport(_recording(handler, seen))
    return AsyncKeenable(
        api_key, client=httpx.AsyncClient(transport=transport), max_retries=0
    ), seen


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


@pytest.mark.parametrize(
    "make",
    [
        lambda: (d for d in ["un.org", "who.int"]),
        lambda: {"un.org"},
        lambda: {"un.org": 1, "who.int": 2}.keys(),
    ],
    ids=["generator", "set", "dict_keys"],
)
def test_search_sends_any_iterable_as_an_array(make: Any) -> None:
    keenable, seen = _client(_ok(SEARCH_BODY))
    expected = list(make())
    keenable.search("q", exclude_domains=make())

    payload = json.loads(seen[0].content)
    assert payload["exclude_domains"] == expected


def test_search_sends_a_mapping_unchanged() -> None:
    keenable, seen = _client(_ok(SEARCH_BODY))
    keenable.search("q", exclude_domains={"un.org": True})

    payload = json.loads(seen[0].content)
    assert payload["exclude_domains"] == {"un.org": True}


class _ArrayLike:
    """Iterable, but ambiguous as a truth value or in ``==``, like numpy."""

    def __init__(self, items: list[str]) -> None:
        self._items = items

    def __iter__(self) -> Iterator[str]:
        return iter(self._items)

    def __eq__(self, other: object) -> bool:
        raise ValueError("ambiguous")

    def __bool__(self) -> bool:
        raise ValueError("ambiguous")


def test_search_and_tool_call_accept_an_array_like() -> None:
    keenable, seen = _client(_routed)
    keenable.search("q", exclude_domains=_ArrayLike(["un.org"]))
    run_tool_call(
        keenable,
        "keenable_search",
        {"query": "q", "exclude_domains": _ArrayLike(["who.int"])},
    )

    direct, tool = (json.loads(r.content) for r in seen)
    assert direct["exclude_domains"] == ["un.org"]
    assert tool["exclude_domains"] == ["who.int"]


@pytest.mark.parametrize(
    "value",
    [[float("nan")], [object()], [b"x.com"], b"x.com", bytearray(b"x.com")],
    ids=["nan", "object", "bytes-entry", "bytes", "bytearray"],
)
def test_an_unencodable_domain_list_is_an_invalid_request(value: Any) -> None:
    keenable, seen = _client(_routed)
    with pytest.raises(KeenableInvalidRequestError, match="could not encode"):
        keenable.search("q", exclude_domains=value)
    with pytest.raises(KeenableInvalidRequestError, match="could not encode"):
        run_tool_call(
            keenable, "keenable_search", {"query": "q", "exclude_domains": value}
        )
    assert seen == []


async def test_async_an_unencodable_domain_list_is_an_invalid_request() -> None:
    keenable, seen = _aclient(_routed)
    async with keenable:
        with pytest.raises(KeenableInvalidRequestError):
            await arun_tool_call(
                keenable, "keenable_search", {"query": "q", "exclude_domains": [b"x"]}
            )
    assert seen == []


def test_search_raw_keeps_the_filter_warning() -> None:
    body = {**SEARCH_BODY, "warning": "3 results were removed by your domain filter"}
    keenable, _ = _client(_ok(body))
    response = keenable.search("q", exclude_domains=["spam.com"])

    assert response.raw["warning"] == "3 results were removed by your domain filter"
    assert response.raw["results"] == SEARCH_BODY["results"]


async def test_async_search_raw_keeps_the_filter_warning() -> None:
    body = {**SEARCH_BODY, "warning": "3 results were removed by your domain filter"}
    keenable, _ = _aclient(_ok(body))
    async with keenable:
        response = await keenable.search("q", exclude_domains=["spam.com"])

    assert response.raw["warning"] == "3 results were removed by your domain filter"


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


def test_tool_schema_offers_site_and_exclude_domains() -> None:
    search = next(t for t in TOOLS if t["function"]["name"] == "keenable_search")
    props = search["function"]["parameters"]["properties"]
    assert props["exclude_domains"]["type"] == "array"
    assert props["exclude_domains"]["items"] == {"type": "string"}
    assert props["site"]["type"] == "string"


def test_tool_schema_offers_disable_cards_as_a_boolean() -> None:
    search = next(t for t in TOOLS if t["function"]["name"] == "keenable_search")
    props = search["function"]["parameters"]["properties"]
    assert props["disable_cards"]["type"] == "boolean"
    assert "cards" in props["disable_cards"]["description"]


def test_disable_cards_is_sent_only_as_true() -> None:
    keenable, seen = _client(_routed)
    keenable.search("q", disable_cards=True)
    keenable.search("q", disable_cards=False)
    keenable.search("q")
    sent = [json.loads(request.content) for request in seen]
    assert sent[0] == {"query": "q", "mode": "pro", "disable_cards": True}
    assert "disable_cards" not in sent[1]
    assert "disable_cards" not in sent[2]


@pytest.mark.parametrize("value", ["true", 1, 0, "false", [True]])
def test_disable_cards_rejects_a_non_boolean_before_sending(value: Any) -> None:
    keenable, seen = _client(_routed)
    with pytest.raises(KeenableInvalidRequestError, match="disable_cards"):
        keenable.search("q", disable_cards=value)
    assert seen == []


async def test_async_search_sends_disable_cards() -> None:
    keenable, seen = _aclient(_routed)
    async with keenable:
        await keenable.search("q", mode="realtime", disable_cards=True)
    assert json.loads(seen[0].content) == {
        "query": "q",
        "mode": "realtime",
        "disable_cards": True,
    }


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


async def test_async_search_matches_the_sync_payloads() -> None:
    generator: Any = (d for d in ["spam.com"])
    a_set: Any = {"export.arxiv.org"}
    keenable, seen = _aclient(_routed)
    async with keenable:
        await keenable.search("q", exclude_domains=generator)
        await keenable.search("q", exclude_domains=[])
        await keenable.search("q", site="arxiv.org", exclude_domains=a_set)
        await keenable.search("q", exclude_domains="x")
        await keenable.search("q", exclude_domains="")

    from_generator, empty_exclude, mixed, lone, blank = (
        json.loads(r.content) for r in seen
    )
    assert from_generator["exclude_domains"] == ["spam.com"]
    assert empty_exclude["exclude_domains"] == []
    assert mixed["site"] == "arxiv.org"
    assert mixed["exclude_domains"] == ["export.arxiv.org"]
    assert lone["exclude_domains"] == ["x"]
    assert blank["exclude_domains"] == [""]
