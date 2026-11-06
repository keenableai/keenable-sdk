# Changelog

## Unreleased

`APIError` carries the API's agent-ready fields: `APICode`, `Title`, `Fix`,
`DocsURL`, `Retryable`, `RetryAfter` (from the body's `retry_after_seconds`,
else the `Retry-After` header), `Param`, `RateLimit` (a new `RateLimitInfo`),
`BillingURL`, `AutoTopUpURL`, `PayPerRequest` and `Raw`. `RequestID` now
prefers the body's `request_id` over the header. Each is its zero value when
the API does not send it. New `InsufficientCreditsError` (alias `CreditsError`) for HTTP 402 unwraps
to `APIError` and keeps `Code()` `api_error` and the old message. When the API
sends `Fix`, the message ends with it instead of the generic "Retry the
request" advice; a 429 for a limit that is not the caller's
(`search_rate_limited`, `fetch_rate_limited`, `target_rate_limited`) ends with
the `Fix` instead of the API-key advice, and a 429 with `RetryAfter` but no
`X-RateLimit-Reset` says "Retry after <duration>". A 403 with code
`target_blocked` is a plain `APIError`, not an `AuthError`. Responses without
the new fields produce the same errors and messages as before. No migration.

`ToContext` (on `SearchResponse` and `Page`) drops markdown images and `<img>`
tags, and resolves relative links against the result's URL (or keeps just the
link text when it cannot). Absolute links are unchanged, and lines left holding
only table pipes are dropped. Fenced code blocks, inline code and `name[i](x)`
calls are left alone, as is a table's header row. `MaxChars` counts the
cleaned text. `Snippet` and
`Content` are untouched. No migration.

## 0.1.1

`SearchOptions` gains `MaxResults` and `QueryTime`. Both are client-only: the
`keenable_search` tool schema is unchanged. No migration.

## 0.1.0

Initial release.

Search, fetch, `ToContext`, and the `keenable_search` / `keenable_fetch` tools.
Keyless by default. No migration.
