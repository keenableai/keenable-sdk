"""Typed results returned by the Keenable API."""

from __future__ import annotations

import math
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urljoin, urlsplit

# Default budget for the `to_context()` renderers. Roughly 3k tokens: large
# enough that a handful of results keep their substance, small enough to sit in
# front of a user question without crowding out the rest of the prompt.
DEFAULT_CONTEXT_MAX_CHARS = 12_000

# Default per-result cap for `SearchResponse.to_context()`. Search snippets are
# often whole pages (4,000 to 13,000 characters); without a cap the first one
# or two results eat the budget and crowd out every other source.
DEFAULT_CONTEXT_MAX_SNIPPET_CHARS = 2_000


def _str_or_none(value: Any) -> str | None:
    """Return a non-empty string, or None for anything else (incl. "")."""
    if isinstance(value, str) and value.strip():
        return value
    return None


# The last Unix second with a four-digit year, 9999-12-31T23:59:59Z. A larger
# number is not a date the API sends (a millisecond value lands past it).
_MAX_UNIX_SECONDS = 253_402_300_799

# The largest integer every SDK holds exactly (JavaScript's Number.MAX_SAFE_INTEGER).
_MAX_SAFE_INTEGER = 2**53 - 1


def _timestamp_or_none(value: Any) -> str | None:
    """A date as the API sends it, as one ISO 8601 string, or None.

    Search sends ISO 8601 strings, kept as sent (when not blank). Fetch sends
    Unix seconds, which become ISO 8601 UTC to the second, such as
    ``"2024-05-01T12:00:00Z"``; a fraction is dropped. A number below 1 (the
    API omits an unknown date rather than send 0), past the year 9999, not
    finite, or a boolean is None, as is anything else.
    """
    if isinstance(value, str):
        return _str_or_none(value)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not math.isfinite(value):
        return None
    seconds = math.floor(value)
    if not 1 <= seconds <= _MAX_UNIX_SECONDS:
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def _bool_or_none(value: Any) -> bool | None:
    """A JSON boolean, or None for anything else (never ``bool()``)."""
    return value if isinstance(value, bool) else None


