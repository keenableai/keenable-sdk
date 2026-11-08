# Changelog

## Unreleased

`APIError` carries the API's agent-ready fields: `APICode`, `Title`, `Fix`,
`DocsURL`, `Retryable`, `RetryAfter` (from the body's `retry_after_seconds`,
else the `Retry-After` header), `Param`, `RateLimit` (a new `RateLimitInfo`),
`BillingURL`, `AutoTopUpURL`, `PayPerRequest` and `Raw`. `RequestID` now
prefers the body's `request_id` over the header. Each is its zero value when
the API does not send it. New `InsufficientCreditsError` (alias `CreditsError`) for HTTP 402 unwraps
to `APIError` and keeps `Code()` `api_error` and the old message. When the API
sends `Fix`, the message ends with it instead of the SDK's generic advice, for
every status (as in the Python and TypeScript SDKs); a 429 for a limit that is
not the caller's (`search_rate_limited`, `fetch_rate_limited`,
`target_rate_limited`) never gets the API-key advice, and a 429 with `RetryAfter` but no
`X-RateLimit-Reset` says "Retry after <duration>". A 403 with code
`target_blocked` is a plain `APIError`, not an `AuthError`. Responses without
the new fields produce the same errors and messages as before. A digit-only
`Retry-After` too large for a uint64 is capped at a year like other large values, and so is a `Retry-After` date more than a year ahead (a date centuries ahead no longer gives a negative `RetryAfter`). An error body whose `retry_after_seconds` is too large for a float64 (such as `1e400`) keeps its code and type; that value is dropped and the next source of the delay is used, as in the other SDKs. No migration.

`APIError.Type` carries the API's error type (error format v1), with constants
`TypeInvalidRequestError`, `TypeAuthenticationError`, `TypePermissionError`,
`TypeBillingError`, `TypeRateLimitError`, `TypeTargetError` and `TypeAPIError`.
An API that does not send it gets one derived from the status and `APICode`, so
`Type` is set on every error response. A 401/403 whose type is `target_error`
is not an `AuthError` (as `target_blocked` already was). When the API sends
`DocsURL`, `Error()` adds "Docs: <DocsURL>" before the `(request_id: ...)` it
already printed, the way Stripe's SDKs print the doc link, and when it sends a
`code` it adds `(code: <APICode>)` just before the request id. The
`(request_id: ...)` text, `Code()` and the final parentheses are unchanged. A message that already ends in a period no
longer gets a second one before `Fix`. No migration.

`ToContext` (on `SearchResponse` and `Page`) drops markdown images and `<img>`
tags, and resolves relative links against the result's URL (or keeps just the
link text when it cannot). Absolute links are unchanged, and lines left holding
only pipes and dashes are dropped. Fenced code blocks, inline code and
`name[i](x)` calls are left alone. `MaxChars` counts the cleaned text.
`Snippet` and `Content` are untouched. No migration.

`ToContext` (on `SearchResponse` and `Page`) flattens markdown tables:
delimiter rows (`|---|:-:|`) are dropped, and each row becomes its non-empty
cells joined with " · " and ended with ";" (one is not added when the last cell
already ends in ";"), so rows stay apart once a search snippet's whitespace is
collapsed. A line is a row when it sits under another row or over a delimiter
row, or looks like one on its own (`| a | b |`), so prose such as `|x| is ...`
is left alone. A pipe after an odd run of backslashes (`\|`) is a literal pipe. A row left with no cells,
such as one that held only avatar images, is dropped. Tables inside fenced code
are left alone, and a pipe inside inline code does not split a cell. No
migration.

New `ContextOptions.MaxSnippetChars` for `SearchResponse.ToContext` and
`Cited` (zero means the new `DefaultContextMaxSnippetChars`, 2000): each
result's cleaned text is cut at the last space at or before that many
characters and ends in "…", so one whole-page snippet no longer takes the whole
`MaxChars` budget. The budget counts the capped text. Zero means the default and a negative
value disables the cap, for the old uncapped behaviour (in Python and
TypeScript, a value below 1 disables it). `Page.ToContext` is unchanged.

## 0.1.1

`SearchOptions` gains `MaxResults` and `QueryTime`. Both are client-only: the
`keenable_search` tool schema is unchanged. No migration.

## 0.1.0

Initial release.

Search, fetch, `ToContext`, and the `keenable_search` / `keenable_fetch` tools.
Keyless by default. No migration.
