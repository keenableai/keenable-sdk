# Changelog

## 0.1.2

`SearchOptions` gains `IncludeDomains` and `ExcludeDomains`: lists of hosts
(`un.org`, which also covers its subdomains) to search only within, or to keep
out. Up to 50 included and 200 excluded hosts. The API cleans up entries (case,
scheme, `www.`, trailing `/`) and says so in the response `warning`, and
rejects paths, suffixes such as `.gov`, IP addresses and other non-hosts with
400. A nil slice is unset; a non-nil empty slice is sent as `[]` (the API
rejects an empty `IncludeDomains` with 400).
`Site` is unchanged. The `keenable_search` tool offers both lists alongside
`site`.

`APIError.Data` holds the decoded JSON error body. A rejected filter is a 400
whose message names the field, entry and reason (`Invalid include_domains value
"x": <reason>`), and `APIError.Field`, `Value` and `Reason` hold them
separately (set only when the body's `error` is `invalid_filter`). A 400 no
longer advises a retry: it says to fix the argument the API named, or to check
the request arguments when the API named none.

`RunToolCall` sends `include_domains` / `exclude_domains` arguments to the API
as given and checks nothing itself: `[]` is sent as `[]` (an empty allow-list
is a 400, never an unrestricted search), `null` and `""` are unset, a lone
string is wrapped, and a malformed value (a number, a non-string entry) goes to
the API, which returns the 400. No migration.

`ToContext` (on `SearchResponse` and `Page`) drops markdown images and `<img>`
tags, and resolves relative links against the result's URL (or keeps just the
link text when it cannot). Absolute links are unchanged, and lines left holding
only table pipes are dropped. Fenced code blocks, inline code and `name[i](x)`
calls are left alone, as is a table's header row. `MaxChars` counts the
cleaned text. `Snippet` and `Content` are untouched. No migration.

## 0.1.1

`SearchOptions` gains `MaxResults` and `QueryTime`. Both are client-only: the
`keenable_search` tool schema is unchanged. No migration.

## 0.1.0

Initial release.

Search, fetch, `ToContext`, and the `keenable_search` / `keenable_fetch` tools.
Keyless by default. No migration.
