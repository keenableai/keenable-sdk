# Changelog

## Unreleased

- `Client::fetch_many` / `fetch_many_with` read up to 100 pages in one call
  with `POST /v1/fetch` (keyless calls take up to 20). `FetchManyOptions`
  mirrors the API's groups: `content: Option<FetchContentOptions>`
  (`max_chars`, default 50,000 and `Some(0)` for metadata only; `objective`;
  `schema`; `links`; `images`), `retrieval: Option<FetchRetrievalOptions>`
  (`max_age_hours`, 0 to 720 with fractions, `Some(0.0)` always live, `None`
  takes the stored copy; or `as_of`, `"P0D"` for stored copies only) and
  `output: Option<FetchOutputOptions>` (`prompt`, `schema`; an empty group asks
  for a prose answer), plus `deadline_ms` and `session_id`. `results[i]` is the
  entry for `urls[i]`, with the page in `content` (`text`, `total_chars`,
  `answer`, `links`, `images`) and `retrieved_from`; a failed page has its
  `error` set, not an `Err`. The answer across pages is `output` (`text`,
  `structured`, `based_on`, `grounding` with verified citations). Preview: it
  works once `POST /v1/fetch` is enabled for your organization.

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
