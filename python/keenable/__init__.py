"""Keenable: web search and page fetch for AI agents.

Keyless by default. ``Keenable()`` works with no account; an API key only lifts
the hourly rate limit.

    from keenable import Keenable

    keenable = Keenable()
    results = keenable.search("fastest inference providers 2026")
    context = results.to_context()
"""

from .client import DEFAULT_BASE_URL, AsyncKeenable, Keenable
from .errors import (
    KeenableAPIError,
    KeenableAuthError,
    KeenableConnectionError,
    KeenableError,
    KeenableInvalidRequestError,
    KeenableRateLimitError,
)
from .models import Page, SearchResponse, SearchResult
from .tools import FETCH_TOOL, SEARCH_TOOL, TOOLS, run_tool_call

__all__ = [
    "AsyncKeenable",
    "DEFAULT_BASE_URL",
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
    "run_tool_call",
]

__version__ = "0.1.0"
