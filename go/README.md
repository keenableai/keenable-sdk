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
| `PublishedAfter` / `PublishedBefore` | Filter by publication date (`YYYY-MM-DD`) |
| `AcquiredAfter` / `AcquiredBefore` | Filter by when Keenable indexed the page |
| `SnippetMaxLength` | Cap the page text returned per result. Nil means unset; a pointer to zero is sent |
| `MaxResults` | How many results to return, 1 to 50. Zero means the API default of 10 |
| `QueryTime` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `Mode` | `"pro"` (default when empty) does deeper retrieval; `"realtime"` is the fastest |

Advanced, for agent frameworks: `SessionID` groups the calls of one agent
session (send the same value on each call), and `EnableWizards` turns on
experimental structured-data extraction (`"pro"` mode only).

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
page, err := client.Fetch(context.Background(), "https://cerebras.ai/chip", nil)
if err != nil {
	log.Fatal(err)
}
fmt.Println(page.Title)
fmt.Println(page.Content)       // markdown, boilerplate stripped
fmt.Println(page.ToContext(nil)) // same citable block shape as search results
```

Internal hosts and private addresses are refused before a request is sent.

`Fetch` takes a `*keenable.FetchOptions` (nil for none):

| Field | What it does |
|---|---|
| `MaxChars` | Cap the content (API default 50,000). A cut page ends with a note saying so |
| `Live` | Fetch from the source when the page is not in the index yet |
| `Prompt` | Return the answer to this instruction, extracted from the page, instead of the full page |
| `SessionID` | Same as on `SearchOptions` |

## Going further

More results, faster, and only recent pages:

```go
results, err := client.Search(ctx, "open-weight model releases", &keenable.SearchOptions{
	Mode:           "realtime",   // fastest mode, for latency-sensitive calls
	MaxResults:     25,           // up to 50; the default is 10
	PublishedAfter: "2026-10-01", // recency filter
})
```

Read just the part of a page you need, from the source if it is not indexed
yet:

```go
live := true
page, err := client.Fetch(ctx, "https://example.com/", &keenable.FetchOptions{
	Live:   &live,
	Prompt: "What is this domain for? One sentence.",
})
```

`QueryTime` is the opposite of a recency filter: it searches the index as it
stood at that moment and excludes everything newer, which is useful for
reproducing past results.

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
Every typed API error unwraps to `APIError`, and `ForbiddenError` also
unwraps to `AuthError`, so `errors.As` into `*AuthError` matches 401 and 403.

`APIError` carries `StatusCode`, `Body` (the API's message), `APIErrorCode`
(the API's short label), `Details`, `RequestID` and `Hint` (the next step: `Error()` ends with it,
followed only by the code). `SearchResponse` and `Page` carry `RequestID` too.

A caller context that ended is not one of those errors. Check it first:

```go
if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
    return err
}
var sdk keenable.Error
if errors.As(err, &sdk) {
    fmt.Println(sdk.Code()) // invalid_request, connection, api_error, auth, rate_limit, validation, credits, forbidden
}
```

| Type | Code | When |
|---|---|---|
| `ValidationError` | `validation` | HTTP 400/422. The API rejected the request; the message says what. Retrying unchanged fails |
| `AuthError` | `auth` | HTTP 401. The API key is missing or invalid |
| `ForbiddenError` | `forbidden` | HTTP 403. Not allowed for this key or tier. Unwraps to `AuthError` |
| `CreditsError` | `credits` | HTTP 402. Out of credits; add them at keenable.ai/console |
| `RateLimitError` | `rate_limit` | HTTP 429. The message names `X-RateLimit-Reset` when the API sent it. A keyless call is told to set `KEENABLE_API_KEY`. A keyed call is told to wait for the window |
| `APIError` | `api_error` | Any other non-2xx response. Follow the hint: a 5xx is safe to retry, a 404 means the URL doesn't exist |
| `ConnectionError` | `connection` | The API could not be reached, or the client deadline elapsed |
| `InvalidRequestError` | `invalid_request` | Bad arguments; no request was sent |

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
