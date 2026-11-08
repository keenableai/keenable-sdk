# Changelog

All notable changes to the `keenable` npm package. Versions follow
[semver](https://semver.org); releases are tagged `ts-v<version>`.

## Unreleased

The SDK now matches the Python and Go SDKs case for case: all three run the
shared cases in `scripts/conformance`. Changes marked **Behaviour change** alter
what an existing call does.

- **Fixed:** `Page.publishedAt` is now set for fetched pages. The API sends a
  fetch's publish date as Unix seconds, which the SDK dropped; it is now an
  ISO 8601 UTC string to the second, such as `"2024-05-01T12:00:00Z"`, the
  form search results use. An ISO 8601 string is still kept as sent, so both
  forms work. The same applies to `SearchResult.publishedAt` and
  `acquiredAt`. A number below 1, past the year 9999 (a millisecond value
  too) or not finite is `undefined`, as before.
- **Added:** `Page.truncated` (`boolean | undefined`) and `Page.totalChars`
  (`number | undefined`): whether the API cut `content` at `max_chars`, and
  the full content's length in code points. `undefined` when the API leaves
  them out or sends another type. `content` and `toContext()` are unchanged.

- **Behaviour change:** errors no longer expose `docsUrl`, `billingUrl`,
  `autoTopUpUrl`, `payPerRequest` or `raw`, and the message no longer ends with
  `Docs: <url>`. None of these was in a release. `body` (the API's message) is
  unchanged.
- **Behaviour change:** a 402's message is the SDK's own sentence rather than
  the API's text, which links to billing and checkout pages:
  "Keenable: insufficient credits (402). ..." or, for an x402 or `payment_*`
  response, "Keenable: payment required (402). This SDK does not pay per
  request ...". It is still a `KeenableInsufficientCreditsError`, with `code`,
  `fix`, `requestId` and `body` set, and carries no payment offer.
- **Behaviour change:** `fetch()` refuses more special-purpose addresses, the
  same list in every SDK: `100.64.0.0/10` (carrier-grade NAT, including Alibaba
  Cloud's metadata address), `192.0.0.0/24`, `192.0.2.0/24`, `198.18.0.0/15`,
  `198.51.100.0/24`, `203.0.113.0/24`, and every IPv6 address outside
  `2000::/3` or inside `2001::/23`, `2001:db8::/32`, `2002::/16` or `3fff::/20`
  (so `fc::1`, NAT64 `64:ff9b::/96`, `fec0::/10` and IPv4-compatible
  addresses). It also refuses names under `.localhost`.
- **Behaviour change:** `fetch()` refuses a URL whose host other parsers read
  differently: `https:///host`, `https:host` and `https:/host` (read as
  `https://host/` before), a backslash in the host part, a control character
  anywhere, or a leading or trailing space.
- **Behaviour change:** a `Retry-After` date must be one of the three RFC 9110
  forms with the zone `GMT`. A date with a numeric zone (`+0000`) or none at all
  is ignored and the backoff applies, as in Go.
- **Behaviour change:** an error body that is JSON but not an object (`"oops"`,
  `42`, `null`) no longer becomes the error's detail; the error maps by status
  alone.
- **Behaviour change:** a search result's `title`, `url` and `snippet`, and a
  page's `title` and `content`, are `""` when the API sends something other
  than a string (they were `"42"`, `"[object Object]"` or `"false"`). An array
  inside `results` is skipped like any other non-object.
- **Behaviour change:** a `fetch` you pass that follows a redirect although the
  SDK asks it not to (`redirect: "manual"`) now throws the same, non-retried
  redirect error instead of returning the other host's reply.
- **Behaviour change:** a header name that is not an HTTP token, or a value
  with CR, LF or NUL, in `defaultHeaders` or a call's `headers`, throws
  `KeenableInvalidRequestError` before anything is sent, rather than failing as
  a connection error that was retried.
- **Behaviour change:** `mode: ""` sends `"pro"`, and an empty string filter
  (such as `site: ""`) is not sent, as in Go.
- **Behaviour change:** `baseUrl` with a query or fragment is refused (the path
  was appended after it), surrounding whitespace is ignored, `localhost.` counts
  as localhost, and `http://127.1` is refused as in Python and Go. A blank
  `KEENABLE_API_URL` means the default instead of throwing.
- **Behaviour change:** `limit.max` is set only for an integer from 0 to
  2^53 - 1.
- Fix: a `timeoutMs` over 2147483647 (about 24.8 days) timed out at once,
  because a JavaScript timer fires immediately past that. It now waits that
  long.

- Automatic retries. Connection errors, timeouts, 408, 429 and 5xx are retried
  up to `maxRetries` times (default 2), unless the API marks the error
  `retryable: false`. The wait is the API's `Retry-After` when sent, else
  exponential backoff (0.5 s to 8 s, jittered). A `Retry-After` over 60 s, such
  as the keyless hourly cap, is thrown at once instead of waited out. Pass
  `maxRetries: 0` to turn retries off. Aborting `signal` cancels a pending
  retry.
- New `KeenableTimeoutError`, a `KeenableConnectionError` subclass, for a
  request that did not answer within `timeoutMs`.
- `search()` and `fetch()` take `timeoutMs`, `maxRetries` and `headers` for
  that call (the new `RequestOptions` type); the client takes `maxRetries` and
  `defaultHeaders`. `X-API-Key` can only come from `apiKey`.
- `SearchResponse.requestId` and `Page.requestId` (body `request_id`, else the
  `X-Request-Id` header).
- Fix: `fetch()` refused every hostname starting with `fc`, `fd` or
  `fe8`-`feb` (such as `fdic.gov` or `fcbarcelona.com`) as a "private
  address". Only IPv6 literals in those ranges are refused now, and IPv4
  multicast, reserved and broadcast addresses are refused as in Python and Go.
- Fix: redirects are no longer followed. `fetch` would have carried the
  `X-API-Key` header to whatever host a redirect named. A redirect now throws
  `KeenableConnectionError`.
- `timeoutMs` and `maxRetries` are validated: a non-positive timeout or a
  negative or fractional retry count throws `KeenableInvalidRequestError`.
- Fix: a `Retry-After` header that is not a number or an HTTP date (`1.5`,
  `-1`, `Jan 1`) was read as a date in the past, so the retry came at once. It
  is now ignored, and the backoff applies, as in Python and Go.
- Fix: a call whose `signal` is already aborted throws without calling
  `fetch`, even a custom `fetch` that ignores the signal.
- Fix: `Page.url` falls back to the URL you asked for when the API sends an
  empty one, as in Python and Go.

- Errors carry the API's agent-ready fields: `code`, `error`, `fix`,
  `retryable`, `retryAfterSeconds` (from the body, else the `Retry-After`
  header), `requestId` (body, else `X-Request-Id`), `param` and `limit` (a new
  `RateLimitInfo` type). Each is `undefined` when the API does not send it.
- New `KeenableInsufficientCreditsError` (alias `KeenableCreditsError`) for HTTP 402. It extends
  `KeenableAPIError`, so existing handlers keep working.
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
- `error.message` ends with `(code: <code>)` and `(request_id: <id>)` when the
  API sends them, the way Stripe's SDKs print the request id. `body` is unchanged, and so is the message of a
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
