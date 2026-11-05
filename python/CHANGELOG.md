# Changelog

All notable changes to the `keenable` Python package. Versions follow
[semver](https://semver.org); releases are tagged `python-v<version>`.

## Unreleased

- `fetch()` (sync and async) accepts `include=["images"]` and `max_images`
  (1 to 50, API default 5, only with `include`). `Page.images` then lists the
  page's images as `Image` (`url`, `role`, `alt`, `width`, `height`,
  `mime_type`, `sources`) and `Page.images_truncated` says whether more were
  found. `alt`, `width`, `height` and `mime_type` are `None` when the page
  gave none. `images` is `[]` when the page has none and `None` when it could not
  be inspected; both stay `None` when images were not requested. `role` is
  `"logo"`, `"cover"`, `"icon"` or `"content"`, and the set is open. The API
  rejects a bad `include` or `max_images` with a 400.
- API change, no SDK change: links and image URLs in fetched `content` are now
  absolute.

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
