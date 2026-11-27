# Changelog

## Unreleased

- **Added:** the standard usage object. `Usage` gains `items` (`Vec<UsageItem>`, one `UsageItem { sku, quantity, price }` per SKU and unit price), `total` (`Money`, the cost of the call) and `balance` (`Option<Money>`, the organization's balance after the call). It is on `SearchResponse::usage` (new), `FetchResponse::usage` (new: one usage for the whole fetch call) and `ApiError::usage` (new: what a failed call was billed, when its error body says). Every server version is read into this shape: an older server's usage (`sku`, `amount`, `cost`) becomes one item priced at the cost divided by the amount (exact, rounded to nine decimals, halves away from zero) and a total equal to the cost, or 0 when it sent no cost. On an older server that bills each fetched page on its own, `FetchResponse::usage` is built from the pages: items merged by SKU and price, totals added exactly, the last balance. `UsageItem` is exported. Works against servers before and after backend #947 and #951.
- **Deprecated:** `Usage::sku`, `amount`, `credits`, `paid` and `credits_remaining` (`#[deprecated]`), read as before from an older server and empty (`""`, 0, 0.0, false, `None`) from one that sends the standard object; and `Page::usage`, which only an older server sends: read `FetchResponse::usage`. They stay for one release.
- **Fixed:** a malformed `balance` or money field no longer drops the whole `Usage` of a page; each field is read on its own.
- **Fixed:** `Usage::amount` accepts a whole number sent in float form, such as `1.0`, as the other SDKs do; anything else is still 0.
- **Changed:** the `keenable_search` tool's `moderation` description: supported for a URL query when `exclude_domains` is set.
- **Added:** `Money`, `Usage` and `UsageItem` implement `Deserialize`, reading JSON as the client does, from any server version.
- **Added:** `billing()` and `billing_with(&RequestOptions)` read `GET /v1/billing` (read-only, free) as a `Billing`: `prices` (`BillingPrice` with `sku`, `unit`, `unit_price`, and with a key `list_unit_price` and `source`) and `account` (`Option<BillingAccount>`, `None` without a key: `balance.available`, `billing_url`, `as_of`). Amounts are `Money { amount, currency }` with `amount` an exact decimal string in US dollars (`"0.004"`: up to nine decimal places, no trailing zeros, no exponent, `-` when negative, `"0"` for zero), never a float, so amounts add up exactly when checking a bill (add them with a decimal crate or as integer nano-dollars). It reads the API's string amount (backend #947) and an older server's number with or without `amount_decimal`. The key is optional and the path is `/v1/billing` either way (no `/public` variant).
- **Changed:** the `keenable_search` tool's `objective` description is shorter (about 330 characters): use it for multi-step or ambiguous searches, say what the query leaves out and what earlier searches found, and stay within 1,000 characters.
- **Added:** `SearchOptions::moderation`: `"moderate"` or `"strict"` filters unsafe results; `None`, the default, is no moderation and is not sent. The `keenable_search` tool offers it as an enum. The API supports it in `"pro"` and `"realtime"` modes and answers 400 when the query is a URL.
- **Added:** `SearchResponse::warnings`, a `Vec<SearchWarning>` (`code`, `path`, `message`) naming what a request should change, such as a deprecated parameter. Empty when the API sends none.
- **Changed:** `FetchOptions::max_age_hours` documents `Some(-1.0)`: read only Keenable's stored copy, of any age, never the live page; a page with no stored copy comes back with `error` set (404). It works with `prompt`, `schema`, `links` and `images`. The API accepts `-1` or `0` to `720` and answers any other negative value with a 400. The `keenable_fetch` tool's `max_age_hours` now allows `-1` (`minimum: -1`) and its description says so. The SDK sends the value as given, as before.

## 0.3.0

- **Changed (breaking):** `fetch` and `fetch_with` take any iterable of URLs and send one `POST /v1/fetch`. They return a `FetchResponse` whose `results[i]` is the `Page` for `urls[i]`, with `error` (a `FetchError`) set when that URL failed. `FetchOptions` has `max_chars`, `prompt`, `schema`, `links`, `images` and `max_age_hours`, sent only when set; the API checks their values. `live` and `Page::request_id` are gone (`FetchResponse::request_id` replaces it), and there is no separate `fetch_many`.
- **Changed (breaking):** the `keenable_fetch` tool matches `fetch` and the hosted MCP tool: it takes `urls` (1 to 20), `max_chars` (per page), `prompt` and `max_age_hours` (0 reads live). `urls` is required and the old `url` argument is gone: a call that sends only `url` is an invalid request. The context budget without `max_chars` is split across the pages, so a call stays about the size one page was. `run_tool_call` returns each page as its own numbered block and a URL that failed as a `[n] <url> - failed: <reason>` block; it fails only when no URL could be read.
- **Changed (breaking):** what a search monitor finds is now called a result. `monitors().pages()` is `monitors().results()` and calls `GET /v1/monitors/{id}/results`; `PageList` is `ResultList` and `MonitorPagesParams` is `MonitorResultsParams`. The old names are gone, with no aliases.
- **Changed (breaking):** webhook event names: `monitor.hit` is `monitor.result.found`, `monitor.update` is `monitor.result.changed` and `monitor.change` is `monitor.page.changed`. `WebhookEventData::result` is unchanged. A check against an old name still compiles but never matches, so search your webhook handlers for them.
- **Removed:** fields the API no longer sends: `MonitorResult::score`, `favicon` and `highlights`; `Monitor::agent_run_id`, `backfill`, `memory_scope`, `estimated_cost_usd` and `cost_this_month_usd`; `MonitorRun::usage`.
- **Added:** page monitors. `MonitorCreateParams { monitor_type: Some("page".into()), page: Some(MonitorPageTarget::new(url)), .. }` (`monitor_type` is sent as `type`) watches one page and reports the changes worth telling; `MonitorUpdateParams::page` merges into the stored page (a new `url` starts a new baseline, `watch_for: Some(String::new())` clears it). `create` refuses before sending a `monitor_type` other than "search" or "page", a page monitor without `page.url` or with `search`, and a search monitor with `page`.
- **Added:** `monitors().versions(id, &MonitorVersionsParams { limit, cursor })` reads a page monitor's history (`GET /v1/monitors/{id}/versions`) as a `VersionList` of `MonitorVersion`.
- **Added:** `Monitor::monitor_type` (`type`), `Monitor::page` (`Option<MonitorPageTarget>`) and `Monitor::disabled_reason` (`Option<MonitorDisabledReason>`: `code` `runs_failed`, `webhook_unreachable` or `data_policy` (a page monitor whose organization turned on zero data retention), and `message`).
- **Added:** typed run fields: `MonitorRun::changes` is an `Option<MonitorRunChanges>` (with `diff: Option<MonitorDiff>`), and `MonitorRunOutput` gains `fresh` and `error` (`Option<MonitorRunOutputError>`: `code` `output_failed` or `output_invalid`, and `message`).
- **Added:** the `monitor.page.changed` webhook event (a page monitor's run, in `WebhookEventData::run`, with its `changes`) is documented on `WebhookEventData::run`.
- **Changed (breaking):** `Monitor::search` is now `Option<MonitorSearch>`, `None` for a page monitor; `MonitorRun::changes` changes from `Option<Value>` to an `Option<MonitorRunChanges>`. Code that reads `monitor.search.query` no longer compiles. Before this, a page monitor's `"search": null` failed to parse.
- **Changed:** the schedule docs give the API's limits: interval `10m` to `90d`, cron runs at least 10 minutes apart. The SDK does not check schedules itself.
- **Changed:** the error contract fixtures follow the backend's current catalog, which adds `run_in_progress` (409: the monitor is already running).
- **Changed:** the `objective` docs say what the API now does: the ranker scores results for it together with the query (retrieval reads only the query), at the same price. The option and its behaviour in the SDK are unchanged.

## 0.2.0

- **Added:** Keenable Monitors. `client.monitors()` calls `https://api.keenable.ai/v1/monitors` (or `KEENABLE_API_URL`): `create`, `list`, `list_all` (a `MonitorPager`), `get`, `update`, `delete`, `pause`, `resume`, `trigger`, `runs`, `run`, `pages`, `deliveries`, `stats` and `bulk`, with typed results (`Monitor`, `MonitorRun`, `MonitorResult`, `MonitorDelivery`, `MonitorStats`, `BulkResult`, `List<T>`); `with_request` sets per-call options. Monitors need an API key: without one a call returns `Error::Auth` (code `missing_api_key`) and sends nothing. `create` sends an `Idempotency-Key` (`idempotency_key`, or a new UUID per call), so it is retried safely; `update`, `trigger` and `bulk` are retried only on a 429. In `MonitorUpdateParams`, `Some(None)` removes the name, schedule, output schema, webhook or metadata. Monitor ids `.` and `..` are refused before sending, since they would change the request's path.
- **Added:** `verify_webhook(payload, headers, secret)` and `verify_webhook_with(..., &WebhookOptions)` check a Monitors webhook (Standard Webhooks: HMAC-SHA256, `whsec_` secret, several signatures, 5-minute tolerance) and return a `WebhookEvent`; a failure is the new `Error::WebhookVerification` (`sdk_code()` `webhook_verification`), also for a timestamp of more than 12 digits and a secret with no key after `whsec_`. This adds the dependencies `hmac`, `sha2` and `base64`.
- **Changed:** the error contract fixtures follow the backend's current catalog, including the Monitors codes `monitors_not_enabled`, `monitor_limit_reached` (403, `Error::Auth`), `monitor_option_not_supported`, `idempotency_conflict` (`Error::Api`) and `monitors_unavailable` (503, retryable).

## 0.1.0

First release of the Rust SDK, with the same surface as the Python,
TypeScript and Go SDKs and the same shared conformance cases.

- `Client::search` / `search_with` and `Client::fetch` / `fetch_with`, keyless
  by default; the key comes from `KEENABLE_API_KEY` or `Options::api_key`.
- Every search filter (`mode`, `site`, `exclude_domains`, publication and
  index dates, `snippet_max_length`, `max_results`, `query_time`, `objective`,
  `disable_cards`) and every fetch option (`max_chars`, `live`, `prompt`).
- `to_context()` and `cited()` render results as a numbered, citable block.
- `tools()` and `Client::run_tool_call` for OpenAI-compatible tool calling.
- Typed errors that carry the API's error format v1 fields (`code`,
  `error_type`, `fix`, `retryable`, `retry_after`, `request_id`, `limit`).
- Retries with backoff and Retry-After, a whole-attempt timeout, no
  redirects, and fetch targets on internal hosts refused before sending.
- No deprecated fields: search results have no `description`.
