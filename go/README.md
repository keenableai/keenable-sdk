# keenable

Official Go SDK for [Keenable](https://keenable.ai), a web search API built for
AI agents: ranked results that come back with the page text already extracted,
plus a fetch endpoint that returns any URL as clean markdown.

**Keyless by default.** Every call works with no account and no key. An optional
`KEENABLE_API_KEY` only lifts the hourly rate limit.

```bash
go get github.com/keenableai/keenable-sdk/go@v0.1.0
```

Go 1.22 or newer. The module uses only the standard library.

That version is the git tag `go/v0.1.0` on `github.com/keenableai/keenable-sdk`
(the `go/` prefix is the directory, and it is not part of the `@v0.1.0` you
pass to `go get`). Until that tag exists, `go get` cannot resolve the module.
From a checkout of this repo, the same program is `example/hello`:

```bash
cd go && go run ./example/hello
```

## Search

```go
package main

import (
	"context"
	"fmt"
	"log"

	"github.com/keenableai/keenable-sdk/go"
)

func main() {
	client, err := keenable.New(nil) // or set KEENABLE_API_KEY
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	results, err := client.Search(context.Background(), "how wafer scale chips avoid the memory bottleneck", nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(results.ToContext(nil))
}
```

Results carry the page text in `Snippet`. (`Description` is the page's meta
description and is nil for most pages, so build prompts from `Snippet`.)

Filters are optional and combine freely. Empty strings are left unset. A
pointer is used where zero or false is a real value:

```go
snippetCap := 500
results, err := client.Search(context.Background(), "post-training quantization results", &keenable.SearchOptions{
	Site:             "arxiv.org",
	PublishedAfter:   "2026-01-01",
	SnippetMaxLength: &snippetCap,
})
```

| Field | What it does |
|---|---|
| `Site` | Restrict to one domain, e.g. `"arxiv.org"` |
| `IncludeDomains` | Only return results from these domains (allow-list); see below |
| `ExcludeDomains` | Never return results from these domains (block-list) |
| `PublishedAfter` / `PublishedBefore` | Filter by publication date (`YYYY-MM-DD`) |
| `AcquiredAfter` / `AcquiredBefore` | Filter by when Keenable indexed the page |
| `SnippetMaxLength` | Cap the page text returned per result. Nil means unset; a pointer to zero is sent |
| `MaxResults` | How many results to return, 1 to 50. Zero means the API default of 10 |
| `QueryTime` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `Mode` | Search mode; empty means `"pro"` |

### Domain allow-lists and block-lists

`IncludeDomains` keeps only results from the listed sites; `ExcludeDomains`
drops results from them. Set both and a result must match the allow-list and
miss the block-list (exclude wins).

```go
results, err := client.Search(ctx, "Security Council resolution on the situation in Sudan", &keenable.SearchOptions{
	IncludeDomains: []string{"press.un.org", "undocs.org", "documents.un.org"},
	ExcludeDomains: []string{"blogs.un.org"},
})
```

Each entry is one of:

| Entry | Matches |
|---|---|
| `"un.org"` | the domain and all its subdomains |
| `"un.org/en/ga"` | that path prefix, on whole segments (`/en/ga/x`, not `/en/gax`) |
| `".gov"`, `"*.gov"`, `".gov.uk"` | every host under that suffix |

Matching ignores case, a leading `www.` and a trailing `/`. Up to 200 entries
across both lists. A narrow list can return fewer than `MaxResults`; when
results had to be removed to honour it, the response says so in
`results.Raw["warning"]`.

**Nil versus empty.** A nil slice is unset and is not sent. A non-nil empty
slice (`[]string{}`) is sent as `[]`, and the API rejects an empty
`IncludeDomains` with HTTP 400. That is deliberate: an allow-list that ends up
empty fails loudly instead of quietly searching the whole web. The Python and
TypeScript SDKs send `[]` the same way.

The API validates every entry. An entry with a scheme, port, query or IP
address, the same entry in both lists, or `IncludeDomains` together with
`Site` is an `*APIError` with `StatusCode` 400. Its message (`Body`) names the
field, the entry and the reason:

```go
var api *keenable.APIError
if errors.As(err, &api) && api.StatusCode == 400 {
	fmt.Println(api.Body)
	// Invalid include_domains value "https://un.org": scheme is not allowed
}
```

The field, entry and reason are only in that message; the API sends no
separate keys for them. `Data` holds the whole decoded body
(`{"error": "Bad request", "message": "..."}`).

**Tool calls.** `RunToolCall` checks the type of a list argument before it
sends anything: `IncludeDomains` is a `[]string`, so a model's
`"exclude_domains": ["a.com", 7]` or `"exclude_domains": 7` is an
`*InvalidRequestError` and no request is made. Dropping the bad value instead
would widen the search. The Python and TypeScript tool helpers have no typed
field to fill, so they send such a value as given and the API returns the 400.
Entries that are strings are never checked locally in any SDK.

`Site` still works for a single domain. The `keenable_search` tool offers the
model `site`, `include_domains` and `exclude_domains`.

## Ground a model in one line

`ToContext` renders the result set as a numbered, citable block you can drop
straight into a prompt:

```go
contextText := results.ToContext(nil)
prompt := "Answer using only these sources, citing them by number.\n\n" + contextText
```

It emits `[1] Title (url)` headers followed by the page text, adds results whole
until the character budget is reached (`MaxChars` 12000 by default), and never
truncates a source mid-sentence. The first result is kept even when it alone
is over the budget. A later result that does not fit ends the block, so
citation numbers stay contiguous.

To print a source list that matches the citations in the answer, ask which
results were actually rendered rather than listing them all:

```go
for i, result := range results.Cited(nil) {
	fmt.Printf("[%d] %s - %s\n", i+1, result.Title, result.URL)
}
```

## Read a full page

```go
page, err := client.Fetch(context.Background(), "https://cerebras.ai/chip")
if err != nil {
	log.Fatal(err)
}
fmt.Println(page.Title)
fmt.Println(page.Content)       // markdown, boilerplate stripped
fmt.Println(page.ToContext(nil)) // same citable block shape as search results
```

Internal hosts and private addresses are refused before a request is sent.

## Tool calling

The SDK ships OpenAI-compatible tool definitions, so any inference API that
speaks that schema can call Keenable directly:

```go
response, err := chat(messages, keenable.Tools)
if err != nil {
	log.Fatal(err)
}
for _, call := range response.ToolCalls {
	content, err := keenable.RunToolCall(ctx, client, call.Name, call.Arguments)
	if err != nil {
		// One bad URL should not kill the agent loop.
		content = "Tool call failed: " + err.Error()
	}
	messages = append(messages, ToolMessage{ID: call.ID, Content: content})
}
```

`Tools` exposes `keenable_search` and `keenable_fetch`. `RunToolCall` executes
whichever the model picked and returns text ready for the tool message. Both
tools render the same numbered, citable block, so the model can cite a fetched
page the way it cites a search result. Arguments may be a JSON string,
`[]byte`, `json.RawMessage`, or `map[string]any`.

The model may set `site` and `published_after` on search. The other filters
stay on `Search` for you to set yourself.

## Context and timeouts

Pass the request's `context.Context`. Canceling it returns `ctx.Err()`
(`context.Canceled` or `context.DeadlineExceeded`), not a connection error.
Those two values do not implement `keenable.Error`.

`Options.Timeout` (default 30s) covers response headers and the body when this
SDK creates the HTTP client. A positive `Options.Timeout` also applies when
you pass your own `http.Client`, and it does not change that client. When the
SDK deadline fires and the caller's context is still live, the error is a
`ConnectionError` that tells you to raise `Options.Timeout`. When the deadline
that fires is `http.Client.Timeout`, the message tells you to raise that
instead.

There is one client. Reuse it. `Close` drops idle connections on the client
this SDK created, and does nothing when you passed your own `http.Client`.

## Errors

SDK errors implement `keenable.Error`. `errors.As` into that interface
catches them. `Code()` is a stable string, and the same token is the last
parentheses of `Error()`. `errors.As` into a concrete type catches one case.
`AuthError` and `RateLimitError` unwrap to `APIError`.

A caller context that ended is not one of those errors. Check it first:

```go
if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
    return err
}
var sdk keenable.Error
if errors.As(err, &sdk) {
    fmt.Println(sdk.Code()) // invalid_request, connection, api_error, auth, rate_limit
}
```

| Type | Code | When |
|---|---|---|
| `RateLimitError` | `rate_limit` | HTTP 429. The message names `X-RateLimit-Reset` when the API sent it. A keyless call is told to set `KEENABLE_API_KEY`. A keyed call is told to wait for the window |
| `AuthError` | `auth` | HTTP 401/403, the key was rejected |
| `APIError` | `api_error` | Any other non-2xx response; carries `StatusCode`, `Body`, `Data` (the decoded JSON error body), and `RequestID` when the API sent `X-Request-Id` |
| `ConnectionError` | `connection` | The API could not be reached, or the client deadline elapsed |
| `InvalidRequestError` | `invalid_request` | Bad arguments; no request was sent |

HTTP 402 is an `APIError` whose message starts "Keenable: insufficient credits (402)" and tells you to add credits.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KEENABLE_API_KEY` | unset | Lifts the hourly rate limit. Create one at [keenable.ai/console](https://keenable.ai/console) |
| `KEENABLE_API_URL` | `https://api.keenable.ai` | Override the API base URL |

`New(nil)` reads both. `APIKey` and `BaseURL` are pointers so "unset" and
"explicitly empty" differ: nil reads the environment, a pointer to `""` forces
keyless (or rejects an empty base URL) even when the variable is set. A Go
literal cannot be addressed, so put the string in a variable:

```go
key := "keen_..."
client, err := keenable.New(&keenable.Options{APIKey: &key})
```

`BaseURL` must be `https`, except `http` to `localhost`, `127.0.0.1`, or `::1`.
It cannot include a query string or a fragment. `Timeout` of zero means 30
seconds when this SDK creates the HTTP client. When you pass `HTTPClient`,
zero adds no extra deadline and that client's `Timeout` is left unchanged.
`ClientSource` is sent as
`X-Keenable-Title`; empty means "Keenable SDK". Set it when you wrap this SDK
and want your own traffic attribution.

## License

MIT
