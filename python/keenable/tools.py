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
from typing import Any, Callable, NamedTuple

from ._filters import tool_filter_kwargs, tool_properties
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
                # Only the filters marked tool-exposed; see ._filters.
                **tool_properties(),
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


class _Call(NamedTuple):
    """A resolved tool call: which client method to run, and how to render it."""

    method: str
    args: tuple[Any, ...]
    kwargs: dict[str, Any]
    render: Callable[[Any], str]


def _parse_arguments(arguments: str | dict[str, Any]) -> dict[str, Any]:
    """Accept the model's raw JSON string or an already-decoded dict.

    Anything else is rejected here rather than inside ``json.loads``, which
    raises ``TypeError`` for non-strings and would escape the SDK's error
    contract: callers catching :class:`KeenableError` would still crash.
    """
    if isinstance(arguments, dict):
        return arguments
    if not isinstance(arguments, str):
        raise KeenableInvalidRequestError(
            f"tool call arguments must be a JSON string or a dict, "
            f"got {type(arguments).__name__}"
        )
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


def _require_str(value: Any, message: str) -> str:
    """Read a required string argument the model was supposed to supply."""
    if not isinstance(value, str) or not value.strip():
        raise KeenableInvalidRequestError(message)
    return value


def _plan(name: str, arguments: str | dict[str, Any]) -> _Call:
    """Resolve a tool call into the client call it stands for.

    Both entry points below share this, so sync and async cannot drift apart,
    and a new tool is one branch rather than two.
    """
    args = _parse_arguments(arguments)

    if name == "keenable_search":
        query = _require_str(args.get("query"), "keenable_search needs a 'query'")
        return _Call(
            "search",
            (query,),
            tool_filter_kwargs(args),
            lambda response: response.to_context(),
        )
    if name == "keenable_fetch":
        url = _require_str(args.get("url"), "keenable_fetch needs a 'url'")
        return _Call("fetch", (url,), {}, lambda page: page.to_context())

    raise KeenableInvalidRequestError(f"unknown Keenable tool: {name!r}")


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
        Text ready to be attached to a ``role="tool"`` message, rendered as the
        same numbered, citable block for both tools.
    """
    call = _plan(name, arguments)
    return call.render(getattr(client, call.method)(*call.args, **call.kwargs))


async def arun_tool_call(
    client: AsyncKeenable,
    name: str,
    arguments: str | dict[str, Any],
) -> str:
    """Async counterpart of :func:`run_tool_call`."""
    call = _plan(name, arguments)
    return call.render(await getattr(client, call.method)(*call.args, **call.kwargs))
