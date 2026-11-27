# Changelog

## Unreleased

- **Added:** the standard usage object. `SearchResponse.Usage`, the new `FetchResponse.Usage` (one for the whole call) and the new `APIError.Usage` (a failed call that was partly billed) are a `*Usage` with `Items` (`[]UsageItem{SKU, Quantity, Price}`, one per SKU and unit price), `Total` and `Balance` (`*Money`, nil when unknown). Nil when the API sends none, as on keyless calls. Works against servers before and after backend #951: an older server's usage (`sku`, `amount`, `cost`, ...) is read into the same shape (one item priced at cost divided by amount, rounded to nine decimal places when uneven; the total is the cost, or `"0"` in `usd` when no cost was sent), and on an older server a fetch's usage is built from its pages' (items merged by SKU and price, the exact sum of the totals, the last balance).
- **Added:** `Money{Amount, Currency}`, used by usage and `Billing`. `Amount` is an exact decimal string in US dollars (`"0.004"`: up to nine decimal places, no trailing zeros, no exponent, negative for an account in debt), never a float, so a bill can be checked exactly; `Money.Rat()` gives it as a `*big.Rat`. It reads every server's money: a string amount (backend #947), else an older server's `amount_decimal`, else its number written with at most nine decimal places. Before, a string amount read as 0 and prices showed as $0.
- **Deprecated:** `Usage.SKU`, `Usage.Amount`, `Usage.Credits`, `Usage.Paid` and `Usage.CreditsRemaining` (read `Items`, `Total` and `Balance`; they are zero from a server that sends the standard object), and `Page.Usage` (read `FetchResponse.Usage`; a server with #951 sends none per page). They will be removed in a future release.
- **Changed:** the `keenable_search` tool's `moderation` description: supported for a URL query when `exclude_domains` is set.
- **Added:** `client.Billing(ctx, opts)` reads `GET /v1/billing` (read-only, free) as a `*Billing`: `Prices` (`[]BillingPrice` with `SKU`, `Unit`, `UnitPrice`, and with a key `ListUnitPrice` and `Source`) and `Account` (`*BillingAccount`, nil without a key: `Balance.Available`, `BillingURL`, `AsOf`). Amounts are `Money{Amount, Currency}`. The key is optional and the path is `/v1/billing` either way (no `/public` variant). `opts` (`*RequestOptions`) may be nil.
- **Changed:** the `keenable_search` tool's `objective` description is shorter (about 330 characters): use it for multi-step or ambiguous searches, say what the query leaves out and what earlier searches found, and stay within 1,000 characters.
- **Added:** `SearchOptions.Moderation`: `"moderate"` or `"strict"` filters unsafe results; empty, the default, is no moderation and is not sent. The `keenable_search` tool offers it as an enum. The API supports it in `"pro"` and `"realtime"` modes and answers 400 when the query is a URL.
- **Added:** `SearchResponse.Warnings`, a slice of `SearchWarning` (`Code`, `Path`, `Message`) naming what a request should change, such as a deprecated parameter. Nil when the API sends none.
- **Changed:** `FetchOptions.MaxAgeHours` documents `-1`: read only Keenable's stored copy, of any age, never the live page; a page with no stored copy comes back with `Error` set (404). It works with `Prompt`, `Schema`, `Links` and `Images`. The API accepts `-1` or `0` to `720` and answers any other negative value with a 400. The `keenable_fetch` tool's `max_age_hours` now allows `-1` (`minimum: -1`) and its description says so. The SDK sends the value as given, as before.

## 0.3.0

- **Changed (breaking):** `Fetch` and `FetchWithOptions` take `[]string` URLs and send one `POST /v1/fetch`. They return a `*FetchResponse` whose `Results[i]` is the `Page` for `urls[i]`, with `Error` (a `*FetchError`) set when that URL failed. `FetchOptions` has `MaxChars`, `Prompt`, `Schema`, `Links`, `Images` and `MaxAgeHours`, sent only when set; the API checks their values. `Live` and `Page.RequestID` are gone (`FetchResponse.RequestID` replaces it), and there is no separate `FetchMany`.
- **Changed (breaking):** the `keenable_fetch` tool matches `Fetch` and the hosted MCP tool: it takes `urls` (1 to 20), `max_chars` (per page), `prompt` and `max_age_hours` (0 reads live). `urls` is required and the old `url` argument is gone: a call that sends only `url` is an invalid request. The context budget without `max_chars` is split across the pages, so a call stays about the size one page was. `RunToolCall` returns each page as its own numbered block and a URL that failed as a `[n] <url> - failed: <reason>` block; it fails only when no URL could be read.
- **Changed (breaking):** what a search monitor finds is now called a result. `client.Monitors.Pages` is `client.Monitors.Results` and calls `GET /v1/monitors/{id}/results`; `PageList` is `ResultList` and `MonitorPagesParams` is `MonitorResultsParams`. The old names are gone, with no aliases.
- **Changed (breaking):** webhook event names: `monitor.hit` is `monitor.result.found`, `monitor.update` is `monitor.result.changed` and `monitor.change` is `monitor.page.changed`. `WebhookEventData.Result` is unchanged. A check against an old name still compiles but never matches, so search your webhook handlers for them.
- **Removed:** fields the API no longer sends: `MonitorResult.Score`, `Favicon` and `Highlights`; `Monitor.AgentRunID`, `Backfill`, `MemoryScope`, `EstimatedCostUSD` and `CostThisMonthUSD`; `MonitorRun.Usage`.
- **Added:** page monitors. `client.Monitors.Create(ctx, &keenable.MonitorCreateParams{Type: "page", Page: &keenable.MonitorPageTarget{URL: ..., WatchFor: ..., Sensitivity: ...}})` watches one page and reports the changes worth telling. `MonitorUpdateParams.Page` merges into the stored page (a new `URL` starts a new baseline) and `RemovePageWatchFor` clears `watch_for`. `Create` refuses before sending a `Type` other than `"search"` or `"page"`, a page monitor without `Page.URL` or with `Search`, and a search monitor with `Page`.
- **Added:** `client.Monitors.Versions(ctx, id, &keenable.MonitorVersionsParams{Limit: ..., Cursor: ...})` reads a page monitor's history (`GET /v1/monitors/{id}/versions`) as a `*VersionList` of `MonitorVersion`.
- **Added:** `Monitor.Type`, `Monitor.Page` (`*MonitorPageTarget`) and `Monitor.DisabledReason` (`*MonitorDisabledReason`: `Code` `runs_failed`, `webhook_unreachable` or `data_policy` (a page monitor whose organization turned on zero data retention), and `Message`). `Monitor.Type` is "search" when a response leaves it out, as in the other SDKs.
- **Added:** typed run fields: `MonitorRun.Changes` is a `*MonitorRunChanges` (with `Diff *MonitorDiff`), and `MonitorRunOutput` gains `Fresh` and `Error` (`*MonitorRunOutputError`: `Code` `output_failed` or `output_invalid`, and `Message`).
- **Added:** the `monitor.page.changed` webhook event (a page monitor's run, in `WebhookEventData.Run`, with its `Changes`) is documented on `WebhookEventData.Run`.
- **Changed (breaking):** `Monitor.Search` is now `*MonitorSearch`, nil for a page monitor; `MonitorRun.Changes` changes from `any` to a typed pointer. Code that passes `m.Search` as a `MonitorSearch` no longer compiles, and `m.Search.Query` panics on a page monitor; check `m.Type` or `m.Search != nil` first.
- **Changed:** the schedule docs give the API's limits: interval `10m` to `90d`, cron runs at least 10 minutes apart. The SDK does not check schedules itself.
- **Changed:** the error contract fixtures follow the backend's current catalog, which adds `run_in_progress` (409: the monitor is already running).
- **Changed:** the `Objective` docs say what the API now does: the ranker scores results for it together with the query (retrieval reads only the query), at the same price. The option and its behaviour in the SDK are unchanged.

## 0.2.0

- **Added:** Keenable Monitors. `client.Monitors` calls `https://api.keenable.ai/v1/monitors` (or `KEENABLE_API_URL`): `Create`, `List`, `ListAll` (a `*MonitorIterator`), `Get`, `Update`, `Delete`, `Pause`, `Resume`, `Trigger`, `Runs`, `Run`, `Pages`, `Deliveries`, `Stats` and `Bulk`, with typed results (`Monitor`, `MonitorRun`, `MonitorResult`, `MonitorDelivery`, `MonitorStats`, `BulkResult`, `List[T]`). Monitors need an API key: without one a call returns an `*AuthError` (`APICode` `missing_api_key`) and sends nothing. `Create` sends an `Idempotency-Key` (`IdempotencyKey`, or a new UUID per call), so it is retried safely; `Update`, `Trigger` and `Bulk` are retried only on a 429. In `MonitorUpdateParams`, `RemoveName`, `RemoveSchedule`, `RemoveOutputSchema`, `RemoveWebhook` and `RemoveMetadata` send null and win over the value. Monitor ids `.` and `..` are refused before sending, since they would change the request's path.
- **Added:** `VerifyWebhook(payload, headers, secret, *WebhookOptions)` checks a Monitors webhook (Standard Webhooks: HMAC-SHA256, `whsec_` secret, several signatures, 5-minute tolerance) and returns a `*WebhookEvent`; a failure is the new `*WebhookVerificationError` (`Code()` `webhook_verification`), also for a timestamp of more than 12 digits and a secret with no key after `whsec_`.
- **Changed:** the error contract fixtures follow the backend's current catalog, including the Monitors codes `monitors_not_enabled`, `monitor_limit_reached` (403, `*AuthError`), `monitor_option_not_supported`, `idempotency_conflict` (`*APIError`) and `monitors_unavailable` (503, retryable).

- **Added:** `SearchOptions.Objective`: what the search is for, in two or three natural sentences, up to 1,000 characters. Not sent when empty. The API validates and logs it; it does not change results or price. The search tool offers it to a model.

- **Security fix:** `Fetch` refuses loopback and private hosts spelled with
  Unicode compatibility characters, which a browser or Node folds to plain
  ones: `①②⑦.0.0.1`, `𝟏𝟐𝟕.0.0.1`, `ℓocalhost`. Hosts are now NFKC-normalized
  before the check, as in the Python and TypeScript SDKs. This adds the
  module's first dependency, `golang.org/x/text`.
- **Changed:** `Fetch` refuses a host with an empty label before sending: two
  dots in a row (`a..b`, `127.0.0..1`, `example.com..`) or a leading dot
  (`.example.com`). One trailing dot is still fine.
- **Changed:** `BaseURL` and `KEENABLE_API_URL` are refused when they have a
  user name or password, or a backslash before the path. Plain `http` is
  accepted only for `localhost`, `127.0.0.1` and `::1` spelled exactly so (one
  trailing dot is ignored); fullwidth letters and `localhost..` no longer
  count.

## 0.1.5

## 0.1.2

`SearchOptions` gains `ExcludeDomains`: a list of hosts to keep out of the
results. A host also excludes its subdomains; up to 1,000 distinct hosts. The
API cleans up unambiguous entries (scheme, `www.`, case, port, trailing `/` or
dot, query, `#fragment`, whitespace; international names become punycode) and
rejects anything else (paths, suffixes such as `.com`, wildcards, IP addresses,
`user@host`, invalid hosts) with 400. A nil slice is unset; a non-nil empty
slice is sent as `[]`. If every result is excluded, the response can be empty.
`Site` is unchanged. The `keenable_search` tool offers `exclude_domains`
alongside `site`.

A rejected entry is a 400 whose `APIError.Param`, `Value` and `Reason` name it,
and whose message ends with the API's `Fix`. `Value` and `Reason` are set only
when the body's `error` is `invalid_filter`. `Value` is usually the entry as
sent; a size cap reports the list's size (`"2500 entries"` or
`"more than 1000 distinct hosts"`) or an over-long entry's first 64 characters
and `"..."`.

`RunToolCall` sends an `exclude_domains` argument to the API as given: `[]` is
sent as `[]`, `null` and `""` are unset, a lone string is wrapped, and a
malformed value goes to the API, which returns the 400. A value in an
arguments map that cannot be encoded as JSON is an `InvalidRequestError`. No
migration.

The Python, TypeScript and Go SDKs now behave the same, and a shared suite of
cases (`scripts/conformance`, run by `conformance_test.go`) keeps them so.
Behaviour changes:

- **`Page.PublishedAt` is now set for fetched pages.** The API sends a fetch's
  publish date as Unix seconds, which the SDK dropped; it is now an ISO 8601
  UTC string to the second, such as `"2024-05-01T12:00:00Z"`, the form search
  results use. An ISO 8601 string is still kept as sent, so both forms work.
  The same applies to `SearchResult.PublishedAt` and `AcquiredAt`. A number
  below 1, past the year 9999 (a millisecond value too) or not finite is nil,
  as before.
- **New `Page.Truncated` (`*bool`) and `Page.TotalChars` (`*int`):** whether
  the API cut `Content` at `max_chars`, and the full content's length in code
  points. Nil when the API leaves them out or sends another type. `Content`
  and `ToContext` are unchanged.
- **New `FetchOptions.MaxChars`, `Live` and `Prompt`,** for
  `FetchWithOptions`: cap the content returned (the API default is 50000),
  fetch the page from its source instead of the indexed copy, and pass an
  extraction instruction of up to 2000 characters (`Content` is then only the
  model's output for it). The zero value of each means unset and is not sent.
- **`SearchOptions.Mode` documents `"realtime"`,** the fastest response, for
  latency-sensitive agent loops. `Mode` already took any string; `"pro"`
  stays the default.
- **New `SearchOptions.DisableCards`:** `true` returns ordinary web pages in
  place of Keenable's cards (results Keenable writes for prices, exchange
  rates or company facts, whose URLs expire after one day). It works in the
  `"pro"` and `"realtime"` modes. False, the API default, is not sent. The
  `keenable_search` tool offers `disable_cards` as a boolean; `RunToolCall`
  sends it only as `true`, treats `false`, `null` and `""` as unset, and
  returns an `InvalidRequestError` for any other value.

- **Redirects are never followed, the same host included.** Every 3xx is a
  `ConnectionError` that is not retried, with the owned client and with your
  `HTTPClient` alike; your `CheckRedirect` is no longer consulted. Before, a
  same-host redirect was followed with the API key.
- **`RequestOptions.Timeout` is now a `*time.Duration`.** Nil keeps the
  client's timeout; a pointer to zero or less is an `InvalidRequestError`
  (zero used to mean "the client's"). `Options.Timeout` is unchanged: zero
  still means `DefaultTimeout`. A timeout over about 24.8 days
  (2,147,483.647 s) is treated as that long, as in TypeScript.
- **`Fetch` refuses more targets:** 100.64.0.0/10 (carrier-grade NAT, where
  some clouds put their metadata service), 192.0.0.0/24, 192.0.2.0/24,
  198.18.0.0/15, 198.51.100.0/24 and 203.0.113.0/24; any IPv6 address outside
  2000::/3 (NAT64 `64:ff9b::/96`, `100::/64`, IPv4-compatible `::a.b.c.d`,
  `fec0::/10` and the like) and, inside it, 2001::/23, 2001:db8::/32,
  2002::/16 and 3fff::/20; names under `.localhost`; and URLs with a control
  character, a leading or trailing space, anything but `scheme://` after the
  scheme, or a backslash in the host part. A soft hyphen or zero-width
  character in the host is ignored, as a browser ignores it. The ranges are an
  explicit list, the same in every SDK.
- **`Retry-After` dates are read strictly:** only the three RFC 9110 forms
  (IMF-fixdate, RFC 850 and asctime) in GMT, with two-digit fields and a real
  calendar date. Any other zone, a one-digit hour and similar fall back to the
  next source of the delay, as in Python and TypeScript.
- **Error details:** a non-string `message`, `error` or `detail` is skipped,
  not formatted into the message. A body that is JSON but not an object
  (`"oops"`, `null`, `42`, `1e400`) gives no detail; it used to keep `1e400`
  as text. A leading byte order mark no longer makes a body unreadable, and a
  number too large for a float64 in a success body no longer fails the call.
- **Removed `APIError.DocsURL`, `BillingURL`, `AutoTopUpURL`,
  `PayPerRequest` and `Raw`**, all added since v0.1.1, and the "Docs: ..."
  sentence in messages. The SDK no longer exposes the API's docs link, a
  402's billing, checkout or top-up links, or a pay-per-request (x402) offer.
  `Body`, `Fix`, `Title`, `APICode`, `Type`, `Retryable`, `RetryAfter` and
  `RequestID` stay. A 402's message is now the SDK's own sentence: "Keenable:
  payment required (402)" for an x402 or `payment_*` response, which this SDK
  cannot pay, else "Keenable: insufficient credits (402)"; it no longer
  includes the API's text or "Add credits at https://keenable.ai/console".
- **Header validation:** a header name that is not an HTTP token, or a value
  with CR, LF or NUL, in `Options.Headers` or `RequestOptions.Headers` is an
  `InvalidRequestError` before anything is sent, instead of a connection
  error that was retried.
- `RateLimitInfo.Max` is set only for an integer from 0 to 2^53 - 1.
- A blank `url` in a fetch response falls back to the URL asked for, as an
  empty one did.

Fixes: `Fetch` refuses 240.0.0.0/4 (reserved) and a loopback or private host
spelled as a number (`2130706433`, `0x7f.0.0.1`, `127.1`) or in fullwidth
digits, as Python and TypeScript do. A 3xx the client does not follow (your
`CheckRedirect` returned `http.ErrUseLastResponse`, or a 300/304) is now a
`ConnectionError` and is not retried, instead of an `APIError` that said to
retry. A 4xx the API sent no fix for no longer ends "Retry the request", since
the SDK does not retry it.

Automatic retries. Connection errors, timeouts, 408, 429 and 5xx are retried
up to `Options.MaxRetries` times (nil means `DefaultMaxRetries`, 2), unless the
API marks the error `Retryable` false. The wait is the API's `Retry-After` when
sent, else exponential backoff (0.5s to 8s, jittered). A `Retry-After` over
60s, such as the keyless hourly cap, is returned at once instead of waited out.
Canceling ctx stops a pending wait. `Options.Timeout` now applies to each
attempt.

New `RequestOptions` (`Timeout`, `MaxRetries`, `Headers`) for one call,
embedded in `SearchOptions` and in the new `FetchOptions`, which the new
`FetchWithOptions` takes. `Fetch` keeps its signature, so interfaces that mock
it still compile. The `http.Client` this SDK creates no longer sets its own
`Timeout`: the per-attempt context deadline covers headers and body, so a
longer `RequestOptions.Timeout` is not cut short. `SearchOptions` gains the
embedded `RequestOptions` field, so an unkeyed (positional) `SearchOptions{...}`
literal no longer compiles; use field names, as `go vet` recommends. When the
caller's ctx deadline would end before a retry's wait, the error that caused
the retry is returned at once instead of `ctx.Err()`. `Options.Headers` adds headers to every request;
`X-API-Key` always comes from `APIKey`. `ConnectionError.Timeout()` reports a
deadline. `SearchResponse.RequestID` and `Page.RequestID` carry the request id
(body `request_id`, else `X-Request-Id`). A negative `MaxRetries` or `Timeout`
is an `InvalidRequestError`.

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
