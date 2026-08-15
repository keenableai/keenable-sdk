"""Typed results returned by the Keenable API."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

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
    """The page's meta description. Often absent; prefer ``snippet``."""

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
            body = _collapse(result.snippet or result.description or "")
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
        is reached, so a truncated context never ends mid-sentence.

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
                _collapse(result.snippet or result.description or ""),
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
        so an oversized page is cut at the budget rather than dropped.
        """
        header = f"[1] {self.title} ({self.url})"
        if self.published_at:
            header += f" - published {self.published_at}"

        budget = max_chars - len(header) - 1
        if budget <= 0:
            return header
        return _context_block(header, self.content[:budget].rstrip())
