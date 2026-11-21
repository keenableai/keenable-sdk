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
from .errors import KeenableAPIError, KeenableInvalidRequestError
from .models import DEFAULT_CONTEXT_MAX_CHARS, FetchError, FetchResponse

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
            "Fetch up to 20 web pages and return each one's main content as "
            "markdown. Use after keenable_search when a search snippet is not "
            "enough. Add a prompt to get back only the part you need from long "
            "pages."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "urls": {
                    "type": "array",
                    "items": {"type": "string"},
                    "minItems": 1,
                    "maxItems": 20,
                    "description": "The URLs of the pages to read, 1 to 20.",
                },
                "max_chars": {
                    "type": "integer",
                    "minimum": 1,
                    "description": (
                        "The most characters of content to return for each page."
                    ),
                },
                "prompt": {
                    "type": "string",
                    "description": (
                        "An instruction applied to every page; each page's content "
                        "is then only the answer to it. Use it to get one detail "
                        "from long pages."
                    ),
                },
                "max_age_hours": {
                    "type": "number",
                    "minimum": 0,
                    "maximum": 720,
                    "description": (
                        "How old Keenable's stored copy may be, in hours; an older "
                        "copy is read again from the source. 0 reads every page live."
                    ),
                },
            },
            "required": ["urls"],
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


def _page_error(e: FetchError) -> KeenableAPIError:
    """A failed URL's error, raised as the API error it stands for."""
    return KeenableAPIError(
        e.message or e.error or "the page could not be read",
        e.status,
        code=e.code,
        type=e.type,
        error=e.error,
        fix=e.fix,
        retryable=e.retryable,
    )


def _pages_context(response: FetchResponse, max_chars: Any) -> str:
    """Each page as a numbered, citable block; a failed URL as an error block.

    Raised only when no URL could be read.
    """
    pages = response.results
    if not pages:
        raise KeenableAPIError("the Keenable API returned no result for the URL", 200)
    failed = [page.error for page in pages if page.error is not None]
    if len(failed) == len(pages):
        raise _page_error(failed[0])
    # The API already cut each page to max_chars; leave room for its header.
    # Without max_chars, the default budget is split across the pages.
    budget = max(DEFAULT_CONTEXT_MAX_CHARS // len(pages), 1_000)
    if isinstance(max_chars, int) and not isinstance(max_chars, bool):
        budget = max_chars + 1_000
    blocks = []
    for n, page in enumerate(pages, 1):
        if page.error is None:
            blocks.append(f"[{n}]" + page.to_context(budget)[len("[1]") :])
        else:
            e = page.error
            message = e.message or e.error or "the page could not be read"
            blocks.append(f"[{n}] {page.url} - failed: {message}")
    return "\n\n".join(blocks)


def _fetch_urls(args: dict[str, Any]) -> list[str]:
    """The ``urls`` a model sent: 1 to 20 non-blank strings."""
    raw = args.get("urls")
    urls = [raw] if isinstance(raw, str) else raw
    if (
        not isinstance(urls, list)
        or not urls
        or not all(isinstance(u, str) and u.strip() for u in urls)
    ):
        raise KeenableInvalidRequestError(
            "keenable_fetch needs 'urls': a list of 1 to 20 URLs"
        )
    return urls


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
        options = {
            key: args[key]
            for key in ("max_chars", "prompt", "max_age_hours")
            if args.get(key) not in (None, "")
        }
        return _Call(
            "fetch",
            (_fetch_urls(args),),
            options,
            lambda response: _pages_context(response, options.get("max_chars")),
        )

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
        same numbered, citable block for both tools. A URL that failed while
        others were read becomes an error block; if none was read, its error
        is raised.
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
