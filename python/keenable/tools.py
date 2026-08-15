"""Ready-made tool definitions for OpenAI-compatible tool calling.

Every major inference API (Cerebras, OpenAI, and anything speaking the same
schema) takes tools in this shape, so these constants can be passed straight
into a ``chat.completions.create(tools=...)`` call:

    from keenable import Keenable, TOOLS, run_tool_call

    tools = TOOLS  # search + fetch
    ...
    output = run_tool_call(keenable, tool_call.function.name,
                           tool_call.function.arguments)
"""

from __future__ import annotations

import json
from typing import Any

from .client import AsyncKeenable, Keenable
from .errors import KeenableInvalidRequestError

__all__ = ["SEARCH_TOOL", "FETCH_TOOL", "TOOLS", "run_tool_call", "arun_tool_call"]

SEARCH_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "keenable_search",
        "description": (
            "Search the web for current information. Returns ranked pages with "
            "their title, URL and extracted page text. Use this whenever the "
            "answer depends on recent events or facts you are unsure about."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": (
                        "What to look for, described in natural language "
                        "rather than keywords."
                    ),
                },
                "site": {
                    "type": "string",
                    "description": (
                        "Optional. Restrict results to one domain, e.g. 'arxiv.org'."
                    ),
                },
                "published_after": {
                    "type": "string",
                    "description": (
                        "Optional. Only pages published on or after this date "
                        "(YYYY-MM-DD)."
                    ),
                },
            },
            "required": ["query"],
        },
    },
}

FETCH_TOOL: dict[str, Any] = {
    "type": "function",
    "function": {
        "name": "keenable_fetch",
        "description": (
            "Fetch one web page and return its main content as markdown. Use "
            "after keenable_search when a search snippet is not enough."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "The URL of the page to read.",
                },
            },
            "required": ["url"],
        },
    },
}

TOOLS: list[dict[str, Any]] = [SEARCH_TOOL, FETCH_TOOL]


def _parse_arguments(arguments: str | dict[str, Any]) -> dict[str, Any]:
    """Accept the model's raw JSON string or an already-decoded dict."""
    if isinstance(arguments, dict):
        return arguments
    try:
        parsed = json.loads(arguments or "{}")
    except json.JSONDecodeError as exc:
        raise KeenableInvalidRequestError(
            f"tool call arguments are not valid JSON: {arguments!r}"
        ) from exc
    if not isinstance(parsed, dict):
        raise KeenableInvalidRequestError(
            f"tool call arguments must be a JSON object, got {parsed!r}"
        )
    return parsed


def _search_kwargs(args: dict[str, Any]) -> dict[str, Any]:
    """Keep only the arguments the tool schema exposes to the model."""
    allowed = ("site", "published_after")
    return {name: args[name] for name in allowed if args.get(name)}


def run_tool_call(
    client: Keenable,
    name: str,
    arguments: str | dict[str, Any],
) -> str:
    """Execute one tool call and return the string to send back as the result.

    Args:
        client: The :class:`Keenable` client to run the call against.
        name: The tool name the model chose (``keenable_search`` or
            ``keenable_fetch``).
        arguments: The model's arguments, as the raw JSON string from the API
            or an already-decoded dict.

    Returns:
        Text ready to be attached to a ``role="tool"`` message.
    """
    args = _parse_arguments(arguments)
    if name == "keenable_search":
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            raise KeenableInvalidRequestError("keenable_search needs a 'query'")
        return client.search(query, **_search_kwargs(args)).to_context()
    if name == "keenable_fetch":
        url = args.get("url")
        if not isinstance(url, str) or not url.strip():
            raise KeenableInvalidRequestError("keenable_fetch needs a 'url'")
        return client.fetch(url).content
    raise KeenableInvalidRequestError(f"unknown Keenable tool: {name!r}")


async def arun_tool_call(
    client: AsyncKeenable,
    name: str,
    arguments: str | dict[str, Any],
) -> str:
    """Async counterpart of :func:`run_tool_call`."""
    args = _parse_arguments(arguments)
    if name == "keenable_search":
        query = args.get("query")
        if not isinstance(query, str) or not query.strip():
            raise KeenableInvalidRequestError("keenable_search needs a 'query'")
        response = await client.search(query, **_search_kwargs(args))
        return response.to_context()
    if name == "keenable_fetch":
        url = args.get("url")
        if not isinstance(url, str) or not url.strip():
            raise KeenableInvalidRequestError("keenable_fetch needs a 'url'")
        page = await client.fetch(url)
        return page.content
    raise KeenableInvalidRequestError(f"unknown Keenable tool: {name!r}")
