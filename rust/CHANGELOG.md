# Changelog

## Unreleased

- `Client::fetch_many` / `fetch_many_with` read up to 20 pages in one call
  with `POST /v1/fetch`. `FetchManyOptions`
  mirrors the API's groups: `content: Option<FetchContentOptions>`
  (`max_chars`, default 50,000 and `Some(0)` for metadata only; `objective`;
  `schema`; `links`; `images`), `retrieval: Option<FetchRetrievalOptions>`
  (`max_age_hours`, 0 to 720 with fractions, `Some(0.0)` always live, `None`
  takes the stored copy; or `as_of`, `"P0D"` for stored copies only), plus
  `deadline_ms` and `session_id`. `results[i]` is the entry for `urls[i]`, with
  the page in `content` (`text`, `total_chars`, `answer`, `links`, `images`)
  and `retrieved_from`; a failed page has its `error` set, not an `Err`.
  Preview: it works once `POST /v1/fetch` is enabled for your organization.
- **Changed:** the error variant follows the body's `type`, not the status: `authentication_error` and `permission_error` give `Error::Auth`, `rate_limit_error` `Error::RateLimit`, `billing_error` `Error::InsufficientCredits`, and a 429 about the fetched page (`target_error`) `Error::Api`. A body without a known type still maps by status.

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
