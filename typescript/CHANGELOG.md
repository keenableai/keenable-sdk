# Changelog

All notable changes to the `keenable` npm package. Versions follow
[semver](https://semver.org); releases are tagged `ts-v<version>`.

## 0.2.0 (unreleased)

Release this as a minor version, not a patch: the error classes some
responses throw change.

### Upgrading from 0.1.x

- A failed fetch target (a site's 403, a `target_*` code, a missing page) now
  throws `KeenableTargetError`, and a private-URL 403 throws a plain
  `KeenableAPIError`. Before, both threw `KeenableAuthError`. If you checked
  `instanceof KeenableAuthError` to handle a blocked fetch, check
  `instanceof KeenableTargetError` instead. `instanceof KeenableAPIError` and
  `instanceof KeenableError` still match every one of them, and `statusCode`
  is unchanged. A rejected key is still a `KeenableAuthError`.
- Nothing else changes for existing calls: `search()` still sends
  `mode: "pro"` by default.

### Changes

- New `KeenableTargetError` (extends `KeenableAPIError`) for a page that
  failed rather than your request or key: any `code` starting with `target_`
  (`target_blocked`, `target_unreachable`, `target_timeout`, ...),
  `page_not_found` or `content_not_extracted`. Today's code-less
  `403 Upstream forbidden` from `/v1/fetch` is one too, and its message says
  the site refused the fetch, not your API key. Before, every 403 was a
  `KeenableAuthError`. A site's 429 stays a `KeenableRateLimitError`.
- A 403 for a private or internal URL is a plain `KeenableAPIError`, not a
  `KeenableAuthError`: code `private_url_not_allowed`, or today's code-less
  "Fetching from private/internal hosts" message. Its message says to use a
  public URL.
- A fetch 404 or 422 without a code (page not found, no readable content) is a
  `KeenableTargetError`. The same statuses from search stay a plain
  `KeenableAPIError`, and so is a fetch 404 or 422 whose body is not the API's
  JSON error (a proxy or a wrong `baseUrl`).
- A target error without a `fix` ends with advice not to retry the same URL,
  unless the API sent `retryable: true`.
- New `search(query, { orgDefaultMode: true })`: with `mode` unset, the SDK
  sends no mode, so your organization's default search mode applies. Without
  it, `search()` still sends `mode: "pro"`, as before.
- The default `timeoutMs` is 90000 (90 seconds), up from 30. The API waits up to 60
  seconds on a slow fetch and bills a fetch that succeeds, so the old default
  could give up on a page you paid for.

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
  oversized value can never break error handling.

- `toContext()` (search results and fetched pages) drops markdown images and
  `<img>` tags, and resolves relative links against the result's URL (or keeps
  just the link text when it cannot). Absolute links are unchanged, and lines
  left holding only table pipes are dropped. The `maxChars` budget counts the
  cleaned text. Fenced code blocks, inline code and `name[i](x)` calls are
  left alone, as is a table's header row. `snippet` and `content` are
  untouched.

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
