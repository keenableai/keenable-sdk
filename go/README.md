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
| `Mode` | Search mode; empty means `"pro"` |

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

`Options.Timeout` (default 30s) covers response headers and the body of each
attempt when this SDK creates the HTTP client. A positive `Options.Timeout` also applies when
you pass your own `http.Client`, and it does not change that client. When the
SDK deadline fires and the caller's context is still live, the error is a
`ConnectionError` that tells you to raise `Options.Timeout`. When the deadline
that fires is `http.Client.Timeout`, the message tells you to raise that
instead. Either way `ConnectionError.Timeout()` reports true. Timed-out
attempts are retried (see [Retries](#retries)).

There is one client. Reuse it. `Close` drops idle connections on the client
this SDK created, and does nothing when you passed your own `http.Client`.

## Errors

SDK errors implement `keenable.Error`. `errors.As` into that interface
catches them. `Code()` is a stable string, and the same token is the last
parentheses of `Error()`. `errors.As` into a concrete type catches one case.
`AuthError`, `RateLimitError` and `InsufficientCreditsError` unwrap to
`APIError`.

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
| `InsufficientCreditsError` (alias `CreditsError`) | `api_error` | HTTP 402, no credits left; retrying will not help. The message starts "Keenable: insufficient credits (402)" |
| `APIError` | `api_error` | Any other non-2xx response; carries `StatusCode`, `Body`, and `RequestID` when the API sent `X-Request-Id` |
| `ConnectionError` | `connection` | The API could not be reached, or the client deadline elapsed (`Timeout()` reports which) |
| `InvalidRequestError` | `invalid_request` | Bad arguments; no request was sent |

## Handling errors

The SDK already retries what can be retried (see
[Retries](#retries)), so an error that reaches you is final for this call.
Every `APIError` carries what the API says about the failure. Branch on
`APICode`, not on the message. Each field is its zero value (nil for
`Retryable` and `RateLimit`) when the API did not send it. `Code()` stays the
SDK's coarser code above.

```go
resp, err := client.Search(ctx, "wafer scale engine", nil)
var rl *keenable.RateLimitError
var api *keenable.APIError
switch {
case errors.As(err, &rl):
    // Only reaches you when the wait is over a minute (e.g. the keyless
    // hourly cap) or the retries ran out.
    log.Printf("rate limited, retry in %s: %s", rl.RetryAfter, rl.Fix)
case errors.As(err, &api):
    log.Println(api.APICode, api.Fix, api.DocsURL, api.RequestID)
}
```

| Field | Meaning |
|---|---|
| `APICode` | Stable reason, e.g. `rate_limit_per_second`, `insufficient_credits`, `target_blocked` |
| `Type` | The category, one of the `Type*` constants: `invalid_request_error`, `authentication_error`, `permission_error`, `billing_error`, `rate_limit_error`, `target_error` (the page being fetched failed, not Keenable) or `api_error`; derived from the status when an older API leaves it out |
| `Title` | The API's short error title (its `error` field) |
| `Fix` | One sentence on what to do next |
| `DocsURL` | The docs page for this error |
| `Retryable` | Whether the same request can succeed later |
| `RetryAfter` | How long to wait (body `retry_after_seconds`, else the `Retry-After` header) |
| `RequestID` | Quote it when reporting a problem |
| `Param` | The parameter a 400 is about |
| `RateLimit` | On a 429: `Scope`, `Window`, `Max`, `ResetsAt` |
| `BillingURL`, `AutoTopUpURL`, `PayPerRequest` | On a 402: where to add credits and the alternatives |
| `Raw` | The whole JSON error body |

When the API sends `Fix`, the error message ends with it in place of the
SDK's generic advice (for every status, as in the Python and TypeScript SDKs),
so a non-retryable error never tells an agent to retry. It then ends with
`Docs: <DocsURL>`, `(code: <APICode>)` and `(request_id: <RequestID>)` before
the SDK code, as in the Python and TypeScript SDKs. A 403 with type `target_error` (e.g. code
`target_blocked`, the fetched site refused us) is a plain `APIError`, not an `AuthError`.

## Retries

Failed requests are retried twice by default. Connection errors, timeouts, 408,
429 and 5xx are retried, unless the API marks the error `Retryable` false
(credits, bad parameters and blocked pages never are). The SDK waits the API's
`Retry-After` when it sent one, else backs off exponentially from 0.5s to 8s
with jitter. A `Retry-After` over 60s, such as the keyless hourly cap, is not
waited out: the error is returned at once so your code decides. Canceling
`ctx` stops a pending retry.

```go
retries := 4
client, err := keenable.New(&keenable.Options{
    MaxRetries: &retries, // nil means 2; a pointer to 0 turns retries off
    Headers:    map[string]string{"X-Team": "search"},
})

none := 0
resp, err := client.Search(ctx, "wafer scale engine", &keenable.SearchOptions{
    RequestOptions: keenable.RequestOptions{MaxRetries: &none},
})
page, err := client.Fetch(ctx, "https://example.com", &keenable.FetchOptions{
    RequestOptions: keenable.RequestOptions{
        Timeout: time.Minute,
        Headers: map[string]string{"X-Trace": "abc"},
    },
})
```

`RequestOptions` (embedded in `SearchOptions` and `FetchOptions`) overrides
the client's `Timeout`, `MaxRetries` and `Headers` for one call. `X-API-Key`
always comes from `APIKey`. `SearchResponse.RequestID` and `Page.RequestID`
carry the API's request id; quote it when reporting a problem.

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
