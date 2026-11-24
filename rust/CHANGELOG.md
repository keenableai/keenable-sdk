# Changelog

## Unreleased

- **Added:** `billing()` and `billing_with(&RequestOptions)` read `GET /v1/billing` (read-only, free) as a `Billing`: `prices` (`BillingPrice` with `sku`, `unit`, `unit_price`, and with a key `list_unit_price` and `source`) and `account` (`Option<BillingAccount>`, `None` without a key: `balance.available`/`purchased`, `usage.since`/`cost`/`line_items`, `billing_url`, `as_of`). Amounts are `Money { amount, currency }` with `amount` an `f64` in US dollars (up to nine decimal places, negative for an account in debt; 0.0 when the API sends no finite number, such as an older server's string). The billing models are `PartialEq` but not `Eq`. The key is optional and the path is `/v1/billing` either way (no `/public` variant).
- **Added:** `SearchOptions::moderation`: `"moderate"` or `"strict"` filters unsafe results; `None`, the default, is no moderation and is not sent. The `keenable_search` tool offers it as an enum. The API supports it in `"pro"` and `"realtime"` modes and answers 400 when the query is a URL.
- **Added:** `SearchResponse::warnings`, a `Vec<SearchWarning>` (`code`, `path`, `message`) naming what a request should change, such as a deprecated parameter. Empty when the API sends none.

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
