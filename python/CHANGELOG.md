# Changelog

All notable changes to the `keenable` Python package. Versions follow
[semver](https://semver.org); releases are tagged `python-v<version>`.

## Unreleased

- **Changed (breaks code):** what a search monitor finds is now called a result. `monitors.pages()` is `monitors.results()` and calls `GET /v1/monitors/{id}/results`; `PageList` is `ResultList`. Both `Monitors` and `AsyncMonitors`. The old names are gone, with no aliases.
- **Changed (breaks code):** webhook event names. `monitor.hit` is `monitor.result.found`, `monitor.update` is `monitor.result.changed` and `monitor.change` is `monitor.page.changed`. `event.data.result` is unchanged. A check against an old name still compiles but never matches, so search your webhook handlers for them.
- **Removed:** fields the API no longer sends: `MonitorResult.score`, `favicon` and `highlights`; `Monitor.agent_run_id`, `backfill`, `memory_scope`, `estimated_cost_usd` and `cost_this_month_usd`; `MonitorRun.usage`.
- **Added:** page monitors. `monitors.create(type="page", page={"url": ..., "watch_for": ..., "sensitivity": "meaningful" | "any"}, schedule=...)` watches one page and reports the changes worth telling; `update(..., page={...})` merges into the stored page (a new `url` starts a new baseline, `watch_for=None` clears it). `create()` refuses before sending a `type` other than `"search"` or `"page"`, a page monitor without `page["url"]` or with `search`, and a search monitor with `page`. `search` is no longer a required argument of `create()`: it is required unless `type="page"`. Both `Monitors` and `AsyncMonitors`.
- **Added:** `monitors.versions(monitor_id, limit=..., cursor=...)` reads a page monitor's history (`GET /v1/monitors/{id}/versions`) as a `VersionList` of `MonitorVersion` (`version`, `fetched_at`, `title`, `source`, `notified`, `summary`, `items`, `diff`).
- **Added:** `Monitor.type` (`"search"` or `"page"`), `Monitor.page` (`MonitorPageTarget`: `url`, `watch_for`, `sensitivity`) and `Monitor.disabled_reason` (`MonitorDisabledReason`: `code` `runs_failed`, `webhook_unreachable` or `data_policy` (a page monitor whose organization turned on zero data retention), and `message`).
- **Added:** typed run fields: `MonitorRun.changes` is a `MonitorRunChanges` (`changed`, `notified`, `baseline`, `version`, `source`, `summary`, `items`, `diff` as a `MonitorDiff`), and `MonitorRunOutput` gains `fresh` and `error` (`MonitorRunOutputError`: `code` `output_failed` or `output_invalid`, and `message`).
- **Added:** the `monitor.page.changed` webhook event (a page monitor's run, in `event.data.run`, with its `changes`) is documented on `verify_webhook` and `WebhookEventData.run`.
- **Changed (may break code):** `Monitor.search` is now `MonitorSearch | None`: it is None for a page monitor. Code that reads `monitor.search.query` unchecked fails on a page monitor; check `monitor.type` or `monitor.search is not None` first.
- **Changed:** the schedule docstrings give the API's limits: interval `10m` to `90d`, cron runs at least 10 minutes apart. The SDK does not check schedules itself.
- **Changed:** the error contract fixtures follow the backend's current catalog, which adds `run_in_progress` (409: the monitor is already running).

## 0.2.0

- **Added:** Keenable Monitors. `Keenable().monitors` (and `AsyncKeenable().monitors`, awaitable) calls `https://api.keenable.ai/v1/monitors` (or `KEENABLE_API_URL`): `create`, `list`, `list_all`, `get`, `update`, `delete`, `pause`, `resume`, `trigger`, `runs`, `run`, `pages`, `deliveries`, `stats` and `bulk`, with typed results (`Monitor`, `MonitorRun`, `MonitorResult`, `MonitorDelivery`, `MonitorStats`, `BulkResult`, and `MonitorList` / `RunList` / `PageList` / `DeliveryList` pages). Monitors need an API key: without one a call raises `KeenableAuthError` (`code="missing_api_key"`) and sends nothing. `create()` sends an `Idempotency-Key` (`idempotency_key=`, or a new UUID per call), so it is retried safely; `update()`, `trigger()` and `bulk()` are retried only on a 429. `bulk()` needs ids or a filter with a status, a name or non-empty metadata. Monitor ids `.` and `..` are refused before sending, since they would change the request's path.
- **Added:** `verify_webhook(payload, headers, secret, *, tolerance=300, now=None)` checks a Monitors webhook (Standard Webhooks: HMAC-SHA256, `whsec_` secret, several signatures, 5-minute tolerance) and returns a `WebhookEvent`; a failure raises the new `WebhookVerificationError`, also for a timestamp of more than 12 digits, a secret with no key after `whsec_` and a `tolerance` that is not a positive, finite number.
- **Changed:** the error contract fixtures follow the backend's current catalog, including the Monitors codes `monitors_not_enabled`, `monitor_limit_reached` (403, `KeenableAuthError`), `monitor_option_not_supported`, `idempotency_conflict` (`KeenableAPIError`) and `monitors_unavailable` (503, retryable).

- **Added:** `objective` on `search()` (sync and async): what the search is for, in two or three natural sentences, up to 1,000 characters. Left out of the request when unset or empty. The API validates and logs it; it does not change results or price. The search tool offers it to a model.

- **Changed:** a numeric `timeout` is now the deadline for the whole attempt,
  as in the TypeScript and Go SDKs, not only for each httpx phase. Before, a
  server that kept sending a few bytes inside every read timeout could hold a
  request open indefinitely. The deadline covers connecting, the response
  headers, the body and its end, and ends the attempt on time in both
  `Keenable` and `AsyncKeenable`; a timed-out attempt's connection is closed,
  so repeated timeouts do not tie up the connection pool. In `Keenable` the
  deadline applies to the HTTP client the SDK creates: with a passed
  `httpx.Client` a numeric timeout keeps httpx's per-phase meaning, since the
  SDK cannot reach into it. The request still goes through the client's own
  `request()`, so a passed client that overrides it is still used. An
  `httpx.Timeout`, `timeout=None` and a passed client's own timeout keep
  httpx's per-phase meaning.
- **Changed:** `base_url` and `KEENABLE_API_URL` are refused when the part
  before the path has a backslash or a user name or password (`@`). The API key
  goes to this host, and URL parsers disagree on the host of a URL such as
  `http://evil.example\@localhost`. Plain `http` is accepted only for
  `localhost`, `127.0.0.1` and `::1` spelled exactly so (one trailing dot is
  ignored); fullwidth letters and `localhost..` no longer count.
- **Changed:** `fetch()` refuses a host with an empty label before sending: two
  dots in a row (`a..b`, `127.0.0..1`, `example.com..`) or a leading dot
  (`.example.com`). One trailing dot is still fine.

## 0.1.5

## 0.1.4

- `search()` (sync and async) accepts `exclude_domains`: a list of hosts to
  keep out of the results. A host also excludes its subdomains; up to 1,000
  distinct hosts. Any iterable of strings is sent as a list of its entries as
  given, including `[]`; a lone string is one host, and `""` is sent as `[""]`
  so the API rejects it rather than searching unfiltered. The API cleans up
  unambiguous entries (scheme, `www.`, case, port, trailing `/` or dot, query,
  `#fragment`, whitespace; international names become punycode) and rejects
  anything else (paths, suffixes such as `.com`, wildcards, IP addresses,
  `user@host`, invalid hosts) with HTTP 400. If every result is excluded, the
  response can be empty. `site` is unchanged.
- The `keenable_search` tool offers `exclude_domains` alongside `site`.
  `run_tool_call` sends the argument as given: only an absent or `null` value
  (or `""`) is unset, a lone string is wrapped, and any other value goes to the
  API, which rejects a malformed one with a 400.
- A rejected entry is a 400 whose `param`, `value` and `reason` name it, and
  whose message ends with the API's `fix`. `value` and `reason` are set only
  when the body's `error` is `invalid_filter`, `None` otherwise. `value` is
  usually the entry as sent; a size cap reports the list's size
  (`"2500 entries"` or `"more than 1000 distinct hosts"`) or an over-long
  entry's first 64 characters and `"..."`.
- A search argument JSON cannot encode (`NaN`, bytes, an arbitrary object)
  raises `KeenableInvalidRequestError` and sends nothing, in `search()` and
  `run_tool_call` alike.

The Python, TypeScript and Go SDKs now run one shared set of conformance cases
(`scripts/conformance/`), and these changes make them behave the same.
Behaviour changes are marked **Changed**.

- **Fixed:** `Page.published_at` is now set for fetched pages. The API sends a
  fetch's publish date as Unix seconds, which the SDK dropped; it is now an
  ISO 8601 UTC string to the second, such as `"2024-05-01T12:00:00Z"`, the
  form search results use. An ISO 8601 string is still kept as sent, so both
  forms work. The same applies to `SearchResult.published_at` and
  `acquired_at`. A number below 1, past the year 9999 (a millisecond value
  too), not finite, or a boolean is `None`, as before.
- **Added:** `Page.truncated` (`bool | None`) and `Page.total_chars`
  (`int | None`): whether the API cut `content` at `max_chars`, and the full
  content's length in code points. `None` when the API leaves them out or
  sends another type. `content` and `to_context()` are unchanged.
- **Added:** `search()` accepts `mode="realtime"`, the fastest response, for
  latency-sensitive agent loops. `"pro"`, deeper retrieval, stays the default.
  The API already took it; the type was `Literal["pro"]`.
- **Added:** `fetch()` takes `max_chars` (cap the content returned; the API
  default is 50000), `live` (`True` fetches the page from its source instead
  of the indexed copy) and `prompt` (an extraction instruction of up to 2000
  characters; `content` is then only the model's output for it), on `Keenable`
  and `AsyncKeenable`. An option left unset is not sent, `live=False` is not
  sent, and an empty `prompt` is unset.
- **Added:** `search()` (sync and async) takes `disable_cards`: `True` returns
  ordinary web pages in place of Keenable's cards (results Keenable writes for
  prices, exchange rates or company facts, whose URLs expire after one day).
  It works in the `"pro"` and `"realtime"` modes. Only `True` is sent:
  `False`, the API default, is left out. Any value that is not a `bool` raises
  `KeenableInvalidRequestError` and sends nothing. The `keenable_search` tool
  offers `disable_cards` as a boolean; `run_tool_call` sends it only as
  `true`, treats `false`, `null` and `""` as unset, and rejects any other value.

- **Changed:** errors no longer have `docs_url`, `billing_url`,
  `auto_top_up_url`, `pay_per_request` or `raw` (none was in a release), and
  `str(err)` no longer ends with `Docs: <url>`. The SDK does not expose docs
  links, billing or checkout URLs, or x402 payment offers.
- **Changed:** a 402's message is the SDK's own sentence, without the API's
  text or `fix`: "Keenable: payment required (402). This SDK does not pay per
  request: ..." for a pay-per-request (x402) or `payment_*` response, else
  "Keenable: insufficient credits (402). ...". It is still a
  `KeenableInsufficientCreditsError`, and `body`, `fix`, `code` and
  `request_id` are still set.
- **Changed:** `fetch()` refuses more targets before sending: `100.64.0.0/10`
  (carrier-grade NAT, including Alibaba Cloud's metadata address),
  `192.0.0.0/24`, `fec0::/10`, `2002::/16`, `3fff::/20`, any IPv6 address
  outside `2000::/3`, names under `.localhost`, percent-encoded hosts
  (`127.0.0.%31`), hosts with a soft hyphen or zero-width character, URLs with
  a control character or surrounding space, a backslash in the host part, or
  anything other than exactly `http://` or `https://` before the host. The
  ranges are now a fixed list shared with the other SDKs rather than Python's
  `ipaddress` flags, which differ between Python versions; an IPv4-mapped
  public address (`::ffff:8.8.8.8`) is now allowed on every version.
- **Changed:** a `Retry-After` date must be an RFC 9110 HTTP date
  (IMF-fixdate, RFC 850 or asctime, in GMT). A date with a numeric zone or no
  zone is ignored, so the next source of the delay (else backoff) is used.
- **Changed:** an error body field of the wrong type is ignored: a numeric or
  object `message` no longer becomes the detail (`str()` of it was shown), and
  an error body that is JSON but not an object (`"oops"`, `42`, `null`) gives
  no detail. `NaN` and `Infinity` in a body are not JSON, a leading byte order
  mark is ignored, and invalid UTF-8 no longer makes a JSON body unreadable.
- **Changed:** in results and pages, a `title`, `url`, `snippet` or `content`
  that is not a string is `""` instead of its `str()`; a page `url` that is
  blank or not a string falls back to the URL you fetched.
- **Changed:** `limit.max` is set only for a whole number from 0 to 2^53 - 1.
- **Changed:** an invalid header name, or a header value with CR, LF or NUL, in
  `default_headers` or `extra_headers` raises `KeenableInvalidRequestError`
  before anything is sent, instead of a connection error that was retried.
- **Changed:** a non-string `search()` query or `fetch()` URL raises
  `KeenableInvalidRequestError` (was `AttributeError` or `TypeError`), and an
  empty-string search filter is not sent, as in Go.
- **Changed:** `base_url` may not have a query or fragment, surrounding
  whitespace is dropped, `http://localhost.` counts as localhost, and a blank
  `KEENABLE_API_URL` means the default.
- **Changed:** a timeout over 2,147,483.647 s (about 24.8 days) is treated as
  that long; a larger one raised `OverflowError` from the socket layer.

- Automatic retries. Connection errors, timeouts, 408, 429 and 5xx are retried
  up to `max_retries` times (default 2), unless the API marks the error
  `retryable: false`. The wait is the API's `Retry-After` when sent, else
  exponential backoff (0.5 s to 8 s, jittered). A `Retry-After` over 60 s, such
  as the keyless hourly cap, is raised at once instead of waited out. Pass
  `max_retries=0` to turn retries off.
- New `KeenableTimeoutError`, a `KeenableConnectionError` subclass, for a
  request that did not answer within `timeout`.
- `search()` and `fetch()` take `timeout`, `max_retries` and `extra_headers`
  for that call; the clients take `max_retries` and `default_headers`.
  `X-API-Key` can only come from `api_key`.
- `SearchResponse.request_id` and `Page.request_id` (body `request_id`, else
  the `X-Request-Id` header).
- Redirects are never followed, even by an `httpx.Client` you pass with
  `follow_redirects=True`, so the API key cannot reach another host. A
  redirect raises `KeenableConnectionError`.
- With your own `client`, its timeout now applies unless you pass `timeout`;
  before, the SDK's 30 s default was ignored silently either way.
  On the client, `timeout=None` still means no deadline. A per-call `timeout`
  overrides the client's for that call, and a per-call `None` (the default)
  keeps the client's. An `httpx.Timeout` is accepted in both places.
- `timeout` and `max_retries` are validated: a non-positive timeout or a
  negative retry count raises `KeenableInvalidRequestError`.
- Fix: a retry budget over 1024 raised `OverflowError` in the backoff.
- Fix: `fetch()` now refuses a loopback or private host spelled as a number
  (`2130706433`, `0x7f.0.0.1`, `0177.0.0.1`, `127.1`) or in fullwidth digits,
  as the TypeScript SDK does.
- Fix: a whitespace-only `message` in an error body no longer becomes the
  error's detail, and a blank `query` in a response keeps the query you sent.

- Errors carry the API's agent-ready fields: `code`, `error`, `fix`,
  `retryable`, `retry_after_seconds` (from the body, else the `Retry-After`
  header), `request_id` (body, else `X-Request-Id`), `param` and `limit` (a
  new `RateLimitInfo`). Each is `None` when the API does not send it.
- New `KeenableInsufficientCreditsError` (alias `KeenableCreditsError`) for HTTP 402. It subclasses
  `KeenableAPIError`, so existing handlers keep working.
- A 403 whose `code` is `target_blocked` (the fetched site refused us) is now a
  plain `KeenableAPIError` labelled "Keenable API error (403)" rather than a
  `KeenableAuthError`. Without a `code`, 401/403 behave as before.
- When the API sends `fix`, the error message ends with it (". <fix>"), as in
  the Go and TypeScript SDKs. A `Retry-After` header is capped at a year, so an
  oversized value can never break error handling. The same year cap applies to
  a far-future `Retry-After` date and to the body's `retry_after_seconds` and
  `retryAfter`; a body value too large for a double (such as `1e400`) is
  dropped and the next source of the delay is used, as in the other SDKs.
- Errors carry the API's `type` (error format v1): `invalid_request_error`,
  `authentication_error`, `permission_error`, `billing_error`,
  `rate_limit_error`, `target_error` or `api_error`. An API that does not send
  it gets one derived from the status and `code`, so `type` is set on every
  `KeenableAPIError` from a response. A 401/403 whose type is `target_error`
  is not a `KeenableAuthError` (as `target_blocked` already was).
- `str(err)` ends with `(code: <code>)` and `(request_id: <id>)` when the API
  sends them, the way Stripe's SDKs print the request id. `body` is unchanged,
  and so is the message of a response without either field.
  A message that already ends in a period no longer gets a second one before
  the fix.

- `to_context()` (search results and fetched pages) drops markdown images and
  `<img>` tags, and resolves relative links against the result's URL (or keeps
  just the link text when it cannot). Absolute links are unchanged, and lines
  left holding only pipes and dashes are dropped. The `max_chars` budget counts
  the cleaned text. Fenced code blocks, inline code and `name[i](x)` calls are
  left alone. `snippet` and `content` are untouched.

- `to_context()` (search results and fetched pages) flattens markdown tables:
  delimiter rows (`|---|:-:|`) are dropped, and each row becomes its non-empty
  cells joined with " · " and ended with ";" (one is not added when the last
  cell already ends in ";"), so rows stay apart once a search snippet's
  whitespace is collapsed. A line is a row when it sits under another
  row or over a delimiter row, or looks like one on its own (`| a | b |`), so
  prose such as `|x| is ...` is left alone. A pipe after an odd run of
  backslashes (`\|`) is a literal pipe. A row left with no cells,
  such as one that held only avatar images, is dropped. Tables inside fenced
  code are left alone, and a pipe inside inline code does not split a cell.

- `SearchResponse.to_context()` and `cited()` take `max_snippet_chars` (default 2000,
  new constant `DEFAULT_CONTEXT_MAX_SNIPPET_CHARS`): each result's cleaned text
  is cut at the last space at or before that many characters and ends in "…",
  so one whole-page snippet no longer takes the whole `max_chars` budget. The
  budget counts the capped text. Pass `None` for the old uncapped behaviour;
  a value below 1 also disables the cap (in Go, 0 means the default and a negative value disables it).
  `Page.to_context()` is unchanged.

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
