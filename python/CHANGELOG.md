# Changelog

All notable changes to the `keenable` Python package. Versions follow
[semver](https://semver.org); releases are tagged `python-v<version>`.

## Unreleased

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
- `timeout` and `max_retries` are validated: a non-positive timeout or a
  negative retry count raises `KeenableInvalidRequestError`.

- Errors carry the API's agent-ready fields: `code`, `error`, `fix`,
  `docs_url`, `retryable`, `retry_after_seconds` (from the body, else the
  `Retry-After` header), `request_id` (body, else `X-Request-Id`), `param`,
  `limit` (a new `RateLimitInfo`), `billing_url`, `auto_top_up_url`,
  `pay_per_request` and `raw`. Each is `None` when the API does not send it.
- New `KeenableInsufficientCreditsError` (alias `KeenableCreditsError`) for HTTP 402. It subclasses
  `KeenableAPIError`, and the message is unchanged, so existing handlers keep
  working.
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
- `str(err)` ends with `Docs: <docs_url>`, `(code: <code>)` and
  `(request_id: <id>)` when the API sends them, the way Stripe's SDKs print the
  doc link and request id. `body` is unchanged, and so is the message of a
  response without any of these fields.
  A message that already ends in a period no longer gets a second one before
  the fix.

- `to_context()` (search results and fetched pages) drops markdown images and
  `<img>` tags, and resolves relative links against the result's URL (or keeps
  just the link text when it cannot). Absolute links are unchanged, and lines
  left holding only table pipes are dropped. The `max_chars` budget counts the
  cleaned text. Fenced code blocks, inline code and `name[i](x)` calls are
  left alone, as is a table's header row. `snippet` and `content` are
  untouched.

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
