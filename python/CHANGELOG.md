# Changelog

All notable changes to the `keenable` Python package. Versions follow
[semver](https://semver.org); releases are tagged `python-v<version>`.

## Unreleased

- `search()` accepts `mode="realtime"` (the fastest mode), `enable_wizards` and `session_id`.
  `mode` also accepts any other string, so a mode the API adds later works
  before this SDK names it.
- `fetch()` accepts `max_chars`, `live`, `prompt` and `session_id`.
- New error classes by HTTP status: `KeenableValidationError` (400/422), `KeenableCreditsError` (402) and
  `KeenableForbiddenError` (403). `KeenableForbiddenError` subclasses `KeenableAuthError`, so existing handlers keep
  catching 403s, but its message no longer says "authentication failed".
- Every API error carries the API's short label, any `details`, the request id
  and a one-line next step (`.hint`). The message now ends
  with that step, e.g. "Retry after 2026-11-02T19:48:53Z." If you match on
  error text, update the match.
- A 404 says to check the URL instead of suggesting a base-URL problem.
- 429 errors expose `limit`, `remaining` and `reset`.
- Search and fetch responses carry `request_id`.
- The wheel now ships a `py.typed` marker, so mypy and pyright read the SDK's
  type hints instead of treating `keenable` as untyped. If you run a strict
  type checker, you may see new (correct) errors where your code passed values
  the SDK never accepted.

## 0.1.3

- `search()` accepts `max_results` (1 to 50) and `query_time`.

## 0.1.2

- `SearchResult.description` and `Page.description` are deprecated: the API no
  longer fills them. Read `snippet` / `content`.

## 0.1.1

- Added `SearchResponse.cited()`: the results `to_context()` actually rendered,
  in citation order.
- Added `Page.to_context()`: a fetched page renders as the same numbered,
  citable block as search results, and `keenable_fetch` returns it.
- Added `client_source=` so an integration keeps its own traffic attribution,
  and exported `arun_tool_call` from the package.
- `to_context()` collapses whitespace in snippets, so sources stay separated.
- `fetch()` refuses a host with a trailing dot (`localhost.`) like the bare
  host, before any request is sent.
- Tool-call arguments that are not a string or dict raise
  `KeenableInvalidRequestError` instead of escaping the SDK's error types.

## 0.1.0

- Initial release: search, fetch, `to_context()`, and the `keenable_search` /
  `keenable_fetch` tools. Keyless by default.
