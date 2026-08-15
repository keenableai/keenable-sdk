"""The search filter set, declared once.

Three consumers read this table: the client builds its request payload from it,
the tool schema generates its ``properties`` from the tool-exposed rows, and the
tool dispatcher uses those same rows as its allow-list. Adding a filter is one
row here plus the keyword on ``search()``, instead of an edit in every consumer
that can silently fall out of step.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Filter:
    """One optional search filter, as sent to the API and shown to a model."""

    name: str
    """Wire name, and the keyword argument on ``search()``."""

    description: str
    """Shown to the model when the filter is exposed as a tool parameter."""

    json_type: str = "string"

    tool_exposed: bool = False
    """Whether a model may set this filter through the search tool. The subset
    is deliberately small: a model choosing between six date and length knobs
    picks worse than one choosing between two."""


SEARCH_FILTERS: tuple[Filter, ...] = (
    Filter(
        "site",
        "Optional. Restrict results to one domain, e.g. 'arxiv.org'.",
        tool_exposed=True,
    ),
    Filter(
        "published_after",
        "Optional. Only pages published on or after this date (YYYY-MM-DD).",
        tool_exposed=True,
    ),
    Filter(
        "published_before",
        "Optional. Only pages published on or before this date (YYYY-MM-DD).",
    ),
    Filter(
        "acquired_after",
        "Optional. Only pages indexed on or after this date (YYYY-MM-DD).",
    ),
    Filter(
        "acquired_before",
        "Optional. Only pages indexed on or before this date (YYYY-MM-DD).",
    ),
    Filter(
        "snippet_max_length",
        "Optional. Cap the characters of page text returned per result.",
        json_type="integer",
    ),
)

TOOL_FILTERS: tuple[Filter, ...] = tuple(f for f in SEARCH_FILTERS if f.tool_exposed)


def tool_properties() -> dict[str, Any]:
    """The JSON-schema ``properties`` entries for the tool-exposed filters."""
    return {
        f.name: {"type": f.json_type, "description": f.description}
        for f in TOOL_FILTERS
    }


def tool_filter_kwargs(args: dict[str, Any]) -> dict[str, Any]:
    """Keep only the filters the tool schema actually offers the model."""
    return {f.name: args[f.name] for f in TOOL_FILTERS if args.get(f.name)}
