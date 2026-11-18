# Changelog

## Unreleased

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
