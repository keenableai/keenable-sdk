# Changelog

## Unreleased

`SearchOptions` gains `IncludeDomains` and `ExcludeDomains`: lists of domains
(`un.org`), domain path prefixes (`un.org/en/ga`) or suffixes (`.gov`) to
search only within, or to keep out. A nil slice is unset; a non-nil empty
slice is sent as `[]` (the API rejects an empty `IncludeDomains` with 400).
`Site` is unchanged. The `keenable_search` tool offers both lists alongside
`site`.

`APIError.Data` holds the decoded JSON error body. A rejected filter now reads
`invalid_filter: include_domains entry "x": <reason>`, and a 400 no longer
advises a retry. No migration.

## 0.1.1

`SearchOptions` gains `MaxResults` and `QueryTime`. Both are client-only: the
`keenable_search` tool schema is unchanged. No migration.

## 0.1.0

Initial release.

Search, fetch, `ToContext`, and the `keenable_search` / `keenable_fetch` tools.
Keyless by default. No migration.
