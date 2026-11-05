# Changelog

## 0.2.0

- From 0.2.0 the Python, TypeScript and Go SDKs share one version number and
  release together, so Go skips from 0.1.1 to 0.2.0.
- `Page.PublishedAt` was silently dropped because the API sends a Unix
  timestamp. It is now converted to an ISO-8601 UTC string, matching search.
- `Description` on search results mirrors `Snippet` when the API leaves it
  empty (it always does today), for code written against `Description`. It
  stays deprecated: if you render both fields, the text now appears twice.
- `Page.Truncated()` reports whether fetched content was cut at the character
  limit, and `StripTruncationMarker()` removes the API's trailing note for
  callers that want bare text.
- `SearchOptions` gains `SessionID`; `Mode` documents `"realtime"`.
- `SearchOptions.DisableCards` leaves cards (results Keenable writes itself,
  at `https://cards.keenable.ai/w/<id>` URLs) out of search results; web pages
  take their place.
- `Fetch` takes a `*FetchOptions` (`MaxChars`, `Live`, `Prompt`, `SessionID`),
  like `Search` takes `*SearchOptions`: `Fetch(ctx, url, nil)` for none. This
  changes the signature; update `Fetch(ctx, url)` calls.
- New error types by HTTP status: `ValidationError` (400/422, code
  `validation`), `CreditsError` (402, code `credits`) and `ForbiddenError`
  (403, code `forbidden`). `ForbiddenError` unwraps to `AuthError`, so
  `errors.As(err, &authErr)` still matches 403, and every new type unwraps to
  `APIError`. **`Code()` changes for three statuses: 400/422 from `api_error`
  to `validation`, 402 from `api_error` to `credits`, and 403 from `auth` to
  `forbidden`.** A `switch` with a `case keenable.CodeAPI:` that handled bad
  parameters or credits, or a `case keenable.CodeAuth:` that handled 403, needs
  the new codes.
- `Error()` reads `<what failed> (request_id: <id>). <next step> (<code>)`,
  the same order as the Python and TypeScript SDKs; the stable code stays
  last. Before, the request id came after the next step.
- A 400 now ends with "Fix the request" instead of "Retry the request",
  which could never succeed, and a 404 says to check the URL.
- `APIError` gains `APIErrorCode`, `Details` and `Hint`. `SearchResponse` and
  `Page` gain `RequestID`.

## 0.1.1

`SearchOptions` gains `MaxResults` and `QueryTime`. Both are client-only: the
`keenable_search` tool schema is unchanged. No migration.

## 0.1.0

Initial release.

Search, fetch, `ToContext`, and the `keenable_search` / `keenable_fetch` tools.
Keyless by default. No migration.
