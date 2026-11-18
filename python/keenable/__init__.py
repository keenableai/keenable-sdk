"""Keenable: web search and page fetch for AI agents.

Keyless by default. ``Keenable()`` works with no account; an API key only lifts
the hourly rate limit.

    from keenable import Keenable

    keenable = Keenable()
    results = keenable.search("fastest inference providers 2026")
    context = results.to_context()
"""

from ._version import __version__
from .client import DEFAULT_BASE_URL, DEFAULT_MAX_RETRIES, AsyncKeenable, Keenable
from .errors import (
    KeenableAPIError,
    KeenableAuthError,
    KeenableConnectionError,
    KeenableCreditsError,
    KeenableError,
    KeenableInsufficientCreditsError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
    KeenableTimeoutError,
    RateLimitInfo,
    WebhookVerificationError,
)
from .models import (
    DEFAULT_CONTEXT_MAX_CHARS,
    DEFAULT_CONTEXT_MAX_SNIPPET_CHARS,
    Page,
    SearchResponse,
    SearchResult,
)
from .monitors import (
    NOT_GIVEN,
    AsyncMonitors,
    BulkResult,
    DeliveryList,
    ListPage,
    Monitor,
    MonitorDelivery,
    MonitorDiff,
    MonitorDisabledReason,
    MonitorList,
    MonitorPageTarget,
    MonitorResult,
    MonitorResultChange,
    MonitorRun,
    MonitorRunChanges,
    MonitorRunError,
    MonitorRunOutput,
    MonitorRunOutputError,
    MonitorRunUsage,
    Monitors,
    MonitorSchedule,
    MonitorSearch,
    MonitorStats,
    MonitorVersion,
    MonitorWebhook,
    PageList,
    RunList,
    VersionList,
)
from .tools import FETCH_TOOL, SEARCH_TOOL, TOOLS, arun_tool_call, run_tool_call
from .webhooks import (
    DEFAULT_WEBHOOK_TOLERANCE,
    WebhookEvent,
    WebhookEventData,
    verify_webhook,
)

__all__ = [
    "AsyncKeenable",
    "AsyncMonitors",
    "BulkResult",
    "DEFAULT_BASE_URL",
    "DEFAULT_CONTEXT_MAX_CHARS",
    "DEFAULT_CONTEXT_MAX_SNIPPET_CHARS",
    "DEFAULT_MAX_RETRIES",
    "DEFAULT_WEBHOOK_TOLERANCE",
    "DeliveryList",
    "FETCH_TOOL",
    "Keenable",
    "KeenableAPIError",
    "KeenableAuthError",
    "KeenableConnectionError",
    "KeenableCreditsError",
    "KeenableError",
    "KeenableInsufficientCreditsError",
    "KeenableInvalidRequestError",
    "KeenableRateLimitError",
    "KeenableTimeoutError",
    "ListPage",
    "Monitor",
    "MonitorDelivery",
    "MonitorDiff",
    "MonitorDisabledReason",
    "MonitorList",
    "MonitorPageTarget",
    "MonitorResult",
    "MonitorResultChange",
    "MonitorRun",
    "MonitorRunChanges",
    "MonitorRunError",
    "MonitorRunOutput",
    "MonitorRunOutputError",
    "MonitorRunUsage",
    "MonitorSchedule",
    "MonitorSearch",
    "MonitorStats",
    "MonitorVersion",
    "MonitorWebhook",
    "Monitors",
    "NOT_GIVEN",
    "Page",
    "PageList",
    "RateLimitInfo",
    "RunList",
    "SEARCH_TOOL",
    "SearchResponse",
    "SearchResult",
    "TOOLS",
    "VersionList",
    "WebhookEvent",
    "WebhookEventData",
    "WebhookVerificationError",
    "arun_tool_call",
    "run_tool_call",
    "verify_webhook",
    "__version__",
]
