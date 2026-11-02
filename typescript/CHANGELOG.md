# Changelog

All notable changes to the `keenable` npm package. Versions follow
[semver](https://semver.org); releases are tagged `ts-v<version>`.

## 0.2.0

- From 0.2.0 the Python, TypeScript and Go SDKs share one version number and
  release together.
- Fetch's `published_at` was silently dropped because the API sends a Unix
  timestamp. It is now converted to an ISO-8601 UTC string, matching search.
- `description` on search results mirrors `snippet` when the API leaves it
  empty (it always does today), for code written against `description`. It
  stays deprecated: if you render both fields, the text now appears twice.
- `Page.truncated` reports whether fetched content was cut at the character
  limit, and `stripTruncationMarker()` removes the API's trailing note for
  callers that want bare text.
- `search()` accepts `mode="realtime"` (the fastest mode), `enableWizards` and
  `sessionId`. `mode` also accepts any other string, so a mode the API adds
  later works before this SDK names it.
- `fetch()` accepts `maxChars`, `live`, `prompt` and `sessionId`.
- New error classes by HTTP status: `KeenableValidationError` (400/422),
  `KeenableCreditsError` (402) and `KeenableForbiddenError` (403).
  `KeenableForbiddenError` extends `KeenableAuthError`, so existing handlers
  keep catching 403s, but its message no longer says "authentication failed".
- Every API error carries the API's short label, any `details`, the request id
  and a one-line next step (`.hint`). The message now ends with that step, e.g.
  "Retry after 2026-11-02T19:48:53Z." If you match on error text, update the
  match.
- A 404 says to check the URL instead of suggesting a base-URL problem.
- 429 errors expose `limit`, `remaining` and `reset`.
- Search and fetch responses carry `requestId`.

## 0.1.4

- `search()` accepts `maxResults` (1 to 50) and `queryTime`.

## 0.1.3

- `SearchResult.description` and `Page.description` are deprecated: the API no
  longer fills them. Read `snippet` / `content`.

## 0.1.2

- The request deadline and the caller's `AbortSignal` now cover the response
  body, not just the headers.

## 0.1.1

- Added `SearchResponse.cited()`: the results `toContext()` actually rendered,
  in citation order.
- Added `Page.toContext()`: a fetched page renders as the same numbered,
  citable block as search results, and `keenable_fetch` returns it.
- Added `clientSource` so an integration keeps its own traffic attribution.
- `toContext()` collapses whitespace in snippets, and skips an over-budget
  result instead of stopping at it, so citation numbers stay contiguous.
- `fetch()` refuses IPv4-mapped IPv6 addresses (`[::ffff:169.254.169.254]`)
  and trailing-dot hosts before any request is sent.
- Tool-call arguments that are not a JSON object raise
  `KeenableInvalidRequestError` instead of silently becoming "no query".
- The package version is injected at build time, so the User-Agent can't go
  stale.

## 0.1.0

- Initial release: search, fetch, `toContext()`, and the `keenable_search` /
  `keenable_fetch` tools. Keyless by default.
