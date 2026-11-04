# Changelog

All notable changes to the `keenable` Python package. Versions follow
[semver](https://semver.org); releases are tagged `python-v<version>`.

## Unreleased

- `search()` (sync and async) accepts `include_domains` and `exclude_domains`:
  lists of domains (`un.org`), domain path prefixes (`un.org/en/ga`) or
  suffixes (`.gov`) to search only within, or to keep out. Lists are sent as
  given, including `[]`; the API validates them and rejects bad entries with
  HTTP 400. `site` is unchanged.
- The `keenable_search` tool offers `include_domains` and `exclude_domains`
  alongside `site`.
- `KeenableAPIError.data` holds the decoded JSON error body. A rejected filter
  is a 400 whose message names the field, entry and reason
  (`Invalid include_domains value "x": <reason>`).
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
