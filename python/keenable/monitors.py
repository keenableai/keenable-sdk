"""Keenable Monitors: standing searches that report new pages as they appear,
and page monitors that report changes to one page.

A search monitor watches the web for a topic and hands over every new page
that matches it, by webhook, in scheduled runs, or by polling its pages. A
page monitor (``type="page"``) reads one page on a schedule and reports the
changes worth telling. Monitors need an API key.

    from keenable import Keenable

    keenable = Keenable()
    monitor = keenable.monitors.create(
        search={"query": "new open-weights LLM releases"},
        schedule={"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
    )
    for page in keenable.monitors.pages(monitor.id).data:
        print(page.title, page.url)

    pricing = keenable.monitors.create(
        type="page",
        page={"url": "https://example.com/pricing", "watch_for": "plan prices"},
        schedule={"type": "interval", "value": "6h"},
    )
"""

from __future__ import annotations

import enum
import uuid
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Generic, Literal, TypedDict, TypeVar, Union
from urllib.parse import quote

import httpx

from .errors import KeenableInvalidRequestError

if TYPE_CHECKING:
    from .client import AsyncKeenable, Keenable


class MonitorContentParams(TypedDict, total=False):
    """``{"text": True}`` returns each page's text."""

    text: bool


class MonitorSearchParams(TypedDict, total=False):
    """What a monitor watches for. ``query`` is required on create."""

    query: str
    max_results: int
    include_domains: Sequence[str] | None
    exclude_domains: Sequence[str] | None
    content: MonitorContentParams | None


class MonitorPageTargetParams(TypedDict, total=False):
    """The page a page monitor watches. ``url`` is required on create."""

    url: str
    watch_for: str | None
    sensitivity: Literal["meaningful", "any"]


class MonitorScheduleParams(TypedDict, total=False):
    """When runs happen: cron (runs at least 10 minutes apart), interval
    (``"10m"`` to ``"90d"``) or once."""

    type: Literal["cron", "interval", "once"]
    value: str | None
    timezone: str | None


class MonitorWebhookParams(TypedDict, total=False):
    """Where events go, and which."""

    url: str
    events: Sequence[str] | None


class BulkFilterParams(TypedDict, total=False):
    """Which monitors :meth:`Monitors.bulk` acts on."""

    status: Literal["active", "paused", "disabled", "completed"]
    name: str
    metadata: Mapping[str, str]


__all__ = [
    "BulkFilterParams",
    "BulkResult",
    "DeliveryList",
    "Monitor",
    "MonitorContentParams",
    "MonitorDelivery",
    "MonitorDiff",
    "MonitorDisabledReason",
    "MonitorList",
    "MonitorPageTarget",
    "MonitorPageTargetParams",
    "MonitorResult",
    "MonitorResultChange",
    "MonitorRun",
    "MonitorRunChanges",
    "MonitorRunError",
    "MonitorRunOutput",
    "MonitorRunOutputError",
    "MonitorSchedule",
    "MonitorScheduleParams",
    "MonitorSearch",
    "MonitorSearchParams",
    "MonitorStats",
    "MonitorType",
    "MonitorVersion",
    "MonitorWebhook",
    "MonitorWebhookParams",
    "PageList",
    "RunList",
    "VersionList",
    "AsyncMonitors",
    "Monitors",
    "NOT_GIVEN",
]

MonitorStatus = Literal["active", "paused", "disabled", "completed"]
MonitorType = Literal["search", "page"]
RunStatus = Literal["queued", "running", "completed", "failed", "cancelled"]
BulkAction = Literal["pause", "resume", "delete"]

_BULK_ACTIONS = ("pause", "resume", "delete")
_TYPES = ("search", "page")


class _NotGiven(enum.Enum):
    """Marks an :meth:`Monitors.update` field the caller left out.

    ``None`` is a value there: it removes the schedule, the webhook or the
    output schema.
    """

    TOKEN = 0

    def __repr__(self) -> str:
        return "NOT_GIVEN"


NOT_GIVEN = _NotGiven.TOKEN


def _str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _req_str(value: Any) -> str:
    return value if isinstance(value, str) else ""


def _int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None
    return int(value)


def _float(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)


def _bool(value: Any) -> bool | None:
    return value if isinstance(value, bool) else None


