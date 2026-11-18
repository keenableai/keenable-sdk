"""Keenable: web search and page fetch for AI agents.

Keyless by default. ``Keenable()`` works with no account; an API key only lifts
the hourly rate limit.

    from keenable import Keenable

    keenable = Keenable()
    results = keenable.search("fastest inference providers 2026")
    context = results.to_context()
"""

from ._version import __version__
from .client import (
    DEFAULT_BASE_URL,
    DEFAULT_MAX_RETRIES,
    AsyncKeenable,
    FetchContentOptions,
    FetchOutputOptions,
    FetchRetrievalOptions,
    Keenable,
)
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
)
from .models import (
    DEFAULT_CONTEXT_MAX_CHARS,
    DEFAULT_CONTEXT_MAX_SNIPPET_CHARS,
    Citation,
    FetchContent,
    FetchError,
    FetchImage,
    FetchLink,
    FetchNotice,
    FetchOutput,
    FetchResponse,
    FetchResult,
    FetchSummary,
    Grounding,
    Page,
    SearchResponse,
    SearchResult,
)
from .tools import FETCH_TOOL, SEARCH_TOOL, TOOLS, arun_tool_call, run_tool_call

__all__ = [
    "AsyncKeenable",
    "DEFAULT_BASE_URL",
    "DEFAULT_CONTEXT_MAX_CHARS",
    "DEFAULT_CONTEXT_MAX_SNIPPET_CHARS",
    "DEFAULT_MAX_RETRIES",
    "FETCH_TOOL",
    "Citation",
    "FetchContent",
    "FetchContentOptions",
    "FetchError",
    "FetchImage",
    "FetchLink",
    "FetchNotice",
    "FetchOutput",
    "FetchOutputOptions",
    "FetchResponse",
    "FetchResult",
    "FetchRetrievalOptions",
    "FetchSummary",
    "Grounding",
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
    "Page",
    "RateLimitInfo",
    "SEARCH_TOOL",
    "SearchResponse",
    "SearchResult",
    "TOOLS",
    "__version__",
    "arun_tool_call",
    "run_tool_call",
]
