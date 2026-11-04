# Changelog

## Unreleased

`SearchOptions` gains `IncludeDomains` and `ExcludeDomains`: lists of domains
(`un.org`), domain path prefixes (`un.org/en/ga`) or suffixes (`.gov`) to
search only within, or to keep out. A nil slice is unset; a non-nil empty
slice is sent as `[]` (the API rejects an empty `IncludeDomains` with 400).
`Site` is unchanged. The `keenable_search` tool offers both lists alongside
`site`.

`APIError.Data` holds the decoded JSON error body. A rejected filter is a 400
whose message names the field, entry and reason (`Invalid include_domains value
"x": <reason>`). A 400 no longer advises a retry: it says to fix the argument
the API named, or to check the request arguments when the API named none.

`RunToolCall` refuses a domain-list argument that is not a string or a list of
strings with `*InvalidRequestError`, without sending a request. This is the one
place the SDK checks a filter itself: `IncludeDomains` is a `[]string`, and
dropping the value would widen the search. No migration.

## 0.1.1

`SearchOptions` gains `MaxResults` and `QueryTime`. Both are client-only: the
`keenable_search` tool schema is unchanged. No migration.

## 0.1.0

Initial release.

Search, fetch, `ToContext`, and the `keenable_search` / `keenable_fetch` tools.
Keyless by default. No migration.
