# Changelog

All notable changes to the `keenable` npm package. Versions follow
[semver](https://semver.org); releases are tagged `ts-v<version>`.

## Unreleased

- Errors carry the API's agent-ready fields: `code`, `error`, `fix`, `docsUrl`,
  `retryable`, `retryAfterSeconds` (from the body, else the `Retry-After`
  header), `requestId` (body, else `X-Request-Id`), `param`, `limit` (a new
  `RateLimitInfo` type), `billingUrl`, `autoTopUpUrl`, `payPerRequest` and
  `raw`. Each is `undefined` when the API does not send it.
- New `KeenableInsufficientCreditsError` (alias `KeenableCreditsError`) for HTTP 402. It extends
  `KeenableAPIError`, and the message is unchanged, so existing handlers keep
  working.
- A 403 whose `code` is `target_blocked` (the fetched site refused us) is now a
  plain `KeenableAPIError` labelled "Keenable API error (403)" rather than a
  `KeenableAuthError`. Without a `code`, 401/403 behave as before.
- When the API sends `fix`, the error message ends with it (". <fix>"), as in
  the Go and Python SDKs. A `Retry-After` header is capped at a year, so an
  oversized value can never break error handling. The same year cap applies to
  a far-future `Retry-After` date and to the body's `retry_after_seconds` and
  `retryAfter`; a body value too large for a double (such as `1e400`) is
  dropped and the next source of the delay is used, as in the other SDKs.
- Errors carry the API's `type` (error format v1, new `KeenableErrorType`):
  `invalid_request_error`, `authentication_error`, `permission_error`,
  `billing_error`, `rate_limit_error`, `target_error` or `api_error`. An API
  that does not send it gets one derived from the status and `code`, so `type`
  is set on every `KeenableAPIError` from a response. A 401/403 whose type is
  `target_error` is not a `KeenableAuthError` (as `target_blocked` already was).
- `error.message` ends with `Docs: <docsUrl>`, `(code: <code>)` and
  `(request_id: <id>)` when the API sends them, the way Stripe's SDKs print the
  doc link and request id. `body` is unchanged, and so is the message of a
  response without any of these fields.
  A message that already ends in a period no longer gets a second one before
  the fix.

- `toContext()` (search results and fetched pages) drops markdown images and
  `<img>` tags, and resolves relative links against the result's URL (or keeps
  just the link text when it cannot). Absolute links are unchanged, and lines
  left holding only pipes and dashes are dropped. The `maxChars` budget counts
  the cleaned text. Fenced code blocks, inline code and `name[i](x)` calls are
  left alone. `snippet` and `content` are untouched.

- `toContext()` (search results and fetched pages) flattens markdown tables:
  delimiter rows (`|---|:-:|`) are dropped, and each row becomes its non-empty
  cells joined with " · " and ended with ";" (one is not added when the last
  cell already ends in ";"), so rows stay apart once a search snippet's
  whitespace is collapsed. A line is a row when it sits under another
  row or over a delimiter row, or looks like one on its own (`| a | b |`), so
  prose such as `|x| is ...` is left alone. A pipe after an odd run of
  backslashes (`\|`) is a literal pipe. A row left with no cells,
  such as one that held only avatar images, is dropped. Tables inside fenced
  code are left alone, and a pipe inside inline code does not split a cell.

- `SearchResponse.toContext()` and `cited()` take `maxSnippetChars` (default 2000,
  new constant `DEFAULT_CONTEXT_MAX_SNIPPET_CHARS`): each result's cleaned text
  is cut at the last space at or before that many characters and ends in "…",
  so one whole-page snippet no longer takes the whole `maxChars` budget. The
  budget counts the capped text. Pass `null` for the old uncapped behaviour;
  a value below 1 also disables the cap (in Go, 0 means the default and a negative value disables it).
  `Page.toContext()` is unchanged.

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
