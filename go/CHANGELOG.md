# Changelog

## Unreleased

New `TargetError` (unwraps to `APIError`, `Code()` `target`) for a page that
failed rather than your request or key: any `APICode` starting with `target_`
(`target_blocked`, `target_unreachable`, `target_timeout`, ...),
`page_not_found` or `content_not_extracted`. Today's code-less
`403 Upstream forbidden` from `/v1/fetch` is one too, and its message says the
site refused the fetch instead of "Check KEENABLE_API_KEY". Before, every 403
was an `AuthError`. A site's 429 stays a `RateLimitError`. A fetch 404 or 422
without a code (page not found, no readable content) is a `TargetError`; the
same statuses from search stay a plain `APIError`. A 403 for a private or
internal URL (code `private_url_not_allowed`, or today's code-less "Fetching
from private/internal hosts" message) is a plain `APIError` whose message says
to use a public URL, not "Check KEENABLE_API_KEY".

Without a `Fix` from the API, the message suggests a retry only when one can
help: always when the API sent `retryable: true`, never when it sent
`retryable: false`, and never for a 400, 404, 422 or other 4xx, which return
the same error when sent again. Before, every such
error ended with "Retry the request".

`Search` sends `mode` only when `SearchOptions.Mode` is set, so your
organization's default search mode applies. Before, the SDK always sent
`"pro"`.

`DefaultTimeout` is 90 seconds, up from 30. The API waits up to 60 seconds on a
slow fetch and bills a fetch that succeeds, so the old default could give up on
a page you paid for.

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
`Retry-After` too large for a uint64 is capped at a year like other large values. No migration.

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