def _dict(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _strs(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    return [v for v in value if isinstance(v, str)]


def _str_map(value: Any) -> dict[str, str] | None:
    if not isinstance(value, dict):
        return None
    return {k: v for k, v in value.items() if isinstance(v, str)}


def _int_map(value: Any) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, int] = {}
    for k, v in value.items():
        n = _int(v)
        if n is not None:
            out[k] = n
    return out


def _objects(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [v for v in value if isinstance(v, dict)]


@dataclass
class MonitorSearch:
    """What a monitor watches for."""

    query: str
    """The topic in plain words, as written when the monitor was made."""
    max_results: int
    """Pages a run returns at most."""
    include_domains: list[str] | None = None
    """Only pages on these sites."""
    exclude_domains: list[str] | None = None
    """Never pages on these sites."""
    content_text: bool = False
    """Whether each page's text is returned (first 6,000 characters)."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorSearch:
        content = _dict(data.get("content")) or {}
        return cls(
            query=_req_str(data.get("query")),
            max_results=_int(data.get("max_results")) or 0,
            include_domains=_strs(data.get("include_domains")),
            exclude_domains=_strs(data.get("exclude_domains")),
            content_text=content.get("text") is True,
            raw=data,
        )


@dataclass
class MonitorSchedule:
    """When a monitor's runs happen."""

    type: str
    """``"cron"``, ``"interval"`` or ``"once"``."""
    value: str | None = None
    """cron: five fields, runs at least 10 minutes apart. interval: ``"10m"``
    to ``"90d"``, such as ``"6h"``, ``"5d"``, ``"2w"``. once: a timestamp or a
    delay."""
    timezone: str | None = None
    """An IANA name, for cron; UTC when unset."""

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorSchedule:
        return cls(
            type=_req_str(data.get("type")),
            value=_str(data.get("value")),
            timezone=_str(data.get("timezone")),
        )


@dataclass
class MonitorWebhook:
    """Where a monitor's events go."""

    url: str
    events: list[str]
    secret: str | None = None
    """The signing secret (``whsec_...``), only in the response to
    :meth:`Monitors.create`. Keep it: :func:`keenable.verify_webhook` needs
    it."""

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorWebhook:
        return cls(
            url=_req_str(data.get("url")),
            events=_strs(data.get("events")) or [],
            secret=_str(data.get("secret")),
        )


@dataclass
class MonitorPageTarget:
    """The page a page monitor watches."""

    url: str
    watch_for: str | None = None
    """What on the page matters, in plain words; None means every meaningful
    change counts."""
    sensitivity: str = "meaningful"
    """``"meaningful"``: a change is judged worth telling or not. ``"any"``:
    every change that is not cosmetic is told."""

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorPageTarget:
        return cls(
            url=_req_str(data.get("url")),
            watch_for=_str(data.get("watch_for")),
            sensitivity=_str(data.get("sensitivity")) or "meaningful",
        )


@dataclass
class MonitorDisabledReason:
    """Why Keenable disabled a monitor."""

    code: str
    """``"runs_failed"`` (10 failed runs in a row), ``"webhook_unreachable"``
    (no delivery succeeded for 3 days) or ``"data_policy"``
    (a page monitor of an organization that turned on zero data retention)."""
    message: str

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorDisabledReason:
        return cls(
            code=_req_str(data.get("code")), message=_req_str(data.get("message"))
        )


@dataclass
class Monitor:
    """A monitor, as :meth:`Monitors.create`, :meth:`Monitors.get` and the
    other calls return it."""

    id: str
    object: str
    name: str | None
    status: str
    """``"active"``, ``"paused"``, ``"disabled"`` or ``"completed"``."""
    search: MonitorSearch | None
    """What a search monitor watches for; None for a page monitor."""
    schedule: MonitorSchedule | None
    output_schema: dict[str, Any] | None
    webhook: MonitorWebhook | None
    metadata: dict[str, str] | None
    last_run_at: str | None
    next_run_at: str | None
    upcoming_runs: list[str]
    """The next three run times, UTC."""
    created_at: str
    updated_at: str
    agent_run_id: Any = None
    """Not available yet: always None."""
    backfill: Any = None
    """Not available yet: always None."""
    memory_scope: Any = None
    """Not available yet: always None."""
    estimated_cost_usd: float | None = None
    """None until monitors are priced."""
    cost_this_month_usd: float | None = None
    """None until monitors are priced."""
    type: str = "search"
    """``"search"`` (new pages about a topic) or ``"page"`` (changes to one
    page)."""
    page: MonitorPageTarget | None = None
    """The page a page monitor watches; None for a search monitor."""
    disabled_reason: MonitorDisabledReason | None = None
    """Why a disabled monitor stopped; None otherwise."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    request_id: str | None = None

    @classmethod
    def _from_json(cls, data: dict[str, Any], request_id: str | None = None) -> Monitor:
        schedule = _dict(data.get("schedule"))
        webhook = _dict(data.get("webhook"))
        search = _dict(data.get("search"))
        page = _dict(data.get("page"))
        disabled = _dict(data.get("disabled_reason"))
        return cls(
            id=_req_str(data.get("id")),
            object=_req_str(data.get("object")) or "monitor",
            name=_str(data.get("name")),
            status=_req_str(data.get("status")),
            search=MonitorSearch._from_json(search) if search is not None else None,
            schedule=MonitorSchedule._from_json(schedule) if schedule else None,
            output_schema=_dict(data.get("output_schema")),
            webhook=MonitorWebhook._from_json(webhook) if webhook else None,
            metadata=_str_map(data.get("metadata")),
            last_run_at=_str(data.get("last_run_at")),
            next_run_at=_str(data.get("next_run_at")),
            upcoming_runs=_strs(data.get("upcoming_runs")) or [],
            created_at=_req_str(data.get("created_at")),
            updated_at=_req_str(data.get("updated_at")),
            agent_run_id=data.get("agent_run_id"),
            backfill=data.get("backfill"),
            memory_scope=data.get("memory_scope"),
            estimated_cost_usd=_float(data.get("estimated_cost_usd")),
            cost_this_month_usd=_float(data.get("cost_this_month_usd")),
            type=_str(data.get("type")) or "search",
            page=MonitorPageTarget._from_json(page) if page is not None else None,
            disabled_reason=MonitorDisabledReason._from_json(disabled)
            if disabled is not None
            else None,
            raw=data,
            request_id=request_id,
        )


@dataclass
class MonitorResultChange:
    """How a page that came back changed since the version the monitor sent."""

    previous_at: str | None = None
    previous_title: str | None = None
    previous_sent: bool | None = None
    ratio: float | None = None
    """The share of the new text that was not in the old one, 0 to 1."""
    added: list[str] | None = None
    removed: list[str] | None = None

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorResultChange:
        return cls(
            previous_at=_str(data.get("previous_at")),
            previous_title=_str(data.get("previous_title")),
            previous_sent=_bool(data.get("previous_sent")),
            ratio=_float(data.get("ratio")),
            added=_strs(data.get("added")),
            removed=_strs(data.get("removed")),
        )


@dataclass
class MonitorResult:
    """A page a monitor found: in a run, a webhook event or :meth:`Monitors.pages`."""

    url: str
    title: str | None = None
    author: str | None = None
    published_at: str | None = None
    acquired_at: str | None = None
    image: str | None = None
    favicon: str | None = None
    """Always None for now."""
    highlights: Any = None
    """Always None for now."""
    matched_at: str | None = None
    """When the monitor accepted the page."""
    published_at_source: str | None = None
    """``"declared"``, ``"url"``, ``"x"`` or ``"text"``: where the date comes
    from."""
    summary: str | None = None
    """One line on what the page reports."""
    importance: int | None = None
    """1 to 5 for the monitor's topic; pages under 3 are not sent."""
    kind: str | None = None
    source_type: str | None = None
    """``"original"`` or ``"rewrite"``."""
    score: float | None = None
    """Uncalibrated relevance, only for ordering one monitor's pages."""
    text: str | None = None
    """The page's text, when the monitor's search asks for it."""
    change: MonitorResultChange | None = None
    """Set on a ``monitor.update``: how the page changed."""
    id: str | None = None
    """Set by :meth:`Monitors.pages`: identifies the match, and is the cursor
    of the page of results it ends."""
    same_story: int | None = None
    """Set by :meth:`Monitors.pages`: how many more pages reported the same
    story and were left out."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorResult:
        change = _dict(data.get("change"))
        return cls(
            url=_req_str(data.get("url")),
            title=_str(data.get("title")),
            author=_str(data.get("author")),
            published_at=_str(data.get("published_at")),
            acquired_at=_str(data.get("acquired_at")),
            image=_str(data.get("image")),
            favicon=_str(data.get("favicon")),
            highlights=data.get("highlights"),
            matched_at=_str(data.get("matched_at")),
            published_at_source=_str(data.get("published_at_source")),
            summary=_str(data.get("summary")),
            importance=_int(data.get("importance")),
            kind=_str(data.get("kind")),
            source_type=_str(data.get("source_type")),
            score=_float(data.get("score")),
            text=_str(data.get("text")),
            change=MonitorResultChange._from_json(change) if change else None,
            id=_str(data.get("id")),
            same_story=_int(data.get("same_story")),
            raw=data,
        )


@dataclass
class MonitorRunError:
    """Why a run failed."""

    code: str
    message: str


@dataclass
class MonitorRunOutputError:
    """Why a run has no output."""

    code: str
    """``"output_failed"`` (it could not be made) or ``"output_invalid"`` (it
    did not match the schema). The run still completes."""
    message: str = ""

    @classmethod
    def _from_json(cls, value: Any) -> MonitorRunOutputError | None:
        if isinstance(value, str) and value:
            return cls(code=value)
        data = _dict(value)
        if data is None:
            return None
        return cls(
            code=_req_str(data.get("code")), message=_req_str(data.get("message"))
        )


@dataclass
class MonitorRunOutput:
    """A run's digest, when the monitor has an ``output_schema``."""

    structured: Any = None
    """The output in the monitor's schema; None with ``error``."""
    text: str | None = None
    grounding: list[Any] = field(default_factory=list)
    """Each field filled, with the pages that support it."""
    fresh: bool = True
    """Read in this run; False when a page monitor's page did not change and
    the last reading is carried forward."""
    error: MonitorRunOutputError | None = None
    """Why there is no output."""

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorRunOutput:
        grounding = data.get("grounding")
        return cls(
            structured=data.get("structured"),
            text=_str(data.get("text")),
            grounding=grounding if isinstance(grounding, list) else [],
            fresh=data.get("fresh") is not False,
            error=MonitorRunOutputError._from_json(data.get("error")),
        )


@dataclass
class MonitorDiff:
    """How a version of a page differs from the version before it from the
    same source."""

    previous_at: str | None = None
    """When the version compared with was read."""
    ratio: float | None = None
    """The share of the text that is new, 0 to 1."""
    added: list[str] = field(default_factory=list)
    removed: list[str] = field(default_factory=list)

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorDiff:
        return cls(
            previous_at=_str(data.get("previous_at")),
            ratio=_float(data.get("ratio")),
            added=_strs(data.get("added")) or [],
            removed=_strs(data.get("removed")) or [],
        )


def _diff(value: Any) -> MonitorDiff | None:
    data = _dict(value)
    return MonitorDiff._from_json(data) if data is not None else None


@dataclass
class MonitorRunChanges:
    """What a page monitor's run found on its page."""

    changed: bool
    """The text changed since the previous version (a baseline is not a
    change)."""
    notified: bool
    """The change is worth telling: ``monitor.change`` was sent."""
    baseline: bool
    """The first reading of the page (or of a new URL), which later versions
    are compared with."""
    version: int | None = None
    """The page's version after this run; :meth:`Monitors.versions` has them
    all."""
    source: str | None = None
    """``"live"`` (fetched now) or ``"stream"`` (the crawler's fresh copy)."""
    summary: str | None = None
    """One sentence on what changed, when it was judged."""
    items: list[str] = field(default_factory=list)
    """The new entries, facts or figures."""
    diff: MonitorDiff | None = None

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorRunChanges:
        return cls(
            changed=data.get("changed") is True,
            notified=data.get("notified") is True,
            baseline=data.get("baseline") is True,
            version=_int(data.get("version")),
            source=_str(data.get("source")),
            summary=_str(data.get("summary")),
            items=_strs(data.get("items")) or [],
            diff=_diff(data.get("diff")),
        )


@dataclass
class MonitorRun:
    """One run of a monitor."""

    id: str
    object: str
    monitor_id: str
    status: str
    """``"queued"``, ``"running"``, ``"completed"``, ``"failed"`` or
    ``"cancelled"``."""
    results: list[MonitorResult] | None
    """New pages; ``[]`` when none; None until the run completes."""
    output: MonitorRunOutput | None
    error: MonitorRunError | None
    created_at: str | None
    started_at: str | None
    ended_at: str | None
    changes: MonitorRunChanges | None = None
    """A page monitor's completed run: what changed on the page. None for a
    search monitor and until the run completes."""
    usage: Any = None
    """None until monitors are priced."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    request_id: str | None = None

    @classmethod
    def _from_json(
        cls, data: dict[str, Any], request_id: str | None = None
    ) -> MonitorRun:
        results = data.get("results")
        output = _dict(data.get("output"))
        error = _dict(data.get("error"))
        changes = _dict(data.get("changes"))
        return cls(
            id=_req_str(data.get("id")),
            object=_req_str(data.get("object")) or "monitor_run",
            monitor_id=_req_str(data.get("monitor_id")),
            status=_req_str(data.get("status")),
            results=[MonitorResult._from_json(r) for r in _objects(results)]
            if isinstance(results, list)
            else None,
            output=MonitorRunOutput._from_json(output) if output is not None else None,
            error=MonitorRunError(
                code=_req_str(error.get("code")), message=_req_str(error.get("message"))
            )
            if error is not None
            else None,
            created_at=_str(data.get("created_at")),
            started_at=_str(data.get("started_at")),
            ended_at=_str(data.get("ended_at")),
            changes=MonitorRunChanges._from_json(changes)
            if changes is not None
            else None,
            usage=data.get("usage"),
            raw=data,
            request_id=request_id,
        )


@dataclass
class MonitorVersion:
    """One stored version of a page monitor's page: a reading whose text
    changed."""

    id: str
    """Opaque; the cursor of the page of versions it ends."""
    object: str
    version: int
    """Counts up from 1, the baseline."""
    fetched_at: str | None
    title: str | None
    source: str
    """``"live"`` or ``"stream"``; versions are compared only with versions
    of the same source."""
    notified: bool
    """This version's change was told (``monitor.change``)."""
    summary: str | None = None
    items: list[str] = field(default_factory=list)
    diff: MonitorDiff | None = None
    """Against the version before it from the same source; None for a first
    version."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorVersion:
        return cls(
            id=_req_str(data.get("id")),
            object=_req_str(data.get("object")) or "page_version",
            version=_int(data.get("version")) or 0,
            fetched_at=_str(data.get("fetched_at")),
            title=_str(data.get("title")),
            source=_req_str(data.get("source")),
            notified=data.get("notified") is True,
            summary=_str(data.get("summary")),
            items=_strs(data.get("items")) or [],
            diff=_diff(data.get("diff")),
            raw=data,
        )


@dataclass
class MonitorDelivery:
    """One webhook event and its delivery attempts."""

    id: str
    type: str
    url: str
    created_at: str
    attempts: int
    delivered_at: str | None = None
    last_error: str | None = None
    next_attempt_at: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> MonitorDelivery:
        return cls(
            id=_req_str(data.get("id")),
            type=_req_str(data.get("type")),
            url=_req_str(data.get("url")),
            created_at=_req_str(data.get("created_at")),
            attempts=_int(data.get("attempts")) or 0,
            delivered_at=_str(data.get("delivered_at")),
            last_error=_str(data.get("last_error")),
            next_attempt_at=_str(data.get("next_attempt_at")),
            raw=data,
        )


@dataclass
class MonitorStats:
    """How many monitors there are, by status and by kind of schedule."""

    total: int
    by_status: dict[str, int]
    by_schedule: dict[str, int]
    """Keys ``"cron"``, ``"interval"``, ``"once"`` and ``"manual"``."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    request_id: str | None = None

    @classmethod
    def _from_json(
        cls, data: dict[str, Any], request_id: str | None = None
    ) -> MonitorStats:
        return cls(
            total=_int(data.get("total")) or 0,
            by_status=_int_map(data.get("by_status")),
            by_schedule=_int_map(data.get("by_schedule")),
            raw=data,
            request_id=request_id,
        )


@dataclass
class BulkResult:
    """What :meth:`Monitors.bulk` changed, or would change on a dry run."""

    action: str
    affected: int
    ids: list[str]
    dry_run: bool
    has_more: bool
    """More monitors matched than ``limit``; send the call again for them."""
    not_found: list[str]
    """Of the ids sent, those that are not monitors of this key."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    request_id: str | None = None

    @classmethod
    def _from_json(
        cls, data: dict[str, Any], request_id: str | None = None
    ) -> BulkResult:
        return cls(
            action=_req_str(data.get("action")),
            affected=_int(data.get("affected")) or 0,
            ids=_strs(data.get("ids")) or [],
            dry_run=data.get("dry_run") is True,
            has_more=data.get("has_more") is True,
            not_found=_strs(data.get("not_found")) or [],
            raw=data,
            request_id=request_id,
        )


T = TypeVar("T")


@dataclass
class ListPage(Generic[T]):
    """One page of a list: ``data``, and ``next_cursor`` for the next page."""

    data: list[T]
    has_more: bool
    next_cursor: str | None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    request_id: str | None = None

    def __iter__(self) -> Iterator[T]:
        return iter(self.data)

    def __len__(self) -> int:
        return len(self.data)


MonitorList = ListPage[Monitor]
RunList = ListPage[MonitorRun]
PageList = ListPage[MonitorResult]
DeliveryList = ListPage[MonitorDelivery]
VersionList = ListPage[MonitorVersion]


def _list(data: dict[str, Any], request_id: str | None, item: Any) -> ListPage[Any]:
    return ListPage(
        data=[item(x) for x in _objects(data.get("data"))],
        has_more=data.get("has_more") is True,
        next_cursor=_str(data.get("next_cursor")) or None,
        raw=data,
        request_id=request_id,
    )


def _monitor_list(data: dict[str, Any], request_id: str | None) -> MonitorList:
    return _list(data, request_id, Monitor._from_json)


def _run_list(data: dict[str, Any], request_id: str | None) -> RunList:
    return _list(data, request_id, MonitorRun._from_json)


def _page_list(data: dict[str, Any], request_id: str | None) -> PageList:
    return _list(data, request_id, MonitorResult._from_json)


def _delivery_list(data: dict[str, Any], request_id: str | None) -> DeliveryList:
    return _list(data, request_id, MonitorDelivery._from_json)


def _version_list(data: dict[str, Any], request_id: str | None) -> VersionList:
    return _list(data, request_id, MonitorVersion._from_json)


@dataclass
class _Call:
    """One monitors request, built once for the sync and async clients."""

    method: str
    path: str
    params: dict[str, str] | None = None
    json: dict[str, Any] | None = None
    headers: dict[str, str] | None = None
    safe: bool = True


def _segment(name: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise KeenableInvalidRequestError(f"{name} must be a non-empty string")
    if value in (".", ".."):
        raise KeenableInvalidRequestError(
            f"{name} must not be {value!r}: it would change the request's path"
        )
    return quote(value, safe="")


def _path(*parts: str) -> str:
    return "monitors" + "".join(f"/{p}" for p in parts)


def _query(**values: Any) -> dict[str, str]:
    params: dict[str, str] = {}
    for key, value in values.items():
        if value is None or value == "":
            continue
        if isinstance(value, bool):
            params[key] = "true" if value else "false"
        else:
            params[key] = str(value)
    return params


def _metadata_query(metadata: Mapping[str, str] | None) -> dict[str, str]:
    if not metadata:
        return {}
    return {f"metadata[{k}]": v for k, v in metadata.items()}


def _check_search(search: Any, required: bool) -> dict[str, Any]:
    if not isinstance(search, Mapping):
        raise KeenableInvalidRequestError(
            "search must be a mapping such as "
            "{'query': 'new open-weights LLM releases'}"
        )
    body = {
        k: (list(v) if k.endswith("_domains") and v is not None else v)
        for k, v in search.items()
    }
    query = body.get("query")
    if (required or "query" in body) and (
        not isinstance(query, str) or not query.strip()
    ):
        raise KeenableInvalidRequestError("search needs a non-empty query string")
    return body


def _check_page(page: Any, required: bool) -> dict[str, Any]:
    if not isinstance(page, Mapping):
        raise KeenableInvalidRequestError(
            "page must be a mapping such as {'url': 'https://example.com/pricing'}"
        )
    body = dict(page)
    url = body.get("url")
    if (required or "url" in body) and (not isinstance(url, str) or not url.strip()):
        raise KeenableInvalidRequestError("page needs a non-empty url string")
    return body


def _webhook_body(webhook: Mapping[str, Any]) -> dict[str, Any]:
    body = dict(webhook)
    if body.get("events") is not None:
        body["events"] = list(body["events"])
    return body


def _create_call(
    search: Any,
    type: Any,
    page: Any,
    name: str | None,
    schedule: Mapping[str, Any] | None,
    output_schema: Mapping[str, Any] | None,
    webhook: Mapping[str, Any] | None,
    metadata: Mapping[str, str] | None,
    idempotency_key: str | None,
) -> _Call:
    if type is not None and type not in _TYPES:
        raise KeenableInvalidRequestError(
            f"type must be 'search' or 'page', got {type!r}"
        )
    body: dict[str, Any] = {}
    if type == "page":
        if search is not None:
            raise KeenableInvalidRequestError("a page monitor takes page, not search")
        body["type"] = "page"
        body["page"] = _check_page(page, True)
    else:
        if page is not None:
            raise KeenableInvalidRequestError(
                "page is only for type='page'; a search monitor takes search"
            )
        if type is not None:
            body["type"] = type
        body["search"] = _check_search(search, True)
    if name is not None:
        body["name"] = name
    if schedule is not None:
        body["schedule"] = dict(schedule)
    if output_schema is not None:
        body["output_schema"] = dict(output_schema)
    if webhook is not None:
        body["webhook"] = _webhook_body(webhook)
    if metadata is not None:
        body["metadata"] = dict(metadata)
    key = idempotency_key if idempotency_key else str(uuid.uuid4())
    return _Call("POST", _path(), json=body, headers={"Idempotency-Key": key})


def _update_call(monitor_id: str, fields: dict[str, Any]) -> _Call:
    body: dict[str, Any] = {}
    for key, value in fields.items():
        if value is NOT_GIVEN:
            continue
        if value is None:
            body[key] = None
        elif key == "search":
            body[key] = _check_search(value, False)
        elif key == "page":
            body[key] = _check_page(value, False)
        elif key == "webhook":
            body[key] = _webhook_body(value)
        elif isinstance(value, Mapping):
            body[key] = dict(value)
        else:
            body[key] = value
    return _Call(
        "PATCH", _path(_segment("monitor_id", monitor_id)), json=body, safe=False
    )


def _selects(filter: Mapping[str, Any] | None) -> bool:
    if not filter:
        return False
    metadata = filter.get("metadata")
    return (
        bool(filter.get("status"))
        or bool(filter.get("name"))
        or (isinstance(metadata, Mapping) and len(metadata) > 0)
    )


def _bulk_call(
    action: str,
    ids: Sequence[str] | None,
    filter: Mapping[str, Any] | None,
    limit: int | None,
    dry_run: bool,
) -> _Call:
    if action not in _BULK_ACTIONS:
        raise KeenableInvalidRequestError(
            f"action must be one of {', '.join(_BULK_ACTIONS)}, got {action!r}"
        )
    if isinstance(ids, str):
        raise KeenableInvalidRequestError("ids must be a list of monitor ids")
    if filter is not None and not isinstance(filter, Mapping):
        raise KeenableInvalidRequestError("filter must be a mapping")
    if not ids and not _selects(filter):
        raise KeenableInvalidRequestError(
            "bulk() needs ids or a filter with a status, a name or metadata"
        )
    if not isinstance(dry_run, bool):
        raise KeenableInvalidRequestError("dry_run must be True or False")
    body: dict[str, Any] = {"action": action, "dry_run": dry_run}
    if ids:
        body["ids"] = list(ids)
    if filter is not None and _selects(filter):
        body["filter"] = {
            key: value
            for key, value in filter.items()
            if key in ("status", "name", "metadata") and value
        }
    if limit is not None:
        body["limit"] = limit
    return _Call("POST", _path("bulk"), json=body, safe=False)


Timeout = Union[float, httpx.Timeout, None]


class Monitors:
    """``keenable.monitors``: create, read and manage monitors.

    Every call takes ``timeout``, ``max_retries`` and ``extra_headers`` as
    :meth:`Keenable.search` does. Reads and deletes are retried like a search.
    :meth:`create` sends an ``Idempotency-Key`` (yours, or a new one for each
    call), so retrying it cannot make a second monitor. :meth:`update`,
    :meth:`trigger` and :meth:`bulk` are retried only on a 429, which the API
    sends before it does anything.
    """

    def __init__(self, client: Keenable) -> None:
        self._client = client

    def _send(
        self,
        call: _Call,
        timeout: Timeout,
        max_retries: int | None,
        extra_headers: Mapping[str, str] | None,
    ) -> tuple[dict[str, Any], str | None]:
        return self._client._monitors_request(
            call,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )

    def create(
        self,
        *,
        search: MonitorSearchParams | None = None,
        type: MonitorType | None = None,
        page: MonitorPageTargetParams | None = None,
        name: str | None = None,
        schedule: MonitorScheduleParams | None = None,
        output_schema: Mapping[str, Any] | None = None,
        webhook: MonitorWebhookParams | None = None,
        metadata: Mapping[str, str] | None = None,
        idempotency_key: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Create a monitor. Takes a few seconds: it is calibrated against the
        last week of the web.

        Args:
            search: What a search monitor watches for: ``query`` (required),
                ``max_results`` (1 to 100, default 10), ``include_domains``,
                ``exclude_domains`` and ``content`` (``{"text": True}``
                returns each page's text). Required unless ``type="page"``.
            type: ``"search"`` (the API's default: new pages about a topic)
                or ``"page"`` (changes to one page).
            page: The page a page monitor watches: ``url`` (required, a
                public http(s) address), ``watch_for`` (what on the page
                matters, in plain words) and ``sensitivity``
                (``"meaningful"``, the default, or ``"any"``). Only with
                ``type="page"``.
            name: A name for the monitor, up to 200 characters.
            schedule: When runs happen: ``{"type": "cron", "value": "0 9 * *
                1-5", "timezone": "Europe/Paris"}`` (runs at least 10 minutes
                apart), ``{"type": "interval", "value": "6h"}`` (``"10m"`` to
                ``"90d"``) or ``{"type": "once", "value": "2h"}``. Without
                one, a search monitor runs only on :meth:`trigger` and a page
                monitor every hour.
            output_schema: JSON Schema of each run's ``output.structured``,
                in the subset the API supports; the API checks it.
            webhook: ``{"url": "https://...", "events": [...]}``. A search
                monitor's default events are the ``monitor.*`` and
                ``monitor.run.*`` ones; add ``"monitor.hit"`` to get each new
                page as soon as it is found. A page monitor's default events
                are ``monitor.created``, ``updated``, ``deleted``,
                ``disabled``, ``run.failed`` and ``monitor.change``.
            metadata: Your own tags, at most 50, echoed in every webhook.
            idempotency_key: Makes a retry safe: the same key with the same
                body returns the monitor the first call created, for 24 hours.
                A new key is made for each call when you leave it out.

        Returns:
            The :class:`Monitor`. ``webhook.secret`` is set here and nowhere
            else: keep it to verify deliveries.
        """
        call = _create_call(
            search,
            type,
            page,
            name,
            schedule,
            output_schema,
            webhook,
            metadata,
            idempotency_key,
        )
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return Monitor._from_json(data, request_id)

    def list(
        self,
        *,
        status: MonitorStatus | None = None,
        name: str | None = None,
        metadata: Mapping[str, str] | None = None,
        limit: int | None = None,
        cursor: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> MonitorList:
        """One page of monitors, newest first.

        Args:
            status: Only monitors in this status.
            name: Only monitors whose name contains this.
            metadata: Only monitors with these metadata values.
            limit: Monitors per page (the API's default is 50).
            cursor: The previous page's ``next_cursor``.
        """
        params = _query(status=status, name=name, limit=limit, cursor=cursor)
        params.update(_metadata_query(metadata))
        data, request_id = self._send(
            _Call("GET", _path(), params=params), timeout, max_retries, extra_headers
        )
        return _monitor_list(data, request_id)

    def list_all(
        self,
        *,
        status: MonitorStatus | None = None,
        name: str | None = None,
        metadata: Mapping[str, str] | None = None,
        limit: int | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Iterator[Monitor]:
        """Every monitor, newest first, fetching pages of ``limit`` as needed."""
        cursor: str | None = None
        while True:
            page = self.list(
                status=status,
                name=name,
                metadata=metadata,
                limit=limit,
                cursor=cursor,
                timeout=timeout,
                max_retries=max_retries,
                extra_headers=extra_headers,
            )
            yield from page.data
            if not page.has_more or not page.next_cursor:
                return
            cursor = page.next_cursor

    def get(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """One monitor."""
        call = _Call("GET", _path(_segment("monitor_id", monitor_id)))
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return Monitor._from_json(data, request_id)

    def update(
        self,
        monitor_id: str,
        *,
        name: str | None | _NotGiven = NOT_GIVEN,
        status: Literal["active", "paused"] | _NotGiven = NOT_GIVEN,
        search: MonitorSearchParams | _NotGiven = NOT_GIVEN,
        page: MonitorPageTargetParams | _NotGiven = NOT_GIVEN,
        schedule: MonitorScheduleParams | None | _NotGiven = NOT_GIVEN,
        output_schema: Mapping[str, Any] | None | _NotGiven = NOT_GIVEN,
        webhook: MonitorWebhookParams | None | _NotGiven = NOT_GIVEN,
        metadata: Mapping[str, str] | None | _NotGiven = NOT_GIVEN,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Change a monitor. Only the arguments you pass are sent.

        ``search`` (search monitors), ``page`` (page monitors) and
        ``webhook`` are merged into the stored ones; a new ``page.url`` starts
        a new baseline, and ``watch_for`` ``None`` clears it. ``None``
        removes the schedule, the webhook or the output schema. ``status`` is
        ``"active"`` or ``"paused"``; active also re-enables a disabled
        monitor. Not retried on a 5xx.
        """
        call = _update_call(
            monitor_id,
            {
                "name": name,
                "status": status,
                "search": search,
                "page": page,
                "schedule": schedule,
                "output_schema": output_schema,
                "webhook": webhook,
                "metadata": metadata,
            },
        )
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return Monitor._from_json(data, request_id)

    def pause(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Pause a monitor: ``update(monitor_id, status="paused")``."""
        return self.update(
            monitor_id,
            status="paused",
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )

    def resume(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Resume a paused or disabled monitor.

        The same as ``update(monitor_id, status="active")``.
        """
        return self.update(
            monitor_id,
            status="active",
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )

    def delete(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Delete a monitor and the pages it found, for good. Returns it as it was."""
        call = _Call("DELETE", _path(_segment("monitor_id", monitor_id)))
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return Monitor._from_json(data, request_id)

    def trigger(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> MonitorRun:
        """Start a run now and return it queued. Read it with :meth:`run`, or
        wait for ``monitor.run.completed``. Not retried on a 5xx."""
        call = _Call(
            "POST",
            _path(_segment("monitor_id", monitor_id), "trigger"),
            safe=False,
        )
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return MonitorRun._from_json(data, request_id)

    def runs(
        self,
        monitor_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> RunList:
        """One page of a monitor's runs, newest first."""
        call = _Call(
            "GET",
            _path(_segment("monitor_id", monitor_id), "runs"),
            params=_query(limit=limit, cursor=cursor),
        )
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return _run_list(data, request_id)

    def run(
        self,
        monitor_id: str,
        run_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> MonitorRun:
        """One run."""
        call = _Call(
            "GET",
            _path(
                _segment("monitor_id", monitor_id),
                "runs",
                _segment("run_id", run_id),
            ),
        )
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return MonitorRun._from_json(data, request_id)

    def pages(
        self,
        monitor_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        min_importance: int | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> PageList:
        """The pages a monitor accepted, newest first, one per story.

        The way to read a monitor without a webhook or a schedule: poll, and
        stop at the first ``id`` already seen. ``min_importance=4`` keeps the
        pages a reader would not want to miss.
        """
        call = _Call(
            "GET",
            _path(_segment("monitor_id", monitor_id), "pages"),
            params=_query(limit=limit, cursor=cursor, min_importance=min_importance),
        )
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return _page_list(data, request_id)

    def versions(
        self,
        monitor_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> VersionList:
        """A page monitor's history, newest first (its last 500 versions):
        every reading whose text changed, with the diff against the version
        before it from the same source and, for a change that was told, the
        summary and the new items. Empty for a search monitor.

        Args:
            limit: Versions per page (the API's default is 50).
            cursor: The previous page's ``next_cursor``.
        """
        call = _Call(
            "GET",
            _path(_segment("monitor_id", monitor_id), "versions"),
            params=_query(limit=limit, cursor=cursor),
        )
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return _version_list(data, request_id)

    def deliveries(
        self,
        monitor_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> DeliveryList:
        """The monitor's webhook events of the last 7 days, with attempts and
        the last error, newest first."""
        call = _Call(
            "GET",
            _path(_segment("monitor_id", monitor_id), "deliveries"),
            params=_query(limit=limit, cursor=cursor),
        )
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return _delivery_list(data, request_id)

    def stats(
        self,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> MonitorStats:
        """Counts of monitors by status and by kind of schedule."""
        data, request_id = self._send(
            _Call("GET", _path("stats")), timeout, max_retries, extra_headers
        )
        return MonitorStats._from_json(data, request_id)

    def bulk(
        self,
        action: BulkAction,
        *,
        ids: Sequence[str] | None = None,
        filter: BulkFilterParams | None = None,
        limit: int | None = None,
        dry_run: bool = True,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> BulkResult:
        """Pause, resume or delete many monitors, by ``ids`` or by ``filter``
        (``status``, ``name``, ``metadata``).

        ``dry_run`` is True unless you pass False: the result then lists what
        would change and nothing changes. Not retried on a 5xx.
        """
        call = _bulk_call(action, ids, filter, limit, dry_run)
        data, request_id = self._send(call, timeout, max_retries, extra_headers)
        return BulkResult._from_json(data, request_id)


class AsyncMonitors:
    """``AsyncKeenable.monitors``: :class:`Monitors` with awaitable methods."""

    def __init__(self, client: AsyncKeenable) -> None:
        self._client = client

    async def _send(
        self,
        call: _Call,
        timeout: Timeout,
        max_retries: int | None,
        extra_headers: Mapping[str, str] | None,
    ) -> tuple[dict[str, Any], str | None]:
        return await self._client._monitors_request(
            call,
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )

    async def create(
        self,
        *,
        search: MonitorSearchParams | None = None,
        type: MonitorType | None = None,
        page: MonitorPageTargetParams | None = None,
        name: str | None = None,
        schedule: MonitorScheduleParams | None = None,
        output_schema: Mapping[str, Any] | None = None,
        webhook: MonitorWebhookParams | None = None,
        metadata: Mapping[str, str] | None = None,
        idempotency_key: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Create a monitor. See :meth:`Monitors.create`."""
        call = _create_call(
            search,
            type,
            page,
            name,
            schedule,
            output_schema,
            webhook,
            metadata,
            idempotency_key,
        )
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return Monitor._from_json(data, request_id)

    async def list(
        self,
        *,
        status: MonitorStatus | None = None,
        name: str | None = None,
        metadata: Mapping[str, str] | None = None,
        limit: int | None = None,
        cursor: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> MonitorList:
        """One page of monitors. See :meth:`Monitors.list`."""
        params = _query(status=status, name=name, limit=limit, cursor=cursor)
        params.update(_metadata_query(metadata))
        data, request_id = await self._send(
            _Call("GET", _path(), params=params), timeout, max_retries, extra_headers
        )
        return _monitor_list(data, request_id)

    async def list_all(
        self,
        *,
        status: MonitorStatus | None = None,
        name: str | None = None,
        metadata: Mapping[str, str] | None = None,
        limit: int | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> AsyncIterator[Monitor]:
        """Every monitor, newest first: ``async for monitor in ...``."""
        cursor: str | None = None
        while True:
            page = await self.list(
                status=status,
                name=name,
                metadata=metadata,
                limit=limit,
                cursor=cursor,
                timeout=timeout,
                max_retries=max_retries,
                extra_headers=extra_headers,
            )
            for monitor in page.data:
                yield monitor
            if not page.has_more or not page.next_cursor:
                return
            cursor = page.next_cursor

    async def get(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """One monitor."""
        call = _Call("GET", _path(_segment("monitor_id", monitor_id)))
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return Monitor._from_json(data, request_id)

    async def update(
        self,
        monitor_id: str,
        *,
        name: str | None | _NotGiven = NOT_GIVEN,
        status: Literal["active", "paused"] | _NotGiven = NOT_GIVEN,
        search: MonitorSearchParams | _NotGiven = NOT_GIVEN,
        page: MonitorPageTargetParams | _NotGiven = NOT_GIVEN,
        schedule: MonitorScheduleParams | None | _NotGiven = NOT_GIVEN,
        output_schema: Mapping[str, Any] | None | _NotGiven = NOT_GIVEN,
        webhook: MonitorWebhookParams | None | _NotGiven = NOT_GIVEN,
        metadata: Mapping[str, str] | None | _NotGiven = NOT_GIVEN,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Change a monitor. See :meth:`Monitors.update`."""
        call = _update_call(
            monitor_id,
            {
                "name": name,
                "status": status,
                "search": search,
                "page": page,
                "schedule": schedule,
                "output_schema": output_schema,
                "webhook": webhook,
                "metadata": metadata,
            },
        )
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return Monitor._from_json(data, request_id)

    async def pause(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Pause a monitor."""
        return await self.update(
            monitor_id,
            status="paused",
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )

    async def resume(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Resume a paused or disabled monitor."""
        return await self.update(
            monitor_id,
            status="active",
            timeout=timeout,
            max_retries=max_retries,
            extra_headers=extra_headers,
        )

    async def delete(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> Monitor:
        """Delete a monitor for good. Returns it as it was."""
        call = _Call("DELETE", _path(_segment("monitor_id", monitor_id)))
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return Monitor._from_json(data, request_id)

    async def trigger(
        self,
        monitor_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> MonitorRun:
        """Start a run now. See :meth:`Monitors.trigger`."""
        call = _Call(
            "POST",
            _path(_segment("monitor_id", monitor_id), "trigger"),
            safe=False,
        )
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return MonitorRun._from_json(data, request_id)

    async def runs(
        self,
        monitor_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> RunList:
        """One page of a monitor's runs, newest first."""
        call = _Call(
            "GET",
            _path(_segment("monitor_id", monitor_id), "runs"),
            params=_query(limit=limit, cursor=cursor),
        )
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return _run_list(data, request_id)

    async def run(
        self,
        monitor_id: str,
        run_id: str,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> MonitorRun:
        """One run."""
        call = _Call(
            "GET",
            _path(
                _segment("monitor_id", monitor_id),
                "runs",
                _segment("run_id", run_id),
            ),
        )
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return MonitorRun._from_json(data, request_id)

    async def pages(
        self,
        monitor_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        min_importance: int | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> PageList:
        """The pages a monitor accepted. See :meth:`Monitors.pages`."""
        call = _Call(
            "GET",
            _path(_segment("monitor_id", monitor_id), "pages"),
            params=_query(limit=limit, cursor=cursor, min_importance=min_importance),
        )
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return _page_list(data, request_id)

    async def versions(
        self,
        monitor_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> VersionList:
        """A page monitor's history. See :meth:`Monitors.versions`."""
        call = _Call(
            "GET",
            _path(_segment("monitor_id", monitor_id), "versions"),
            params=_query(limit=limit, cursor=cursor),
        )
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return _version_list(data, request_id)

    async def deliveries(
        self,
        monitor_id: str,
        *,
        limit: int | None = None,
        cursor: str | None = None,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> DeliveryList:
        """The monitor's webhook events of the last 7 days."""
        call = _Call(
            "GET",
            _path(_segment("monitor_id", monitor_id), "deliveries"),
            params=_query(limit=limit, cursor=cursor),
        )
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return _delivery_list(data, request_id)

    async def stats(
        self,
        *,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> MonitorStats:
        """Counts of monitors by status and by kind of schedule."""
        data, request_id = await self._send(
            _Call("GET", _path("stats")), timeout, max_retries, extra_headers
        )
        return MonitorStats._from_json(data, request_id)

    async def bulk(
        self,
        action: BulkAction,
        *,
        ids: Sequence[str] | None = None,
        filter: BulkFilterParams | None = None,
        limit: int | None = None,
        dry_run: bool = True,
        timeout: Timeout = None,
        max_retries: int | None = None,
        extra_headers: Mapping[str, str] | None = None,
    ) -> BulkResult:
        """Pause, resume or delete many monitors. See :meth:`Monitors.bulk`."""
        call = _bulk_call(action, ids, filter, limit, dry_run)
        data, request_id = await self._send(call, timeout, max_retries, extra_headers)
        return BulkResult._from_json(data, request_id)
