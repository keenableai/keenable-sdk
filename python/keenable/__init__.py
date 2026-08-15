"""Keenable: web search and page fetch for AI agents.

Keyless by default. ``Keenable()`` works with no account; an API key only lifts
the hourly rate limit.

    from keenable import Keenable

    keenable = Keenable()
    results = keenable.search("fastest inference providers 2026")
    context = results.to_context()
"""

from ._version import __version__
from .client import DEFAULT_BASE_URL, AsyncKeenable, Keenable
from .errors import (
    KeenableAPIError,
    KeenableAuthError,
    KeenableConnectionError,
    KeenableError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
)
from .models import DEFAULT_CONTEXT_MAX_CHARS, Page, SearchResponse, SearchResult
from .tools import FETCH_TOOL, SEARCH_TOOL, TOOLS, arun_tool_call, run_tool_call

__all__ = [
    "AsyncKeenable",
    "DEFAULT_BASE_URL",
    "DEFAULT_CONTEXT_MAX_CHARS",
    "FETCH_TOOL",
    "Keenable",
    "KeenableAPIError",
    "KeenableAuthError",
    "KeenableConnectionError",
    "KeenableError",
    "KeenableInvalidRequestError",
    "KeenableRateLimitError",
    "Page",
    "SEARCH_TOOL",
    "SearchResponse",
    "SearchResult",
    "TOOLS",
    "__version__",
    "arun_tool_call",
    "run_tool_call",
]
