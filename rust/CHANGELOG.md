# Changelog

## Unreleased

- **Breaking (1.0.0):** `Client::fetch` and `fetch_with` read up to 10 pages
  in one call with `POST /v1/fetch` and return a `FetchResponse`, not a
  `Page`: `fetch<S: AsRef<str>>(&self, urls: &[S])` and
  `fetch_with(&self, urls: &[S], opts: &FetchOptions)`. `results[i]` is for
  `urls[i]`: its `page`, or its `error` when that URL failed. `error` is the
  `Error` the call would return for that status, and it is not returned: the
  call fails only as a whole.
  - `FetchOptions` applies to every page: `max_chars` (at least 1), `schema`
    (a JSON Schema whose root has `"type": "object"`; the answer is in
    `Page::structured`, or `Page::answer_error` says why not), `links` (1 to
    1000), `images` (0 to 25) and `max_age_hours` (0 to 720, fractions
    allowed; `Some(0.0)` reads live), next to `request`. A value outside these
    limits, or more than 10 URLs, is `Error::InvalidRequest` before a request
    is sent.
  - `Page` gains `image`, `favicon`, `links`, `images`, `structured`,
    `answer_error`, `stale` and `usage`, and loses `request_id`: read
    `FetchResponse::request_id`.
  - Removed: `GET /v1/fetch` and its `live` and `prompt` options. Pass
    `max_age_hours: Some(0.0)` for a live read; `schema` returns a typed
    answer where `prompt` returned text.
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
