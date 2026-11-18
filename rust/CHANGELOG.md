# Changelog

## Unreleased

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
