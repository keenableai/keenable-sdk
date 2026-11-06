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
        "Optional. Restrict results to one domain, e.g. 'arxiv.org'. "
        "For several domains use include_domains.",
        tool_exposed=True,
    ),
    Filter(
        "include_domains",
        "Optional. Only return results from these hosts, e.g. 'un.org', which "
        "also matches its subdomains. Hosts only: paths and suffixes like "
        "'.gov' are rejected. Up to 50. Do not combine with site.",
        json_type="array",
        tool_exposed=True,
    ),
    Filter(
        "exclude_domains",
        "Optional. Never return results from these hosts, up to 200. Same "
        "host form as include_domains; a host in both lists is an error.",
        json_type="array",
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
    Filter(
        "max_results",
        "Optional. How many results to return, 1 to 50. The API default is 10.",
        json_type="integer",
    ),
    Filter(
        "query_time",
        "Optional. Search the index as it stood at this moment: pages newer "
        "than it are excluded. Not a recency filter (use published_after for "
        "that). An ISO 8601 datetime, YYYY-MM-DD, or an offset back from now "
        "such as '7d'.",
    ),
)

TOOL_FILTERS: tuple[Filter, ...] = tuple(f for f in SEARCH_FILTERS if f.tool_exposed)


def _schema(f: Filter) -> dict[str, Any]:
    if f.json_type == "array":
        return {
            "type": "array",
            "items": {"type": "string"},
            "description": f.description,
        }
    return {"type": f.json_type, "description": f.description}


def tool_properties() -> dict[str, Any]:
    """The JSON-schema ``properties`` entries for the tool-exposed filters."""
    return {f.name: _schema(f) for f in TOOL_FILTERS}


def tool_filter_kwargs(args: dict[str, Any]) -> dict[str, Any]:
    """Keep only the filters the tool schema actually offers the model."""
    kwargs: dict[str, Any] = {}
    for f in TOOL_FILTERS:
        value = args.get(f.name)
        if f.json_type == "array":
            if value is None or value == "":
                continue
            if isinstance(value, str):
                value = [value]
        elif not value:
            continue
        kwargs[f.name] = value
    return kwargs
