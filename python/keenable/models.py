"""Typed results returned by the Keenable API."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

# Default budget for `to_context()`. Roughly 3k tokens: large enough that a
# handful of results keep their substance, small enough to sit in front of a
# user question without crowding out the rest of the prompt.
DEFAULT_CONTEXT_MAX_CHARS = 12_000


def _str_or_none(value: Any) -> str | None:
    """Return a non-empty string, or None for anything else (incl. "")."""
    if isinstance(value, str) and value.strip():
        return value
    return None


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
        blocks: list[str] = []
        used = 0
        selected = self.results if max_results is None else self.results[:max_results]

        for index, result in enumerate(selected, start=1):
            header = f"[{index}] {result.title} ({result.url})"
            if include_dates and result.published_at:
                header += f" - published {result.published_at}"
            body = result.snippet or result.description or ""
            block = f"{header}\n{body}".strip()

            # +2 for the blank line between blocks. Stop rather than truncate:
            # a half-sentence source reads as corrupted context to the model.
            cost = len(block) + (2 if blocks else 0)
            if blocks and used + cost > max_chars:
                break
            blocks.append(block)
            used += cost

        return "\n\n".join(blocks)


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
