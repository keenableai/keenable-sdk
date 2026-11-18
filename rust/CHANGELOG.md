# Changelog

## Unreleased

- **Added:** page monitors. `MonitorCreateParams { monitor_type: Some("page".into()), page: Some(MonitorPageTarget::new(url)), .. }` (`monitor_type` is sent as `type`) watches one page and reports the changes worth telling; `MonitorUpdateParams::page` merges into the stored page (a new `url` starts a new baseline, `watch_for: Some(String::new())` clears it). `create` refuses before sending a `monitor_type` other than "search" or "page", a page monitor without `page.url` or with `search`, and a search monitor with `page`.
- **Added:** `monitors().versions(id, &MonitorVersionsParams { limit, cursor })` reads a page monitor's history (`GET /v1/monitors/{id}/versions`) as a `VersionList` of `MonitorVersion`.
- **Added:** `Monitor::monitor_type` (`type`), `Monitor::page` (`Option<MonitorPageTarget>`) and `Monitor::disabled_reason` (`Option<MonitorDisabledReason>`: `code` `runs_failed`, `webhook_unreachable` or `insufficient_credits`, and `message`).
- **Added:** typed run fields: `MonitorRun::changes` is an `Option<MonitorRunChanges>` (with `diff: Option<MonitorDiff>`), `MonitorRun::usage` an `Option<MonitorRunUsage>` (`runs`, `credits`, `cost_usd`), and `MonitorRunOutput` gains `fresh` and `error` (`Option<MonitorRunOutputError>`: `code` `output_failed` or `output_invalid`, and `message`).
- **Added:** the `monitor.change` webhook event (a page monitor's run, in `WebhookEventData::run`, with its `changes`) is documented on `WebhookEventData::run`.
- **Changed (breaking):** `Monitor::search` is now `Option<MonitorSearch>`, `None` for a page monitor; `MonitorRun::changes` and `MonitorRun::usage` change from `Option<Value>` to typed options. Code that reads `monitor.search.query` no longer compiles. Before this, a page monitor's `"search": null` failed to parse.
- **Removed (breaking):** `Monitor::estimated_cost_usd` (`estimated_cost_usd`; always null; a run costs $0.002, see `cost_this_month_usd` and run `usage`).
- **Changed:** `Monitor::cost_this_month_usd` is filled now that runs are priced ($0.002 a run); the schedule docs give the API's limits: interval `10m` to `90d`, cron runs at least 10 minutes apart. The SDK does not check schedules itself.
- **Changed:** the error contract fixtures follow the backend's current catalog: `monitor_limit_reached` (403) now points to contact sales for a higher limit.

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