def _count_or_none(value: Any) -> int | None:
    """A whole number from 0 to 2**53 - 1, or None for anything else."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if isinstance(value, float) and not value.is_integer():
        return None  # Also NaN and infinities.
    if not 0 <= value <= _MAX_SAFE_INTEGER:
        return None
    return int(value)


def _str_or_empty(value: Any) -> str:
    """Return the string as sent, or "" for anything else (never ``str()``)."""
    return value if isinstance(value, str) else ""


def _collapse(text: str) -> str:
    """Squeeze runs of whitespace into single spaces.

    Snippets are raw page text and carry newlines. Left alone they collide with
    the blank line that separates rendered sources, so a model cannot tell where
    one source ends, and the character budget gets spent on layout.
    """
    return " ".join(text.split())


# Markup that means nothing to a model once the page is flattened into a prompt.
# The patterns are kept in step with the TypeScript and Go SDKs. Every repeated
# group has alternatives that start with different characters, so a match
# attempt never backtracks into itself, and each attempt stops at the next
# bracket or parenthesis: cleaning stays linear on hostile input.
#
# Image alt text may hold one level of [brackets] and the URL one level of
# (parentheses), as in Wikipedia's File_(1).png; a title rides along inside.
_MD_IMAGE = re.compile(
    r"!\[(?:[^\[\]\n]|\[[^\[\]\n]*\])*\]\((?:[^()\n]|\([^()\n]*\))*\)"
)
_HTML_IMAGE = re.compile(r"<img\b(?:[^<>\"']|\"[^\"\n]*\"|'[^'\n]*')*>", re.IGNORECASE)
_MD_LINK = re.compile(
    r"\[([^\[\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+\"[^\"\n]*\")?\)"
)
_URL_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_SPACE_RUN = re.compile(r"[ \t]+")
_ONLY_TABLE_RULE = re.compile(r"^[ \t|:-]*$")
# CommonMark: optional blockquote markers, then at most 3 spaces before a fence.
_FENCE = re.compile(r"^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})(.*)$")
_PLACEHOLDER = re.compile(r"\x00(\d+)\x00")
_WORD_CHAR = re.compile(r"[A-Za-z0-9_]")
_CODE_IDENT = re.compile(r"^[A-Za-z0-9_]*$")


def _resolve_link(match: re.Match[str], base_url: str) -> str:
    text, href = match.group(1), match.group(2)
    start = match.start()
    # `handlers[name](event)` and `fns[i]()` are code, not links. Ordinary
    # adjacent links like `docs[API](/api)` still resolve.
    if (
        start > 0
        and _WORD_CHAR.match(match.string[start - 1])
        and _CODE_IDENT.match(href)
    ):
        return match.group(0)
    # A code span inside the URL would not survive URL normalisation.
    if "\x00" in href:
        return match.group(0)
    if not text.strip():
        return ""
    if _URL_SCHEME.match(href):
        return match.group(0)
    if not href:
        return text
    try:
        base = urlsplit(base_url)
        if base.scheme not in ("http", "https") or not base.netloc:
            return text
        return f"[{text}]({urljoin(base_url, href)})"
    except ValueError:
        return text


def _protect_code_spans(line: str) -> tuple[str, list[str]]:
    """Swap inline code spans for placeholders the cleanup patterns skip.

    Opening and closing backtick runs must be the same length, so a shorter
    run inside a longer span (``a ` ![x](y)``) stays protected.
    """
    spans: list[str] = []
    if "\x00" in line:
        return line, spans

    out: list[str] = []
    i = 0
    n = len(line)
    while i < n:
        if line[i] != "`":
            out.append(line[i])
            i += 1
            continue
        j = i
        while j < n and line[j] == "`":
            j += 1
        open_len = j - i
        k = j
        closer = -1
        while k < n:
            if line[k] != "`":
                k += 1
                continue
            end = k
            while end < n and line[end] == "`":
                end += 1
            if end - k == open_len:
                closer = end
                break
            k = end
        if closer < 0:
            out.append(line[i:j])
            i = j
            continue
        spans.append(line[i:closer])
        out.append(f"\x00{len(spans) - 1}\x00")
        i = closer
    return "".join(out), spans


def _restore_code_spans(text: str, spans: list[str]) -> str:
    if not spans:
        return text
    return _PLACEHOLDER.sub(lambda m: spans[int(m.group(1))], text)


def _is_table_delimiter(line: str) -> bool:
    return "|" in line and "-" in line and bool(_ONLY_TABLE_RULE.match(line.rstrip()))


def _cell_pipes(line: str) -> int:
    """How many ``|`` in ``line`` separate cells.

    A pipe after an odd run of backslashes (``\\|``, ``\\\\\\|``) is
    escaped; after an even run (``\\\\|``) the backslashes escape each other.
    """
    count = 0
    backslashes = 0
    for ch in line:
        if ch == "\\":
            backslashes += 1
            continue
        if ch == "|" and backslashes % 2 == 0:
            count += 1
        backslashes = 0
    return count


def _looks_like_row(line: str) -> bool:
    """Whether ``line`` has a row's shape on its own: ``| a | b |``.

    It must start and end with a cell pipe and hold at least two cells, so
    prose that merely starts with a pipe (``|x| is ...``) is not a row.
    """
    trimmed = line.strip(" \t\r")
    if not (trimmed.startswith("|") and trimmed.endswith("|")):
        return False
    body = trimmed[:-1]
    escapes = len(body) - len(body.rstrip("\\"))
    return escapes % 2 == 0 and _cell_pipes(trimmed) >= 3


def _table_cells(line: str) -> list[str]:
    """The non-empty cells of a table row, trimmed, with ``\\|`` read as ``|``."""
    cells: list[str] = []
    cell: list[str] = []
    backslashes = 0
    for ch in line:
        if ch == "|" and backslashes % 2 == 1:
            cell[-1] = "|"
        elif ch == "|":
            cells.append("".join(cell))
            cell = []
        else:
            cell.append(ch)
            backslashes = backslashes + 1 if ch == "\\" else 0
            continue
        backslashes = 0
    cells.append("".join(cell))
    return [c for c in (_SPACE_RUN.sub(" ", c).strip() for c in cells) if c]


def _clean_context_text(text: str, base_url: str) -> str:
    """Strip markup a model cannot use from page text bound for a prompt.

    Markdown images and ``<img>`` tags are removed. Links with an absolute URL
    are kept as written; relative links are resolved against ``base_url`` (the
    page the text came from), or reduced to their text when that is not
    possible. Markdown tables are flattened: delimiter rows (``|---|:-:|``)
    are dropped, and each row becomes its non-empty cells joined with " · "
    and ended with ";" (``\\|`` is a literal pipe), so rows stay apart once
    whitespace is collapsed; a row left with no cells is dropped. A line is
    a row when it sits under another row or over a delimiter row, or has a
    row's shape on its own (``| a | b |``). Fenced
    code blocks and inline code spans are left alone, and so is
    ``name[i](x)``, which is code rather than a link. Other lines are tidied
    only if they changed: runs of spaces squeezed, and the line dropped if
    nothing but pipes and dashes is left. Text without images, links or tables
    is returned unchanged.
    """
    lines = text.split("\n")
    out: list[str] = []
    fence: str | None = None
    in_table = False
    for i, line in enumerate(lines):
        marker = _FENCE.match(line)
        if fence is not None:
            out.append(line)
            if (
                marker
                and marker.group(1)[0] == fence[0]
                and len(marker.group(1)) >= len(fence)
                and not marker.group(2).strip()
            ):
                fence = None
            continue
        if marker and not (marker.group(1)[0] == "`" and "`" in marker.group(2)):
            fence = marker.group(1)
            in_table = False
            out.append(line)
            continue
        if _is_table_delimiter(line):
            in_table = True
            continue

        protected, spans = _protect_code_spans(line)
        cleaned = _HTML_IMAGE.sub("", _MD_IMAGE.sub("", protected))
        cleaned = _MD_LINK.sub(lambda m: _resolve_link(m, base_url), cleaned)
        # A table row has a cell pipe and sits under another row or over a
        # delimiter row, or has a row's shape on its own (a snippet can start
        # below the header).
        if _cell_pipes(cleaned) and (
            in_table
            or (i + 1 < len(lines) and _is_table_delimiter(lines[i + 1]))
            or _looks_like_row(cleaned)
        ):
            in_table = True
            cells = _table_cells(cleaned)
            if cells:
                row = _restore_code_spans(" · ".join(cells), spans)
                out.append(row if row.endswith(";") else row + ";")
            continue
        in_table = False
        if cleaned == protected:
            out.append(line)
            continue
        rest = cleaned.lstrip(" \t")
        indent = cleaned[: len(cleaned) - len(rest)]
        cleaned = indent + _SPACE_RUN.sub(" ", rest).rstrip()
        if _ONLY_TABLE_RULE.match(cleaned):
            continue
        out.append(_restore_code_spans(cleaned, spans))
    return "\n".join(out)


def _cap_snippet(text: str, limit: int | None) -> str:
    """Cut ``text`` to ``limit`` characters at a word boundary, ending in "…".

    The cut falls at the last space at or before ``limit`` (a hard cut when
    there is none). Text at or under the limit is returned as is.
    """
    if limit is None or limit < 1 or len(text) <= limit:
        return text
    space = text.rfind(" ", 0, limit + 1)
    head = text[:space] if space > 0 else text[:limit]
    return head.rstrip() + "…"


def _context_block(header: str, body: str) -> str:
    """One rendered source: its header line, then its text."""
    return f"{header}\n{body}" if body else header


@dataclass
class SearchResult:
    """A single web page returned by :meth:`Keenable.search`."""

    title: str
    url: str
    snippet: str
    """Page text extracted for this query. This is the field to put in a
    prompt: it carries the actual content, unlike ``description``."""

    description: str | None = None
    """Deprecated: always empty, the API no longer fills it. Read ``snippet``.
    Kept for compatibility; see https://docs.keenable.ai/versioning."""

    published_at: str | None = None
    """ISO-8601 timestamp of publication, when the page exposes one. A date the
    API sends as Unix seconds is given as ISO 8601 UTC, such as
    ``"2024-05-01T12:00:00Z"``."""

    acquired_at: str | None = None
    """ISO-8601 timestamp of when Keenable indexed the page, in the same form
    as ``published_at``."""

    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    """The unmodified JSON object, so new API fields are reachable before this
    SDK models them."""

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> SearchResult:
        return cls(
            title=_str_or_empty(data.get("title")),
            url=_str_or_empty(data.get("url")),
            snippet=_str_or_empty(data.get("snippet")),
            description=_str_or_none(data.get("description")),
            published_at=_timestamp_or_none(data.get("published_at")),
            acquired_at=_timestamp_or_none(data.get("acquired_at")),
            raw=data,
        )


def _result_body(result: SearchResult, max_snippet_chars: int | None) -> str:
    """The text rendered under a search result's header, as budgeted."""
    text = result.snippet or result.description or ""
    return _cap_snippet(
        _collapse(_clean_context_text(text, result.url)), max_snippet_chars
    )


@dataclass
class SearchResponse:
    """The result set for one :meth:`Keenable.search` call."""

    query: str
    results: list[SearchResult]
    mode: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    request_id: str | None = None
    """The API's id for this request. Quote it when reporting a problem."""

    def __iter__(self) -> Iterator[SearchResult]:
        return iter(self.results)

    def __len__(self) -> int:
        return len(self.results)

    def __getitem__(self, index: int) -> SearchResult:
        return self.results[index]

    @classmethod
    def _from_json(
        cls, data: dict[str, Any], query: str, request_id: str | None = None
    ) -> SearchResponse:
        raw_results = data.get("results")
        results = (
            [SearchResult._from_json(r) for r in raw_results if isinstance(r, dict)]
            if isinstance(raw_results, list)
            else []
        )
        return cls(
            # A blank or non-string echo keeps the query asked, as TS and Go do.
            query=_str_or_none(data.get("query")) or query,
            results=results,
            mode=_str_or_none(data.get("mode")),
            raw=data,
            request_id=_str_or_none(data.get("request_id")) or request_id,
        )

    def cited(
        self,
        max_chars: int = DEFAULT_CONTEXT_MAX_CHARS,
        max_results: int | None = None,
        include_dates: bool = True,
        max_snippet_chars: int | None = DEFAULT_CONTEXT_MAX_SNIPPET_CHARS,
    ) -> list[SearchResult]:
        """The results :meth:`to_context` would render, in citation order.

        Use this to print a source list that matches the citations in a model's
        answer: index ``0`` here is the source the model cites as ``[1]``.
        Without it, a caller listing every result would number sources the model
        never saw once the budget trimmed them. Takes the same arguments as
        :meth:`to_context`.
        """
        selected = self.results if max_results is None else self.results[:max_results]
        kept: list[SearchResult] = []
        used = 0

        for index, result in enumerate(selected, start=1):
            body = _result_body(result, max_snippet_chars)
            header = self._header(index, result, include_dates=include_dates)
            # Measure before building: past the budget the block is discarded,
            # and each discarded snippet is kilobytes of throwaway string.
            block_len = len(header) + (1 + len(body) if body else 0)
            cost = block_len + (2 if kept else 0)  # +2 for the separating line
            if kept and used + cost > max_chars:
                break
            kept.append(result)
            used += cost

        return kept

    def to_context(
        self,
        max_chars: int = DEFAULT_CONTEXT_MAX_CHARS,
        max_results: int | None = None,
        include_dates: bool = True,
        max_snippet_chars: int | None = DEFAULT_CONTEXT_MAX_SNIPPET_CHARS,
    ) -> str:
        """Render the results as a numbered, citable block for a prompt.

        Each result becomes a ``[n] title (url)`` header followed by its
        snippet, which lets the model cite sources by number and lets you map
        those numbers back to URLs. Snippets are cleaned first (images
        dropped, relative links resolved, tables flattened), then each is cut
        to ``max_snippet_chars`` at a word boundary and ends in "…". Results
        are then added whole until ``max_chars`` is reached, and the budget
        counts the cleaned, capped text; ``snippet`` itself is left untouched.
        The first result is always kept, even if it alone exceeds
        ``max_chars``.

        Args:
            max_chars: Approximate character budget for the whole block.
            max_results: Keep at most this many results before the budget is
                applied.
            include_dates: Append the publication date to each header when the
                page exposes one. Useful when recency matters to the answer.
            max_snippet_chars: Cap each result's text at about this many
                characters (plus the "…"), so one whole-page snippet cannot
                take the whole budget. ``None`` means no cap; a value below 1
                also disables the cap (in Go, 0 means the default and a
                negative value disables it).
        """
        return "\n\n".join(
            _context_block(
                self._header(index, result, include_dates=include_dates),
                _result_body(result, max_snippet_chars),
            )
            for index, result in enumerate(
                self.cited(
                    max_chars=max_chars,
                    max_results=max_results,
                    include_dates=include_dates,
                    max_snippet_chars=max_snippet_chars,
                ),
                start=1,
            )
        )

    @staticmethod
    def _header(index: int, result: SearchResult, include_dates: bool = True) -> str:
        header = f"[{index}] {result.title} ({result.url})"
        if include_dates and result.published_at:
            header += f" - published {result.published_at}"
        return header


@dataclass
class Page:
    """A web page fetched by :meth:`Keenable.fetch`, extracted as markdown."""

    url: str
    title: str
    content: str
    """The page's main content as markdown, with navigation and boilerplate
    stripped."""

    description: str | None = None
    """Deprecated: always empty, the API no longer fills it. Read ``content``.
    Kept for compatibility; see https://docs.keenable.ai/versioning."""

    author: str | None = None
    published_at: str | None = None
    """When the page was published, as ISO 8601. The API sends Unix seconds
    for a fetch; they are given in UTC to the second, such as
    ``"2024-05-01T12:00:00Z"``, the form search results use. None when
    unknown."""

    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    request_id: str | None = None
    """The API's id for this request. Quote it when reporting a problem."""

    truncated: bool | None = None
    """True when the page was longer than the API's ``max_chars`` and
    ``content`` was cut (cut content ends with ``...``). None when the API did
    not say."""

    total_chars: int | None = None
    """Length of the full extracted content in Unicode code points, before
    any cut. None when the API did not say."""

    @classmethod
    def _from_json(
        cls, data: dict[str, Any], url: str, request_id: str | None = None
    ) -> Page:
        return cls(
            url=_str_or_none(data.get("url")) or url,
            title=_str_or_empty(data.get("title")),
            content=_str_or_empty(data.get("content")),
            description=_str_or_none(data.get("description")),
            author=_str_or_none(data.get("author")),
            published_at=_timestamp_or_none(data.get("published_at")),
            raw=data,
            request_id=_str_or_none(data.get("request_id")) or request_id,
            truncated=_bool_or_none(data.get("truncated")),
            total_chars=_count_or_none(data.get("total_chars")),
        )

    def to_context(self, max_chars: int = DEFAULT_CONTEXT_MAX_CHARS) -> str:
        """Render the page as a citable block for a prompt.

        Same shape as :meth:`SearchResponse.to_context`, so a model can cite a
        fetched page the way it cites a search result instead of receiving
        anonymous markdown. Unlike search results the content is one document,
        so an oversized page is cut at the budget rather than dropped. The
        content is cleaned the same way before the cut; ``content`` itself is
        left untouched.
        """
        header = f"[1] {self.title} ({self.url})"
        if self.published_at:
            header += f" - published {self.published_at}"

        budget = max_chars - len(header) - 1
        if budget <= 0:
            return header
        content = _clean_context_text(self.content, self.url)
        return _context_block(header, content[:budget].rstrip())
