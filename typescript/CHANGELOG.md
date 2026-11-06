# Changelog

All notable changes to the `keenable` npm package. Versions follow
[semver](https://semver.org); releases are tagged `ts-v<version>`.

## 0.1.5

- `search()` accepts `excludeDomains`: a list of hosts to keep out of the
  results. A host also excludes its subdomains; up to 1,000 distinct hosts.
  The list is sent as given, including `[]`. The API cleans up unambiguous
  entries (scheme, `www.`, case, port, trailing `/`, query, whitespace) and
  rejects anything else (paths, suffixes such as `.com`, wildcards, IP
  addresses, `user@host`, invalid hosts) with HTTP 400. If every result is
  excluded, the response can be empty. `site` is unchanged.
- The `keenable_search` tool offers `exclude_domains` alongside `site`.
  `runToolCall` sends the argument as given: only an absent or `null` value (or
  `""`) is unset, a lone string is wrapped, and any other value goes to the
  API, which rejects a malformed one with a 400.
- `KeenableAPIError.data` holds the decoded JSON error body. A rejected entry
  is a 400 whose `field`, `value` and `reason` name it (set only when the
  body's `error` is `invalid_filter`, `undefined` otherwise).
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
