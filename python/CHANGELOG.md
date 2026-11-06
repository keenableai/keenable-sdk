# Changelog

All notable changes to the `keenable` Python package. Versions follow
[semver](https://semver.org); releases are tagged `python-v<version>`.

## 0.1.4

- `search()` (sync and async) accepts `include_domains` and `exclude_domains`:
  lists of hosts (`un.org`, which also covers its subdomains) to search only
  within, or to keep out. Up to 50 included and 200 excluded hosts. Lists are
  sent as given, including `[]`; the API cleans up entries (case, scheme,
  `www.`, trailing `/`) and says so in the response `warning`, and rejects
  paths, suffixes such as `.gov`, IP addresses and other non-hosts with HTTP
  400. `site` is unchanged.
- The `keenable_search` tool offers `include_domains` and `exclude_domains`
  alongside `site`.
  `run_tool_call` sends a list as given, `[]` included, so an empty
  `include_domains` comes back as a 400 instead of running an unrestricted
  search. Only an absent or `null` list (or `""`) is unset; a lone string is
  wrapped. Any other value (a number, a non-string entry) is sent as given
  too, so the API rejects it with a 400 rather than the SDK dropping it and
  widening the search.
- `KeenableAPIError.data` holds the decoded JSON error body. A rejected filter
  is a 400 whose message names the field, entry and reason
  (`Invalid include_domains value "x": <reason>`), and
  `KeenableAPIError.field`, `.value` and `.reason` hold them separately
  (set only when the body's `error` is `invalid_filter`, `None` otherwise).
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
