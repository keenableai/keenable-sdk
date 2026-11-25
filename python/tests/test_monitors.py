"""Unit tests for keenable.monitors and verify_webhook, on a mock transport."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
from typing import Any

import httpx
import pytest

from keenable import (
    AsyncKeenable,
    Keenable,
    KeenableAPIError,
    KeenableAuthError,
    KeenableInvalidRequestError,
    WebhookVerificationError,
    verify_webhook,
)
from keenable import client as client_module

MONITOR: dict[str, Any] = {
    "id": "mon_1",
    "object": "monitor",
    "name": "LLM releases",
    "status": "active",
    "search": {
        "query": "new open-weights LLM releases",
        "max_results": 10,
        "include_domains": None,
        "exclude_domains": ["example.com"],
        "content": {"text": True},
    },
    "schedule": {"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
    "output_schema": None,
    "webhook": {
        "url": "https://hooks.example.com/k",
        "events": ["monitor.result.found"],
        "secret": "whsec_abc",
    },
    "metadata": {"team": "research"},
    "last_run_at": None,
    "next_run_at": "2026-11-18T08:00:00Z",
    "upcoming_runs": ["2026-11-18T08:00:00Z", "2026-11-19T08:00:00Z"],
    "created_at": "2026-11-17T10:00:00Z",
    "updated_at": "2026-11-17T10:00:00Z",
}

RESULT: dict[str, Any] = {
    "url": "https://example.org/a",
    "title": "A model",
    "author": None,
    "published_at": "2026-11-17T09:00:00Z",
    "acquired_at": "2026-11-17T09:05:00Z",
    "image": None,
    "matched_at": "2026-11-17T09:10:00Z",
    "published_at_source": "declared",
    "summary": "A lab released a model.",
    "importance": 4,
    "kind": "news",
    "source_type": "original",
}

RUN: dict[str, Any] = {
    "id": "mrun_1",
    "object": "monitor_run",
    "monitor_id": "mon_1",
    "status": "completed",
    "results": [RESULT],
    "changes": None,
    "output": {"structured": {"n": 1}, "text": None, "grounding": []},
    "error": None,
    "created_at": "2026-11-17T10:00:00Z",
    "started_at": "2026-11-17T10:00:01Z",
    "ended_at": "2026-11-17T10:00:09Z",
}


def _client(
    replies: list[httpx.Response], api_key: str | None = "k", retries: int = 0
) -> tuple[Keenable, list[httpx.Request]]:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return replies[min(len(seen), len(replies)) - 1]

    client = Keenable(
        api_key,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        max_retries=retries,
    )
    return client, seen


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(client_module.time, "sleep", lambda _: None)

    async def fake(_: float) -> None:
        return None

    monkeypatch.setattr(client_module.asyncio, "sleep", fake)
    monkeypatch.delenv("KEENABLE_API_URL", raising=False)


def test_create_sends_the_body_and_an_idempotency_key() -> None:
    keenable, seen = _client([httpx.Response(201, json=MONITOR)])
    monitor = keenable.monitors.create(
        search={
            "query": "new open-weights LLM releases",
            "exclude_domains": ("x.com",),
        },
        name="LLM releases",
        schedule={"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
        webhook={
            "url": "https://hooks.example.com/k",
            "events": ["monitor.result.found"],
        },
        metadata={"team": "research"},
    )
    request = seen[0]
    assert request.method == "POST"
    assert str(request.url) == "https://api.keenable.ai/v1/monitors"
    assert request.headers["X-API-Key"] == "k"
    assert len(request.headers["Idempotency-Key"]) == 36
    assert json.loads(request.content) == {
        "search": {
            "query": "new open-weights LLM releases",
            "exclude_domains": ["x.com"],
        },
        "name": "LLM releases",
        "schedule": {
            "type": "cron",
            "value": "0 9 * * 1-5",
            "timezone": "Europe/Paris",
        },
        "webhook": {
            "url": "https://hooks.example.com/k",
            "events": ["monitor.result.found"],
        },
        "metadata": {"team": "research"},
    }
    assert monitor.id == "mon_1"
    assert monitor.search.content_text is True
    assert monitor.search.exclude_domains == ["example.com"]
    assert monitor.schedule is not None and monitor.schedule.timezone == "Europe/Paris"
    assert monitor.webhook is not None and monitor.webhook.secret == "whsec_abc"
    assert monitor.metadata == {"team": "research"}
    assert monitor.upcoming_runs[0] == "2026-11-18T08:00:00Z"
    assert not hasattr(monitor, "estimated_cost_usd")
    assert not hasattr(monitor, "agent_run_id")


def test_create_retries_with_the_same_idempotency_key() -> None:
    keenable, seen = _client(
        [httpx.Response(503, json={}), httpx.Response(201, json=MONITOR)], retries=2
    )
    keenable.monitors.create(search={"query": "q"}, idempotency_key="key-1")
    assert len(seen) == 2
    assert {r.headers["Idempotency-Key"] for r in seen} == {"key-1"}


def test_each_create_gets_its_own_key() -> None:
    keenable, seen = _client([httpx.Response(201, json=MONITOR)])
    keenable.monitors.create(search={"query": "q"})
    keenable.monitors.create(search={"query": "q"})
    assert seen[0].headers["Idempotency-Key"] != seen[1].headers["Idempotency-Key"]


def test_create_needs_a_query() -> None:
    keenable, seen = _client([httpx.Response(201, json=MONITOR)])
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.create(search={"query": " "})
    assert seen == []


def test_monitors_need_a_key_and_send_nothing_without_one(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("KEENABLE_API_KEY", raising=False)
    keenable, seen = _client([httpx.Response(200, json=MONITOR)], api_key=None)
    with pytest.raises(KeenableAuthError) as info:
        keenable.monitors.get("mon_1")
    assert info.value.code == "missing_api_key"
    assert info.value.status_code == 401
    assert seen == []


def test_list_sends_filters_and_parses_the_page() -> None:
    body = {"data": [MONITOR], "has_more": True, "next_cursor": "mon_1"}
    keenable, seen = _client([httpx.Response(200, json=body)])
    page = keenable.monitors.list(
        status="active", name="LLM", limit=1, metadata={"team": "research"}
    )
    assert seen[0].url.path == "/v1/monitors"
    assert dict(seen[0].url.params) == {
        "status": "active",
        "name": "LLM",
        "limit": "1",
        "metadata[team]": "research",
    }
    assert page.has_more and page.next_cursor == "mon_1"
    assert [m.id for m in page] == ["mon_1"]


def test_list_all_follows_the_cursor() -> None:
    second = dict(MONITOR, id="mon_2")
    keenable, seen = _client(
        [
            httpx.Response(
                200, json={"data": [MONITOR], "has_more": True, "next_cursor": "c1"}
            ),
            httpx.Response(
                200, json={"data": [second], "has_more": False, "next_cursor": None}
            ),
        ]
    )
    assert [m.id for m in keenable.monitors.list_all(limit=1)] == ["mon_1", "mon_2"]
    assert "cursor" not in seen[0].url.params
    assert seen[1].url.params["cursor"] == "c1"


def test_get_delete_and_the_paths() -> None:
    keenable, seen = _client([httpx.Response(200, json=MONITOR)])
    keenable.monitors.get("mon/1")
    keenable.monitors.delete("mon_1")
    assert seen[0].url.raw_path == b"/v1/monitors/mon%2F1"
    assert seen[1].method == "DELETE" and seen[1].url.path == "/v1/monitors/mon_1"


def test_update_sends_only_what_was_given_and_null_removes() -> None:
    keenable, seen = _client([httpx.Response(200, json=MONITOR)])
    keenable.monitors.update(
        "mon_1", name="New", schedule=None, search={"max_results": 5}
    )
    assert seen[0].method == "PATCH"
    assert json.loads(seen[0].content) == {
        "name": "New",
        "schedule": None,
        "search": {"max_results": 5},
    }


def test_pause_and_resume() -> None:
    keenable, seen = _client([httpx.Response(200, json=MONITOR)])
    keenable.monitors.pause("mon_1")
    keenable.monitors.resume("mon_1")
    assert [json.loads(r.content) for r in seen] == [
        {"status": "paused"},
        {"status": "active"},
    ]


@pytest.mark.parametrize("status", [500, 503])
def test_update_trigger_and_bulk_are_not_retried_on_a_5xx(status: int) -> None:
    keenable, seen = _client([httpx.Response(status, json={})], retries=2)
    with pytest.raises(KeenableAPIError):
        keenable.monitors.update("mon_1", name="x")
    with pytest.raises(KeenableAPIError):
        keenable.monitors.trigger("mon_1")
    with pytest.raises(KeenableAPIError):
        keenable.monitors.bulk("pause", ids=["mon_1"])
    assert len(seen) == 3


def test_a_trigger_is_retried_on_a_429() -> None:
    keenable, seen = _client(
        [
            httpx.Response(429, json={}),
            httpx.Response(200, json=dict(RUN, status="queued")),
        ],
        retries=2,
    )
    run = keenable.monitors.trigger("mon_1")
    assert len(seen) == 2
    assert seen[0].method == "POST" and seen[0].url.path == "/v1/monitors/mon_1/trigger"
    assert run.status == "queued"


def test_reads_are_retried_on_a_5xx() -> None:
    keenable, seen = _client(
        [httpx.Response(503, json={}), httpx.Response(200, json=MONITOR)], retries=2
    )
    keenable.monitors.get("mon_1")
    assert len(seen) == 2


def test_runs_and_run() -> None:
    keenable, seen = _client(
        [
            httpx.Response(
                200, json={"data": [RUN], "has_more": False, "next_cursor": None}
            ),
            httpx.Response(200, json=RUN),
        ]
    )
    runs = keenable.monitors.runs("mon_1", limit=5, cursor="r0")
    run = keenable.monitors.run("mon_1", "mrun_1")
    assert seen[0].url.path == "/v1/monitors/mon_1/runs"
    assert dict(seen[0].url.params) == {"limit": "5", "cursor": "r0"}
    assert seen[1].url.path == "/v1/monitors/mon_1/runs/mrun_1"
    assert runs.data[0].id == "mrun_1"
    assert run.results is not None and run.results[0].importance == 4
    assert run.output is not None and run.output.structured == {"n": 1}
    assert run.error is None


def test_results_reads_results() -> None:
    hit = dict(RESULT, id="h1", same_story=2)
    keenable, seen = _client(
        [
            httpx.Response(
                200, json={"data": [hit], "has_more": False, "next_cursor": None}
            )
        ]
    )
    results = keenable.monitors.results("mon_1", min_importance=4, limit=10)
    assert seen[0].url.path == "/v1/monitors/mon_1/results"
    assert dict(seen[0].url.params) == {"limit": "10", "min_importance": "4"}
    assert results.data[0].id == "h1" and results.data[0].same_story == 2
    assert results.data[0].source_type == "original"
    assert not hasattr(results.data[0], "score")


def test_deliveries_stats_and_bulk() -> None:
    delivery = {
        "id": "evt_1",
        "type": "monitor.result.found",
        "url": "https://hooks.example.com/k",
        "created_at": "2026-11-17T10:00:00Z",
        "attempts": 2,
        "delivered_at": None,
        "last_error": "HTTP 500",
        "next_attempt_at": "2026-11-17T10:05:00Z",
    }
    keenable, seen = _client(
        [
            httpx.Response(
                200, json={"data": [delivery], "has_more": False, "next_cursor": None}
            ),
            httpx.Response(
                200,
                json={
                    "total": 3,
                    "by_status": {"active": 2, "paused": 1},
                    "by_schedule": {"cron": 1, "manual": 2},
                },
            ),
            httpx.Response(
                200,
                json={
                    "action": "pause",
                    "affected": 1,
                    "ids": ["mon_1"],
                    "dry_run": True,
                    "has_more": False,
                    "not_found": ["mon_x"],
                },
            ),
        ]
    )
    deliveries = keenable.monitors.deliveries("mon_1")
    stats = keenable.monitors.stats()
    result = keenable.monitors.bulk(
        "pause",
        ids=["mon_1", "mon_x"],
        filter={"status": "active", "name": "", "metadata": {}},
    )
    assert deliveries.data[0].attempts == 2
    assert deliveries.data[0].last_error == "HTTP 500"
    assert seen[1].url.path == "/v1/monitors/stats"
    assert stats.total == 3 and stats.by_status["active"] == 2
    assert seen[2].url.path == "/v1/monitors/bulk"
    assert json.loads(seen[2].content) == {
        "action": "pause",
        "dry_run": True,
        "ids": ["mon_1", "mon_x"],
        "filter": {"status": "active"},
    }
    assert result.dry_run and result.not_found == ["mon_x"]


def test_bulk_checks_its_arguments() -> None:
    keenable, seen = _client([httpx.Response(200, json={})])
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.bulk("archive", ids=["mon_1"])  # type: ignore[arg-type]
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.bulk("pause")
    for empty in ({}, {"metadata": {}}, {"status": "", "name": ""}):
        with pytest.raises(KeenableInvalidRequestError):
            keenable.monitors.bulk("pause", filter=empty)  # type: ignore[arg-type]
    assert seen == []


@pytest.mark.parametrize("monitor_id", [".", ".."])
def test_dot_ids_are_refused(monitor_id: str) -> None:
    keenable, seen = _client([httpx.Response(200, json=MONITOR)])
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.get(monitor_id)
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.delete(monitor_id)
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.runs(monitor_id)
    assert seen == []


def test_api_errors_keep_their_code() -> None:
    body = {
        "error": "Monitor limit reached",
        "type": "permission_error",
        "code": "monitor_limit_reached",
        "message": "This organization has 100 active monitors.",
        "retryable": False,
    }
    keenable, _ = _client([httpx.Response(403, json=body)])
    with pytest.raises(KeenableAuthError) as info:
        keenable.monitors.resume("mon_1")
    assert info.value.code == "monitor_limit_reached"


async def test_the_async_client() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/monitors" and request.method == "GET":
            return httpx.Response(
                200, json={"data": [MONITOR], "has_more": False, "next_cursor": None}
            )
        return httpx.Response(200, json=MONITOR)

    async with AsyncKeenable(
        "k", client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ) as keenable:
        created = await keenable.monitors.create(search={"query": "q"})
        listed = [m.id async for m in keenable.monitors.list_all()]
        await keenable.monitors.pause("mon_1")
    assert created.id == "mon_1"
    assert listed == ["mon_1"]
    assert "Idempotency-Key" in seen[0].headers
    assert seen[2].method == "PATCH"


SECRET = "whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE="
BODY = (
    '{"id":"msg_2nY8kTestVector01","type":"monitor.result.found",'
    '"created_at":"2026-11-17T17:20:00Z","data":{"monitor_id":"mon_test01",'
    '"result":{"url":"https://example.com/news/1","title":"Open weights model '
    'released","author":null,"published_at":"2026-11-17T16:00:00Z",'
    '"acquired_at":"2026-11-17T16:05:00Z","image":null,'
    '"matched_at":"2026-11-17T16:10:00Z",'
    '"published_at_source":"declared","summary":"A lab released an '
    'open-weights model.","importance":4,"kind":"news","source_type":"original"'
    '}},"metadata":{"team":"research"}}'
)
HEADERS = {
    "webhook-id": "msg_2nY8kTestVector01",
    "webhook-timestamp": "1763400000",
    "webhook-signature": "v1,ifN2KIni7msErjuVooGtcP9OlWfUymaJfl41PUpTBMc=",
}


def test_verify_webhook_with_the_known_vector() -> None:
    event = verify_webhook(BODY.encode(), HEADERS, SECRET, now=1763400000)
    assert event.id == "msg_2nY8kTestVector01"
    assert event.type == "monitor.result.found"
    assert event.data.monitor_id == "mon_test01"
    assert event.data.result is not None
    assert event.data.result.url == "https://example.com/news/1"
    assert event.data.result.importance == 4
    assert event.metadata == {"team": "research"}


def test_verify_webhook_takes_a_str_and_httpx_headers() -> None:
    event = verify_webhook(BODY, httpx.Headers(HEADERS), SECRET, now=1763400000)
    assert event.type == "monitor.result.found"


def test_verify_webhook_refuses_a_stale_delivery_by_the_clock() -> None:
    with pytest.raises(WebhookVerificationError):
        verify_webhook(BODY, HEADERS, SECRET)


def test_verify_webhook_refuses_an_empty_secret() -> None:
    with pytest.raises(WebhookVerificationError):
        verify_webhook(BODY, HEADERS, "", now=1763400000)


def test_verify_webhook_refuses_an_empty_key() -> None:
    with pytest.raises(WebhookVerificationError):
        verify_webhook(BODY, HEADERS, "whsec_", now=1763400000)


@pytest.mark.parametrize("tolerance", [math.inf, -math.inf, math.nan, 0, -1])
def test_verify_webhook_refuses_a_tolerance_that_is_not_positive_and_finite(
    tolerance: float,
) -> None:
    with pytest.raises(WebhookVerificationError):
        verify_webhook(BODY, HEADERS, SECRET, tolerance=tolerance, now=1763400000)


@pytest.mark.parametrize("digits", [13, 400, 5000])
def test_verify_webhook_refuses_a_long_timestamp(digits: int) -> None:
    headers = {**HEADERS, "webhook-timestamp": "1" * digits}
    with pytest.raises(WebhookVerificationError, match="not a Unix time"):
        verify_webhook(BODY, headers, SECRET, now=1763400000)


PAGE_MONITOR: dict[str, Any] = dict(
    MONITOR,
    id="mon_p",
    type="page",
    search=None,
    page={
        "url": "https://example.com/pricing",
        "watch_for": "plan prices",
        "sensitivity": "meaningful",
    },
    webhook=None,
    status="disabled",
    disabled_reason={
        "code": "data_policy",
        "message": "The organization turned on zero data retention.",
    },
)

DIFF: dict[str, Any] = {
    "previous_at": "2026-11-17T08:00:00Z",
    "ratio": 0.12,
    "added": ["Pro: $30/month"],
    "removed": ["Pro: $25/month"],
}

PAGE_RUN: dict[str, Any] = dict(
    RUN,
    id="mrun_p",
    monitor_id="mon_p",
    results=[],
    changes={
        "changed": True,
        "notified": True,
        "baseline": False,
        "version": 3,
        "source": "live",
        "summary": "The Pro plan went from $25 to $30 a month.",
        "items": ["Pro: $30/month"],
        "diff": DIFF,
    },
    output={
        "structured": None,
        "text": None,
        "grounding": [],
        "fresh": False,
        "error": {"code": "output_invalid", "message": "missing field price"},
    },
)


def test_create_a_page_monitor() -> None:
    keenable, seen = _client([httpx.Response(201, json=PAGE_MONITOR)])
    monitor = keenable.monitors.create(
        type="page",
        page={
            "url": "https://example.com/pricing",
            "watch_for": "plan prices",
            "sensitivity": "any",
        },
        schedule={"type": "interval", "value": "10m"},
    )
    assert json.loads(seen[0].content) == {
        "type": "page",
        "page": {
            "url": "https://example.com/pricing",
            "watch_for": "plan prices",
            "sensitivity": "any",
        },
        "schedule": {"type": "interval", "value": "10m"},
    }
    assert monitor.type == "page"
    assert monitor.search is None
    assert monitor.page is not None
    assert monitor.page.url == "https://example.com/pricing"
    assert monitor.page.watch_for == "plan prices"
    assert monitor.page.sensitivity == "meaningful"
    assert monitor.disabled_reason is not None
    assert monitor.disabled_reason.code == "data_policy"


def test_a_search_monitor_reads_type_and_no_page() -> None:
    keenable, _ = _client([httpx.Response(200, json=dict(MONITOR, type="search"))])
    monitor = keenable.monitors.get("mon_1")
    assert monitor.type == "search" and monitor.page is None
    assert monitor.search is not None and monitor.search.content_text
    assert monitor.disabled_reason is None


def test_type_search_is_sent_when_given() -> None:
    keenable, seen = _client([httpx.Response(201, json=MONITOR)])
    keenable.monitors.create(type="search", search={"query": "q"})
    assert json.loads(seen[0].content) == {"type": "search", "search": {"query": "q"}}


@pytest.mark.parametrize(
    "kwargs",
    [
        {"type": "page"},
        {"type": "page", "page": {"url": " "}},
        {"type": "page", "page": "https://example.com"},
        {
            "type": "page",
            "page": {"url": "https://example.com"},
            "search": {"query": "q"},
        },
        {"search": {"query": "q"}, "page": {"url": "https://example.com"}},
        {"type": "feed", "search": {"query": "q"}},
        {},
    ],
)
def test_create_checks_the_kind_of_monitor(kwargs: dict[str, Any]) -> None:
    keenable, seen = _client([httpx.Response(201, json=MONITOR)])
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.create(**kwargs)
    assert seen == []


def test_update_sends_page() -> None:
    keenable, seen = _client([httpx.Response(200, json=PAGE_MONITOR)])
    keenable.monitors.update("mon_p", page={"watch_for": None, "sensitivity": "any"})
    assert json.loads(seen[0].content) == {
        "page": {"watch_for": None, "sensitivity": "any"}
    }
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.update("mon_p", page={"url": ""})


def test_a_page_run_has_changes_and_output() -> None:
    keenable, _ = _client([httpx.Response(200, json=PAGE_RUN)])
    run = keenable.monitors.run("mon_p", "mrun_p")
    assert run.results == []
    assert run.changes is not None
    assert run.changes.changed and run.changes.notified and not run.changes.baseline
    assert run.changes.version == 3 and run.changes.source == "live"
    assert run.changes.items == ["Pro: $30/month"]
    assert run.changes.diff is not None and run.changes.diff.ratio == 0.12
    assert run.changes.diff.removed == ["Pro: $25/month"]
    assert run.output is not None and run.output.fresh is False
    assert run.output.error is not None
    assert run.output.error.code == "output_invalid"
    assert run.output.error.message == "missing field price"


def test_a_search_run_has_no_changes_and_fresh_output() -> None:
    keenable, _ = _client([httpx.Response(200, json=RUN)])
    run = keenable.monitors.run("mon_1", "mrun_1")
    assert run.changes is None and not hasattr(run, "usage")
    assert run.output is not None and run.output.fresh and run.output.error is None


def test_an_output_error_as_a_bare_code() -> None:
    body = dict(RUN, output={"structured": None, "error": "output_failed"})
    keenable, _ = _client([httpx.Response(200, json=body)])
    run = keenable.monitors.run("mon_1", "mrun_1")
    assert run.output is not None and run.output.error is not None
    assert run.output.error.code == "output_failed" and run.output.error.message == ""


VERSION: dict[str, Any] = {
    "id": "ver_3",
    "object": "page_version",
    "version": 3,
    "fetched_at": "2026-11-18T08:00:00Z",
    "title": "Pricing",
    "source": "live",
    "notified": True,
    "summary": "The Pro plan went from $25 to $30 a month.",
    "items": ["Pro: $30/month"],
    "diff": DIFF,
}


def test_versions() -> None:
    first = dict(
        VERSION,
        id="ver_1",
        version=1,
        notified=False,
        summary=None,
        items=[],
        diff=None,
    )
    body = {"data": [VERSION, first], "has_more": True, "next_cursor": "ver_1"}
    keenable, seen = _client([httpx.Response(200, json=body)])
    versions = keenable.monitors.versions("mon_p", limit=2, cursor="ver_4")
    assert seen[0].method == "GET"
    assert seen[0].url.path == "/v1/monitors/mon_p/versions"
    assert dict(seen[0].url.params) == {"limit": "2", "cursor": "ver_4"}
    assert versions.has_more and versions.next_cursor == "ver_1"
    newest, oldest = versions.data
    assert newest.version == 3 and newest.source == "live" and newest.notified
    assert newest.diff is not None and newest.diff.added == ["Pro: $30/month"]
    assert oldest.diff is None and oldest.items == []


def test_versions_refuses_dot_ids() -> None:
    keenable, seen = _client([httpx.Response(200, json={})])
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.versions("..")
    assert seen == []


async def test_the_async_client_page_monitors() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path.endswith("/versions"):
            return httpx.Response(
                200, json={"data": [VERSION], "has_more": False, "next_cursor": None}
            )
        return httpx.Response(200, json=PAGE_MONITOR)

    async with AsyncKeenable(
        "k", client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ) as keenable:
        created = await keenable.monitors.create(
            type="page", page={"url": "https://example.com/pricing"}
        )
        updated = await keenable.monitors.update(
            "mon_p", page={"url": "https://example.com/plans"}
        )
        versions = await keenable.monitors.versions("mon_p", limit=1)
    assert created.page is not None and updated.type == "page"
    assert json.loads(seen[0].content) == {
        "type": "page",
        "page": {"url": "https://example.com/pricing"},
    }
    assert json.loads(seen[1].content) == {"page": {"url": "https://example.com/plans"}}
    assert seen[2].url.path == "/v1/monitors/mon_p/versions"
    assert versions.data[0].id == "ver_3"


def _sign(body: str, msg_id: str, stamp: str) -> dict[str, str]:
    key = base64.b64decode(SECRET[len("whsec_") :])
    mac = hmac.new(key, f"{msg_id}.{stamp}.{body}".encode(), hashlib.sha256)
    return {
        "webhook-id": msg_id,
        "webhook-timestamp": stamp,
        "webhook-signature": "v1," + base64.b64encode(mac.digest()).decode(),
    }


def test_verify_webhook_reads_a_monitor_page_changed() -> None:
    body = json.dumps(
        {
            "id": "msg_change1",
            "type": "monitor.page.changed",
            "created_at": "2026-11-18T08:00:05Z",
            "data": {"monitor_id": "mon_p", "run": PAGE_RUN},
            "metadata": None,
        }
    )
    headers = _sign(body, "msg_change1", "1763452805")
    event = verify_webhook(body, headers, SECRET, now=1763452805)
    assert event.type == "monitor.page.changed"
    assert event.data.monitor_id == "mon_p"
    assert event.data.run is not None and event.data.run.changes is not None
    assert (
        event.data.run.changes.summary == "The Pro plan went from $25 to $30 a month."
    )
    assert event.data.result is None and event.data.monitor is None


PREVIEW_RESULT: dict[str, Any] = {
    "title": "Example Labs releases a 70B open-weights model",
    "url": "https://example.com/news/example-70b",
    "published_at": "2026-11-24T08:12:00Z",
}


def test_preview_a_search_monitor() -> None:
    keenable, seen = _client(
        [
            httpx.Response(
                200,
                json={
                    "type": "search",
                    "results": [
                        PREVIEW_RESULT,
                        dict(PREVIEW_RESULT, title=None, published_at=None),
                    ],
                    "page": None,
                },
            )
        ]
    )
    preview = keenable.monitors.preview(
        search={
            "query": "open-weights LLM releases",
            "exclude_domains": ("example.org",),
        }
    )
    assert seen[0].method == "POST" and seen[0].url.path == "/v1/monitors/preview"
    assert "Idempotency-Key" not in seen[0].headers
    assert json.loads(seen[0].content) == {
        "search": {
            "query": "open-weights LLM releases",
            "exclude_domains": ["example.org"],
        }
    }
    assert preview.type == "search" and preview.page is None
    assert preview.results[0].url == "https://example.com/news/example-70b"
    assert preview.results[0].published_at == "2026-11-24T08:12:00Z"
    assert preview.results[1].title is None and preview.results[1].published_at is None


def test_preview_a_page_monitor() -> None:
    page = {
        "url": "https://example.com/pricing",
        "title": "Pricing",
        "excerpt": "Plans start at $20",
        "source": "live",
        "error": None,
    }
    failed = {
        "url": "https://example.com/gone",
        "title": None,
        "excerpt": None,
        "source": None,
        "error": "HTTP 404",
    }
    keenable, seen = _client(
        [
            httpx.Response(200, json={"type": "page", "results": [], "page": page}),
            httpx.Response(200, json={"type": "page", "results": [], "page": failed}),
        ]
    )
    preview = keenable.monitors.preview(
        type="page", page={"url": "https://example.com/pricing"}
    )
    assert json.loads(seen[0].content) == {
        "type": "page",
        "page": {"url": "https://example.com/pricing"},
    }
    assert preview.type == "page" and preview.results == []
    assert preview.page is not None and preview.page.source == "live"
    assert preview.page.excerpt == "Plans start at $20" and preview.page.error is None
    gone = keenable.monitors.preview(
        type="page", page={"url": "https://example.com/gone"}
    )
    assert gone.page is not None and gone.page.error == "HTTP 404"
    assert gone.page.title is None and gone.page.source is None


@pytest.mark.parametrize(
    "kwargs",
    [
        {},
        {"search": {"query": " "}},
        {"type": "page"},
        {"type": "page", "search": {"query": "q"}, "page": {"url": "https://a.b"}},
        {"search": {"query": "q"}, "page": {"url": "https://a.b"}},
        {"type": "agent", "search": {"query": "q"}},
    ],
)
def test_preview_checks_the_kind_of_monitor(kwargs: dict[str, Any]) -> None:
    keenable, seen = _client([httpx.Response(200, json={})])
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.preview(**kwargs)
    assert seen == []


def test_preview_is_retried_on_a_5xx() -> None:
    keenable, seen = _client(
        [
            httpx.Response(503, json={}),
            httpx.Response(200, json={"type": "search", "results": [], "page": None}),
        ],
        retries=2,
    )
    preview = keenable.monitors.preview(search={"query": "q"})
    assert len(seen) == 2 and preview.results == []


def test_test_webhook() -> None:
    passed = {
        "ok": True,
        "status": 204,
        "latency_ms": 182,
        "error": None,
        "signed_with": "provided",
    }
    failed = {
        "ok": False,
        "status": None,
        "latency_ms": 10003,
        "error": "no answer within 10 s",
        "signed_with": "throwaway",
    }
    keenable, seen = _client(
        [
            httpx.Response(200, json=passed, headers={"x-request-id": "req_1"}),
            httpx.Response(200, json=failed),
        ]
    )
    ok = keenable.monitors.test_webhook("https://hooks.example.com/k", SECRET)
    bad = keenable.monitors.test_webhook("https://hooks.example.com/k")
    assert seen[0].method == "POST" and seen[0].url.path == "/v1/monitors/webhook-test"
    assert json.loads(seen[0].content) == {
        "url": "https://hooks.example.com/k",
        "secret": SECRET,
    }
    assert json.loads(seen[1].content) == {"url": "https://hooks.example.com/k"}
    assert ok.ok and ok.status == 204 and ok.latency_ms == 182
    assert ok.error is None and ok.signed_with == "provided"
    assert ok.request_id == "req_1"
    assert not bad.ok and bad.status is None
    assert bad.error == "no answer within 10 s" and bad.signed_with == "throwaway"


@pytest.mark.parametrize("status", [500, 503])
def test_test_webhook_is_not_retried_on_a_5xx(status: int) -> None:
    keenable, seen = _client([httpx.Response(status, json={})], retries=2)
    with pytest.raises(KeenableAPIError):
        keenable.monitors.test_webhook("https://hooks.example.com/k")
    assert len(seen) == 1


def test_test_webhook_checks_its_arguments() -> None:
    keenable, seen = _client([httpx.Response(200, json={})])
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.test_webhook("")
    with pytest.raises(KeenableInvalidRequestError):
        keenable.monitors.test_webhook("https://hooks.example.com/k", "")
    assert seen == []


async def test_the_async_client_preview_and_test_webhook() -> None:
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/monitors/preview":
            return httpx.Response(
                200, json={"type": "search", "results": [PREVIEW_RESULT], "page": None}
            )
        return httpx.Response(
            200,
            json={
                "ok": False,
                "status": 400,
                "latency_ms": 90,
                "error": "HTTP 400",
                "signed_with": "provided",
            },
        )

    async with AsyncKeenable(
        "k", client=httpx.AsyncClient(transport=httpx.MockTransport(handler))
    ) as keenable:
        preview = await keenable.monitors.preview(search={"query": "q"})
        tested = await keenable.monitors.test_webhook(
            "https://hooks.example.com/k", SECRET
        )
    assert preview.results[0].title == PREVIEW_RESULT["title"]
    assert not tested.ok and tested.status == 400 and tested.error == "HTTP 400"
    assert seen[1].url.path == "/v1/monitors/webhook-test"
