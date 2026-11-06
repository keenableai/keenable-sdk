# Changelog

All notable changes to the `keenable` npm package. Versions follow
[semver](https://semver.org); releases are tagged `ts-v<version>`.

## 0.1.5

- `search()` accepts `includeDomains` and `excludeDomains`: lists of domains
  (`un.org`), domain path prefixes (`un.org/en/ga`) or suffixes (`.gov`) to
  search only within, or to keep out. Lists are sent as given, including
  `[]`; the API validates them and rejects bad entries with HTTP 400. `site`
  is unchanged.
- The `keenable_search` tool offers `include_domains` and `exclude_domains`
  alongside `site`.
  `runToolCall` sends a list as given, `[]` included, so an empty
  `include_domains` comes back as a 400 instead of running an unrestricted
  search. Only an absent or `null` list (or `""`) is unset; a lone string is
  wrapped. Any other value (a number, a non-string entry) is sent as given
  too, so the API rejects it with a 400 rather than the SDK dropping it and
  widening the search.
- `KeenableAPIError.data` holds the decoded JSON error body. A rejected filter
  is a 400 whose message names the field, entry and reason
  (`Invalid include_domains value "x": <reason>`), and
  `KeenableAPIError.field`, `.value` and `.reason` hold them separately
  (set only when the body's `error` is `invalid_filter`, `undefined` otherwise).
- `toContext()` (search results and fetched pages) drops markdown images and
  `<img>` tags, and resolves relative links against the result's URL (or keeps
  just the link text when it cannot). Absolute links are unchanged, and lines
  left holding only table pipes are dropped. The `maxChars` budget counts the
  cleaned text. Fenced code blocks, inline code and `name[i](x)` calls are
  left alone, as is a table's header row. `snippet` and `content` are
  untouched.

## 0.1.4

- `search()` accepts `maxResults` (1 to 50) and `queryTime`.

## 0.1.3

- `SearchResult.description` and `Page.description` are deprecated: the API no
  longer fills them. Read `snippet` / `content`.

## 0.1.2

- The request deadline and the caller's `AbortSignal` now cover the response
  body, not just the headers.

## 0.1.1

- Added `SearchResponse.cited()`: the results `toContext()` actually rendered,
  in citation order.
- Added `Page.toContext()`: a fetched page renders as the same numbered,
  citable block as search results, and `keenable_fetch` returns it.
- Added `clientSource` so an integration keeps its own traffic attribution.
- `toContext()` collapses whitespace in snippets, and skips an over-budget
  result instead of stopping at it, so citation numbers stay contiguous.
- `fetch()` refuses IPv4-mapped IPv6 addresses (`[::ffff:169.254.169.254]`)
  and trailing-dot hosts before any request is sent.
- Tool-call arguments that are not a JSON object raise
  `KeenableInvalidRequestError` instead of silently becoming "no query".
- The package version is injected at build time, so the User-Agent can't go
  stale.

## 0.1.0

- Initial release: search, fetch, `toContext()`, and the `keenable_search` /
  `keenable_fetch` tools. Keyless by default.
