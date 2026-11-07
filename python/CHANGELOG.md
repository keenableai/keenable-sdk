# Changelog

All notable changes to the `keenable` Python package. Versions follow
[semver](https://semver.org); releases are tagged `python-v<version>`.

## 0.2.0 (unreleased)

Release this as a minor version, not a patch: the error classes some
responses raise change.

### Upgrading from 0.1.x

- A failed fetch target (a site's 403, a `target_*` code, a missing page) now
  raises `KeenableTargetError`, and a private-URL 403 raises a plain
  `KeenableAPIError`. Before, both raised `KeenableAuthError`. If you caught
  `KeenableAuthError` to handle a blocked fetch, catch `KeenableTargetError`
  instead. `except KeenableAPIError` and `except KeenableError` still catch
  every one of them, and `status_code` is unchanged. A rejected key is still a
  `KeenableAuthError`.
- Some responses that used to raise a bare `KeenableAPIError` now raise a
  subclass: a fetch 404 or 422, a 502 or 504 with a `target_*` code, and a
  code-less `403 Upstream forbidden` raise `KeenableTargetError`, and a 402
  raises `KeenableInsufficientCreditsError`. `except KeenableAPIError` and
  `isinstance` still match them; an exact-class check
  (`type(e) is KeenableAPIError`) does not. Use `isinstance`.
- Error messages end with different advice text. `str(e)` was never a stable
  format: match on the class, `status_code` or `code`.
- The default timeout is 90 seconds, up from 30. If your runtime kills a call
  sooner (a serverless or tool-call deadline under 90 seconds), pass
  `timeout=` below it, so you still get a `KeenableConnectionError` you can
  handle.
- `search()` still sends `mode="pro"` by default, so results and price do not
  change. Pass `org_default_mode=True` to use your organization's default
  instead.

### Changes

- New `KeenableTargetError` (subclasses `KeenableAPIError`) for a page that
  failed rather than your request or key: any `code` starting with `target_`
  (`target_blocked`, `target_unreachable`, `target_timeout`, ...),
  `page_not_found` or `content_not_extracted`. Today's code-less
  `403 Upstream forbidden` from `/v1/fetch` is one too, and its message says
  the site refused the fetch, not your API key. Before, every 403 was a
  `KeenableAuthError`. A site's 429 stays a `KeenableRateLimitError`.
- A 403 for a private or internal URL is a plain `KeenableAPIError`, not a
  `KeenableAuthError`: code `private_url_not_allowed`, or today's code-less
  "Fetching from private/internal hosts" message. Its message says to use a
  public URL.
- A fetch 404 or 422 without a code (page not found, no readable content) is a
  `KeenableTargetError`. The same statuses from search stay a plain
  `KeenableAPIError`, and so is a fetch 404 or 422 whose body is not the API's
  JSON error (a proxy or a wrong `base_url`).
- The generic codes the API may fill in by status (`forbidden`, `not_found`,
  `unprocessable`) are treated like no code, so the fallbacks above still
  apply to them.
- A target error without a `fix` ends with advice not to retry the same URL,
  unless the API sent `retryable: true`.
- New `search(..., org_default_mode=True)`: with `mode` unset, the SDK sends no
  mode, so your organization's default search mode applies. Without it,
  `search()` still sends `mode="pro"`, as before.
- The default `timeout` is 90 seconds, up from 30. The API waits up to 60
  seconds on a slow fetch and bills a fetch that succeeds, so the old default
  could give up on a page you paid for.

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
  oversized value can never break error handling.

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
