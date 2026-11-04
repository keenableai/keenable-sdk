"""Typed results returned by the Keenable API."""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urljoin, urlsplit

# Default budget for the `to_context()` renderers. Roughly 3k tokens: large
# enough that a handful of results keep their substance, small enough to sit in
# front of a user question without crowding out the rest of the prompt.
DEFAULT_CONTEXT_MAX_CHARS = 12_000


def _str_or_none(value: Any) -> str | None:
    """Return a non-empty string, or None for anything else (incl. "")."""
    if isinstance(value, str) and value.strip():
        return value
    return None


def _collapse(text: str) -> str:
    """Squeeze runs of whitespace into single spaces.

    Snippets are raw page text and carry newlines. Left alone they collide with
    the blank line that separates rendered sources, so a model cannot tell where
    one source ends, and the character budget gets spent on layout.
    """
    return " ".join(text.split())


# Markup that means nothing to a model once the page is flattened into a prompt.
# The patterns are kept in step with the TypeScript and Go SDKs.
_MD_IMAGE = re.compile(r"!\[[^\]\n]*\]\([^)\n]*\)")
_HTML_IMAGE = re.compile(r"<img\b[^>]*>", re.IGNORECASE)
_MD_LINK = re.compile(r"\[([^\[\]\n]*)\]\(([^()\s]*)(?:\s+\"[^\"\n]*\")?\)")
_URL_SCHEME = re.compile(r"^[A-Za-z][A-Za-z0-9+.-]*:")
_SPACE_RUN = re.compile(r"[ \t]+")
_ONLY_TABLE_RULE = re.compile(r"^[\s|:-]*$")


def _resolve_link(match: re.Match[str], base_url: str) -> str:
    text, href = match.group(1), match.group(2)
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


def clean_context_text(text: str, base_url: str) -> str:
    """Strip markup a model cannot use from page text bound for a prompt.

    Markdown images and ``<img>`` tags are removed. Links with an absolute URL
    are kept as written; relative links are resolved against ``base_url`` (the
    page the text came from), or reduced to their text when that is not
    possible. Only lines that changed are tidied: runs of spaces squeezed, and
    the line dropped if nothing but table pipes and dashes is left. Text
    without such markup is returned unchanged.
    """
    lines = text.split("\n")
    out: list[str] = []
    for line in lines:
        cleaned = _HTML_IMAGE.sub("", _MD_IMAGE.sub("", line))
        cleaned = _MD_LINK.sub(lambda m: _resolve_link(m, base_url), cleaned)
        if cleaned == line:
            out.append(line)
            continue
        rest = cleaned.lstrip(" \t")
        indent = cleaned[: len(cleaned) - len(rest)]
        cleaned = indent + _SPACE_RUN.sub(" ", rest).rstrip()
        if _ONLY_TABLE_RULE.match(cleaned):
            continue
        out.append(cleaned)
    return "\n".join(out)


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
    """ISO-8601 timestamp of publication, when the page exposes one."""

    acquired_at: str | None = None
    """ISO-8601 timestamp of when Keenable indexed the page."""

    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    """The unmodified JSON object, so new API fields are reachable before this
    SDK models them."""

    @classmethod
    def _from_json(cls, data: dict[str, Any]) -> SearchResult:
        return cls(
            title=str(data.get("title") or ""),
            url=str(data.get("url") or ""),
            snippet=str(data.get("snippet") or ""),
            description=_str_or_none(data.get("description")),
            published_at=_str_or_none(data.get("published_at")),
            acquired_at=_str_or_none(data.get("acquired_at")),
            raw=data,
        )


def _result_body(result: SearchResult) -> str:
    """The text rendered under a search result's header, as budgeted."""
    text = result.snippet or result.description or ""
    return _collapse(clean_context_text(text, result.url))


@dataclass
class SearchResponse:
    """The result set for one :meth:`Keenable.search` call."""

    query: str
    results: list[SearchResult]
    mode: str | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    def __iter__(self) -> Iterator[SearchResult]:
        return iter(self.results)

    def __len__(self) -> int:
        return len(self.results)

    def __getitem__(self, index: int) -> SearchResult:
        return self.results[index]

    @classmethod
    def _from_json(cls, data: dict[str, Any], query: str) -> SearchResponse:
        raw_results = data.get("results")
        results = (
            [SearchResult._from_json(r) for r in raw_results if isinstance(r, dict)]
            if isinstance(raw_results, list)
            else []
        )
        return cls(
            query=str(data.get("query") or query),
            results=results,
            mode=_str_or_none(data.get("mode")),
            raw=data,
        )

    def cited(
        self,
        max_chars: int = DEFAULT_CONTEXT_MAX_CHARS,
        max_results: int | None = None,
        include_dates: bool = True,
    ) -> list[SearchResult]:
        """The results :meth:`to_context` would render, in citation order.

        Use this to print a source list that matches the citations in a model's
        answer: index ``0`` here is the source the model cites as ``[1]``.
        Without it, a caller listing every result would number sources the model
        never saw once the budget trimmed them.
        """
        selected = self.results if max_results is None else self.results[:max_results]
        kept: list[SearchResult] = []
        used = 0

        for index, result in enumerate(selected, start=1):
            body = _result_body(result)
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
    ) -> str:
        """Render the results as a numbered, citable block for a prompt.

        Each result becomes a ``[n] title (url)`` header followed by its
        snippet, which lets the model cite sources by number and lets you map
        those numbers back to URLs. Results are added whole until ``max_chars``
        is reached, so a truncated context never ends mid-sentence. Snippets
        pass through :func:`clean_context_text` first, and the budget counts
        the cleaned text; ``snippet`` itself is left untouched.

        Args:
            max_chars: Approximate character budget for the whole block.
            max_results: Keep at most this many results before the budget is
                applied.
            include_dates: Append the publication date to each header when the
                page exposes one. Useful when recency matters to the answer.
        """
        return "\n\n".join(
            _context_block(
                self._header(index, result, include_dates=include_dates),
                _result_body(result),
            )
            for index, result in enumerate(
                self.cited(
                    max_chars=max_chars,
                    max_results=max_results,
                    include_dates=include_dates,
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
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    @classmethod
    def _from_json(cls, data: dict[str, Any], url: str) -> Page:
        return cls(
            url=str(data.get("url") or url),
            title=str(data.get("title") or ""),
            content=str(data.get("content") or ""),
            description=_str_or_none(data.get("description")),
            author=_str_or_none(data.get("author")),
            published_at=_str_or_none(data.get("published_at")),
            raw=data,
        )

    def to_context(self, max_chars: int = DEFAULT_CONTEXT_MAX_CHARS) -> str:
        """Render the page as a citable block for a prompt.

        Same shape as :meth:`SearchResponse.to_context`, so a model can cite a
        fetched page the way it cites a search result instead of receiving
        anonymous markdown. Unlike search results the content is one document,
        so an oversized page is cut at the budget rather than dropped. The
        content passes through :func:`clean_context_text` before the cut;
        ``content`` itself is left untouched.
        """
        header = f"[1] {self.title} ({self.url})"
        if self.published_at:
            header += f" - published {self.published_at}"

        budget = max_chars - len(header) - 1
        if budget <= 0:
            return header
        content = clean_context_text(self.content, self.url)
        return _context_block(header, content[:budget].rstrip())
