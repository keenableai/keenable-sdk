"""Typed results returned by the Keenable API."""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from datetime import datetime, timezone
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


# Epoch values at or above this are milliseconds: 1e11 seconds is the year
# 5138, while 1e11 milliseconds is 1973, so no real date is ambiguous.
_EPOCH_MS_THRESHOLD = 100_000_000_000
# Values below this (1973-03-03 in seconds) are not read as epochs: they are
# far more likely a compact date such as "20261022", a bare year, or 0 for
# "unknown" than a real 1970s timestamp. The TypeScript and Go SDKs apply the
# same rules.
_EPOCH_MIN = 100_000_000
# 9999-12-31T23:59:59Z: past it a "date" is garbage, not a four-digit year.
_EPOCH_MAX = 253_402_300_799

TRUNCATION_MARKER = re.compile(
    # No leading \s*: an unanchored one rescans every whitespace run in the
    # page (seconds on a 50,000-character page). Callers trim it instead.
    r"\.{3}_This content has been truncated to stay below \d+ characters_\.{3}\s*$"
)
"""The note the API appends to fetched content cut at ``max_chars``.

Best-effort: it matches the API's current wording, and :attr:`Page.truncated`
reads ``False`` if the wording changes."""


def strip_truncation_marker(text: str) -> str:
    """Return ``text`` without a trailing truncation note, if it has one.

    For scorers and pipelines that want only page text. A model usually
    benefits from seeing the note, so :meth:`Page.to_context` keeps it.
    """
    match = TRUNCATION_MARKER.search(text)
    return text[: match.start()].rstrip() if match else text


def _iso_timestamp(value: Any) -> str | None:
    """Normalize a timestamp to ISO-8601, or None.

    Search returns ISO strings, which pass through untouched. Fetch returns a
    Unix epoch number (seconds, or milliseconds past the threshold above),
    which becomes ``YYYY-MM-DDTHH:MM:SSZ`` in UTC. A digit string too small to
    be an epoch is returned as given; such a number becomes None.
    """
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        # isascii(): str.isdigit() also accepts digits like "²" that int()
        # rejects, which would escape the SDK's error types.
        if not (text.isascii() and text.isdigit()):
            return value
        # More digits than any epoch in range: int() would also raise past
        # Python's 4300-digit limit. Same result as TypeScript and Go: unset.
        if len(text) > 20:
            return None
        if int(text) < _EPOCH_MIN:
            return value
        value = int(text)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if value < _EPOCH_MIN:
        return None
    if value >= _EPOCH_MS_THRESHOLD:
        value = value / 1000
    if value > _EPOCH_MAX:
        return None
    seconds = value
    try:
        moment = datetime.fromtimestamp(seconds, tz=timezone.utc)
    except (OverflowError, OSError, ValueError):
        return None
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


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
    """Page text extracted for this query: the field to put in a prompt.
    ``description`` is a deprecated copy of it."""

    description: str | None = None
    """Deprecated: read ``snippet``. The API no longer fills this field, so
    the SDK mirrors ``snippet`` into it for code written against it. Do not
    render both fields, or the text appears twice."""

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
            description=(
                _str_or_none(data.get("description"))
                or _str_or_none(data.get("snippet"))
            ),
            published_at=_iso_timestamp(data.get("published_at")),
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
    # Declared after ``raw`` so code that builds this dataclass positionally
    # keeps working.
    request_id: str | None = None
    """The API's ``X-Request-Id`` for this call. Quote it to support."""

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
            query=str(data.get("query") or query),
            results=results,
            mode=_str_or_none(data.get("mode")),
            request_id=request_id,
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
    """Deprecated: always empty, the API no longer fills it. Read ``content``.
    Kept for compatibility; see https://docs.keenable.ai/versioning."""

    author: str | None = None
    published_at: str | None = None
    """ISO-8601 publication time in UTC. The API sends a Unix timestamp here;
    the SDK converts it so it matches :attr:`SearchResult.published_at`."""
    raw: dict[str, Any] = field(default_factory=dict, repr=False)
    # Declared after ``raw`` so code that builds this dataclass positionally
    # keeps working.
    request_id: str | None = None
    """The API's ``X-Request-Id`` for this call. Quote it to support."""

    @classmethod
    def _from_json(
        cls, data: dict[str, Any], url: str, request_id: str | None = None
    ) -> Page:
        return cls(
            url=str(data.get("url") or url),
            title=str(data.get("title") or ""),
            content=str(data.get("content") or ""),
            description=_str_or_none(data.get("description")),
            author=_str_or_none(data.get("author")),
            published_at=_iso_timestamp(data.get("published_at")),
            request_id=request_id,
            raw=data,
        )

    @property
    def truncated(self) -> bool:
        """True when the API cut ``content`` at ``max_chars``.

        ``content`` keeps the API's trailing note; use
        :func:`strip_truncation_marker` for the bare text.
        """
        return TRUNCATION_MARKER.search(self.content) is not None

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
