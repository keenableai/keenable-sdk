# Changelog

## 0.1.2

`SearchOptions` gains `ExcludeDomains`: a list of hosts to keep out of the
results. A host also excludes its subdomains; up to 1,000 distinct hosts. The
API cleans up unambiguous entries (scheme, `www.`, case, port, trailing `/`,
query, whitespace) and rejects anything else (paths, suffixes such as `.com`,
wildcards, IP addresses, `user@host`, invalid hosts) with 400. A nil slice is
unset; a non-nil empty slice is sent as `[]`. If every result is excluded, the
response can be empty. `Site` is unchanged. The `keenable_search` tool offers
`exclude_domains` alongside `site`.

`APIError.Data` holds the decoded JSON error body. A rejected entry is a 400
whose `APIError.Field`, `Value` and `Reason` name it (set only when the body's
`error` is `invalid_filter`). A 400 no longer advises a retry: it says to fix
the argument the API named, or to check the request arguments when the API
named none.

`RunToolCall` sends an `exclude_domains` argument to the API as given: `[]` is
sent as `[]`, `null` and `""` are unset, a lone string is wrapped, and a
malformed value goes to the API, which returns the 400. No migration.

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
