# Changelog

## Unreleased

`Fetch` takes an optional `*FetchOptions` with `Include` and `MaxImages` (1 to
50, API default 5, only with `Include` "images"). Existing calls compile
unchanged. `Page.Images` then lists the page's images as `Image` (`URL`,
`Role`, `Alt`, `Width`, `Height`, `MimeType`, `Sources`) and
`Page.ImagesTruncated` says whether more were found. `Images` is a non-nil
empty slice when the page has none and nil when it could not be inspected;
`ImagesTruncated` is nil when images were not requested. `ImageRole` is an
open string type with `ImageRoleLogo`, `ImageRoleCover`, `ImageRoleIcon` and
`ImageRoleContent`. The API rejects a bad `Include` or `MaxImages` with a 400.

Links and image URLs in fetched `Content` are now absolute (an API change; no
SDK change). No migration.

`ToContext` (on `SearchResponse` and `Page`) drops markdown images and `<img>`
tags, and resolves relative links against the result's URL (or keeps just the
link text when it cannot). Absolute links are unchanged, and lines left holding
only table pipes are dropped. Fenced code blocks, inline code and `name[i](x)`
calls are left alone, as is a table's header row. `MaxChars` counts the
cleaned text. `Snippet` and
`Content` are untouched. No migration.

## 0.1.1

`SearchOptions` gains `MaxResults` and `QueryTime`. Both are client-only: the
`keenable_search` tool schema is unchanged. No migration.

## 0.1.0

Initial release.

Search, fetch, `ToContext`, and the `keenable_search` / `keenable_fetch` tools.
Keyless by default. No migration.
