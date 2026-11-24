# keenable

Official Go SDK for [Keenable](https://keenable.ai), a web search API built for
AI agents: ranked results that come back with the page text already extracted,
plus a fetch endpoint that returns any URL as clean markdown.

**Keyless by default.** Every call works with no account and no key. An optional
`KEENABLE_API_KEY` only lifts the hourly rate limit.

```bash
go get github.com/keenableai/keenable-sdk/go@latest
```

Go 1.22 or newer. The module uses only the standard library.

`@latest` resolves to the newest `go/v*` git tag on
`github.com/keenableai/keenable-sdk` (the `go/` prefix is the directory, and it
is not part of the version you pass to `go get`). From a checkout of this repo, the same program is
`example/hello`:

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

Results carry the page text in `Snippet`. (`Description` is deprecated: the
API no longer fills it, so it is always nil. Build prompts from `Snippet`.)

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
| `ExcludeDomains` | Never return results from these hosts or their subdomains; see below |
| `PublishedAfter` / `PublishedBefore` | Filter by publication date (`YYYY-MM-DD`) |
| `AcquiredAfter` / `AcquiredBefore` | Filter by when Keenable indexed the page |
| `SnippetMaxLength` | Cap the page text returned per result. Nil means unset; a pointer to zero is sent |
| `MaxResults` | How many results to return, 1 to 50. Zero means the API default of 10 |
| `QueryTime` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `Objective` | What the search is for, in two or three sentences (up to 1,000 characters); logged by the API, no effect on results or price. Not sent when empty |
| `Mode` | Search mode: `"pro"` does deeper retrieval; `"realtime"` gives the fastest response, for latency-sensitive agent loops. Empty means `"pro"` |
| `DisableCards` | `true` returns ordinary web pages in place of Keenable's cards (results Keenable writes for prices, exchange rates or company facts, whose URLs expire after one day). False, the default, is not sent. In the next release after `v0.1.1` |
| `Moderation` | Filter unsafe results: `"moderate"` or `"strict"`. Empty, the default, is no moderation and is not sent. Works in `"pro"` and `"realtime"` modes, and not when the query is a URL (the API answers 400) |

### Excluding domains

`ExcludeDomains` drops results from the listed sites.

```go
results, err := client.Search(ctx, "how to repot a monstera without damaging the roots", &keenable.SearchOptions{
	ExcludeDomains: []string{"pinterest.com", "quora.com"},
})
```

Each entry is a host, such as `"pinterest.com"`. A host excludes itself and
every subdomain, so `"yahoo.com"` also drops `finance.yahoo.com`. Up to 1,000
distinct hosts. Hosts such as `github.io` and `blogspot.com` are accepted. A
nil slice is unset and not sent; a non-nil empty slice is sent as `[]`.

The API cleans up unambiguous input for you: surrounding whitespace, case, an
`http://` or `https://` scheme, a leading `www.`, a port, a trailing `/` or
dot, a query string or `#fragment`; international names become punycode. So
`"https://WWW.Pinterest.com/"` is read as `"pinterest.com"`. Anything else
comes back as an `*APIError` with `StatusCode` 400: a path
(`"example.com/blog"`), a suffix or wildcard (`".com"`, `"*.example.com"`), an
IP address, a `user@host`, or an invalid host. `Param`, `Value` and `Reason`
name the rejected entry, and `Fix` says what to change:

```go
var api *keenable.APIError
if errors.As(err, &api) {
	if api.Title == "invalid_filter" {
		fmt.Println(api.Param, api.Value, api.Reason)
		// exclude_domains example.com/blog paths are not supported; give only the host, such as example.com
	} else {
		fmt.Println(api.Body)
	}
}
```

`Value` and `Reason` are set only for that rejection (a 400 whose body has
`"error": "invalid_filter"`, so `Title` is `"invalid_filter"`) and empty on
every other error. `Value` is usually the entry as sent; a size cap reports the
list's size (`"2500 entries"` or `"more than 1000 distinct hosts"`) or an
over-long entry's first 64 characters followed by `"..."`.

If every match is excluded, the response can be empty. The SDK sends the list
as given and leaves validation to the API; `RunToolCall` does the same with a
model's `exclude_domains` argument. `Site` still works for a single domain,
and the `keenable_search` tool offers the model `site` and `exclude_domains`.

## Ground a model in one line

`ToContext` renders the result set as a numbered, citable block you can drop
straight into a prompt:

```go
contextText := results.ToContext(nil)
prompt := "Answer using only these sources, citing them by number.\n\n" + contextText
```

It emits `[1] Title (url)` headers followed by the page text. Each result's
text is cleaned (images dropped, relative links resolved, markdown tables
flattened to `cell · cell;` rows) and cut at a word boundary to
`MaxSnippetChars` (0 means the default of 2000, and a negative value disables
the cap), ending in "…".
Results are then added whole until the character budget is reached (`MaxChars`
12000 by default). The first result is kept even when it alone is over the
budget. A later result that does not fit ends the block, so
citation numbers stay contiguous.

To print a source list that matches the citations in the answer, ask which
results were actually rendered rather than listing them all:

```go
for i, result := range results.Cited(nil) {
	fmt.Printf("[%d] %s - %s\n", i+1, result.Title, result.URL)
}
```

## Read full pages

```go
live := 0.0
resp, err := client.FetchWithOptions(context.Background(),
	[]string{"https://cerebras.ai/chip", "https://cerebras.ai/blog"},
	&keenable.FetchOptions{MaxChars: 5000, MaxAgeHours: &live})
if err != nil {
	log.Fatal(err)
}
for _, page := range resp.Results {
	if page.Error != nil {
		fmt.Println(page.URL, page.Error.Code)
		continue
	}
	fmt.Println(page.Title)
	fmt.Println(page.Content)        // markdown, boilerplate stripped
	fmt.Println(page.ToContext(nil)) // same citable block shape as search results
}
```

`Fetch` sends one `POST /v1/fetch`. `Results[i]` is for `urls[i]`; a URL that
failed has `Error` set instead of returning an error. The `FetchOptions`
fields are sent only when set (the API checks their values):

| Field | What it does |
|---|---|
| `MaxChars` | The most characters of content per page. Zero means the API default of 50000 |
| `Prompt` | Up to 2,000 characters; each page's `Content` is then only an LLM's answer to it |
| `Schema` | A JSON Schema; each page's answer is in `page.Structured` |
| `Links` | The most links per page to return, in `page.Links` |
| `Images` | The most images per page to return, in `page.Images` |
| `MaxAgeHours` | Use a stored copy only if younger than this; `0` reads every page live |

Internal hosts and private addresses are refused before a request is sent:
`localhost` and names under `.localhost`, `metadata.google.internal`, and IP
addresses in private, loopback, link-local, carrier-grade NAT, documentation,
benchmarking, multicast and reserved ranges, however the address is spelled.
The rules are the same in every SDK (`scripts/conformance/README.md`).

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

The model may set `site`, `exclude_domains`, `published_after`, `objective`,
`disable_cards` and `moderation` on search. The other filters stay on
`Search` for you to set yourself.

On fetch the model sets `urls` (1 to 20) and may set `max_chars` (per page),
`prompt` (applied to every page) and `max_age_hours` (0 reads every page
live), as on the hosted MCP tool. A call without `urls` is an invalid
request. Each page comes back as its own numbered block. A URL
that failed while others were read becomes a `[n] <url> - failed: <reason>`
block; `RunToolCall` returns its error only when no URL could be read.

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

## Monitors

A search monitor is a standing search: it watches the web for a topic and
hands over every new result that matches, by webhook, in scheduled runs, or when
you poll it. A page monitor (`Type: "page"`) reads one page on a schedule and
reports the changes worth telling. Monitors need an API key
(`KEENABLE_API_KEY`); without one, every call returns an `*AuthError` with
`APICode == "missing_api_key"` and sends nothing. An organization can have 100 active monitors.

```go
ctx := context.Background()
monitor, err := client.Monitors.Create(ctx, &keenable.MonitorCreateParams{
	Search:   keenable.MonitorSearchParams{Query: "new open-weights LLM releases", MaxResults: 20},
	Schedule: &keenable.MonitorScheduleParams{Type: "cron", Value: "0 9 * * 1-5", Timezone: "Europe/Paris"},
	Webhook:  &keenable.MonitorWebhookParams{URL: "https://example.com/keenable"},
	Metadata: map[string]string{"team": "research"},
})
if err != nil {
	log.Fatal(err)
}
secret := *monitor.Webhook.Secret // whsec_..., returned by Create only

results, err := client.Monitors.Results(ctx, monitor.ID, &keenable.MonitorResultsParams{MinImportance: 4})
if err != nil {
	log.Fatal(err)
}
for _, result := range results.Data {
	fmt.Println(result.URL)
}
```

A page monitor watches one page, here a pricing page every 6 hours:

```go
pricing, err := client.Monitors.Create(ctx, &keenable.MonitorCreateParams{
	Type: "page",
	Page: &keenable.MonitorPageTarget{
		URL:         "https://example.com/pricing",
		WatchFor:    "plan prices and new plans",
		Sensitivity: "meaningful", // or "any": every change that is not cosmetic
	},
	Schedule: &keenable.MonitorScheduleParams{Type: "interval", Value: "6h"},
})
if err != nil {
	log.Fatal(err)
}
versions, err := client.Monitors.Versions(ctx, pricing.ID, &keenable.MonitorVersionsParams{Limit: 10})
if err != nil {
	log.Fatal(err)
}
for _, v := range versions.Data {
	if v.Diff != nil {
		fmt.Println(v.Version, v.Diff.Added)
	}
}
```

Schedules: `cron` (runs at least 10 minutes apart, in `Timezone`), `interval`
(`"10m"` to `"90d"`) or `once`. Without one, a search monitor runs only on
`Trigger` and a page monitor every hour. The API checks the schedule and the
`OutputSchema`: one that breaks a rule returns an `*APIError` with status 400,
`APICode == "invalid_request"` and a message that names the rule.

| Method | What it does |
|---|---|
| `Create(ctx, *MonitorCreateParams)` | Make a search monitor (`Search`) or a page monitor (`Type: "page"`, `Page`) (`POST /v1/monitors`) |
| `List(ctx, *MonitorListParams)` / `ListAll(ctx, *MonitorListParams)` | One page of monitors / a `*MonitorIterator` over all of them |
| `Get(ctx, id, *RequestOptions)`, `Update(ctx, id, *MonitorUpdateParams)`, `Delete(ctx, id, *RequestOptions)` | Read, change (only what is set; `Search`, `Page` and `Webhook` are merged; `RemoveName`, `RemoveSchedule`, `RemoveWebhook`, `RemovePageWatchFor`, ... send null and win over the value), delete |
| `Pause(ctx, id, *RequestOptions)`, `Resume(ctx, id, *RequestOptions)` | Update with Status "paused" / "active" |
| `Trigger(ctx, id, *RequestOptions)` | Start a run now; returns the queued `*MonitorRun` |
| `Runs(ctx, id, *MonitorPageParams)`, `Run(ctx, id, runID, *RequestOptions)` | A monitor's runs |
| `Results(ctx, id, *MonitorResultsParams)` | The results a search monitor accepted, newest first, one per story (`GET /v1/monitors/{id}/results`) |
| `Versions(ctx, id, *MonitorVersionsParams)` | A page monitor's history, newest first: each version whose text changed, with its `Diff` |
| `Deliveries(ctx, id, *MonitorPageParams)` | Webhook events of the last 7 days, with attempts and errors |
| `Stats(ctx, *RequestOptions)` | Counts by status and by kind of schedule |
| `Bulk(ctx, action, *MonitorBulkParams)` | Pause, resume or delete many; a dry run unless `DryRun` points to false |

Every params struct embeds `RequestOptions`. Reads and deletes are retried like
a search; `Create` sends an `Idempotency-Key` (yours, or a new one per call), so
its retries cannot make a second monitor; `Update`, `Trigger` and `Bulk` are
retried only on a 429.

A `Monitor` has `Type` ("search" or "page"), `Search` (nil for a page monitor),
`Page` (nil for a search monitor), `DisabledReason` (`Code` `runs_failed`,
`webhook_unreachable` or `data_policy` (a page monitor whose organization turned on zero data retention), while it is disabled).
A completed `MonitorRun` has, for a page monitor, `Changes` (`Changed`,
`Notified`, `Baseline`, `Version`, `Source`, `Summary`, `Items`, `Diff`). With
an output schema, `Output` has `Structured`, `Fresh` and `Error`.

### Verify webhooks

Deliveries are signed as [Standard Webhooks](https://www.standardwebhooks.com).
Verify the raw body before trusting it:

```go
func hook(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	event, err := keenable.VerifyWebhook(body, r.Header, secret, nil)
	if err != nil {
		http.Error(w, "bad signature", http.StatusBadRequest)
		return
	}
	switch event.Type {
	case "monitor.result.found":
		if event.Data.Result != nil {
			fmt.Println(event.Data.Result.URL)
		}
	case "monitor.page.changed": // a page monitor's change worth telling
		if run := event.Data.Run; run != nil && run.Changes != nil && run.Changes.Summary != nil {
			fmt.Println(*run.Changes.Summary)
		}
	}
}
```

`VerifyWebhook` checks the HMAC-SHA256 signature in constant time and refuses
a timestamp more than 5 minutes from now (`WebhookOptions.Tolerance` changes
it). It returns a `*WebhookVerificationError`. Drop repeats by `event.ID`,
which stays the same across retries.

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
| `InsufficientCreditsError` (alias `CreditsError`) | `api_error` | HTTP 402, no credits left, or a pay-per-request (x402) payment this SDK cannot make; retrying will not help. The message starts "Keenable: insufficient credits (402)" or "Keenable: payment required (402)" |
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
    log.Println(api.APICode, api.Fix, api.RequestID)
}
```

| Field | Meaning |
|---|---|
| `APICode` | Stable reason, e.g. `rate_limit_per_second`, `insufficient_credits`, `target_blocked` |
| `Type` | The category, one of the `Type*` constants: `invalid_request_error`, `authentication_error`, `permission_error`, `billing_error`, `rate_limit_error`, `target_error` (the page being fetched failed, not Keenable) or `api_error`; derived from the status when an older API leaves it out |
| `Title` | The API's short error title (its `error` field) |
| `Fix` | One sentence on what to do next |
| `Retryable` | Whether the same request can succeed later |
| `RetryAfter` | How long to wait (body `retry_after_seconds`, else the `Retry-After` header) |
| `RequestID` | Quote it when reporting a problem |
| `Param` | The parameter a 400 is about |
| `Value`, `Reason` | What a 400 `invalid_filter` rejected (usually the entry; for a size cap the count or a truncated entry), and why |
| `RateLimit` | On a 429: `Scope`, `Window`, `Max`, `ResetsAt`, and `Endpoint`: which endpoint limit was hit (`search` or `fetch`) when the organization has separate limits; empty for the shared limit |
| `Body` | The API's error message (its `message`, `error` or `detail` string), or the text of a body that is not JSON |

When the API sends `Fix`, the error message ends with it in place of the
SDK's generic advice (for every status, as in the Python and TypeScript SDKs),
so a non-retryable error never tells an agent to retry. It then ends with
`(code: <APICode>)` and `(request_id: <RequestID>)` before the SDK code, as in
the Python and TypeScript SDKs. The API's docs link, a 402's billing and
top-up links and a pay-per-request (x402) offer are not exposed. A 402's
message is the SDK's own: "Keenable: payment required (402)" when the API asks
for a per-request payment, which this SDK cannot make (use an API key), else
"Keenable: insufficient credits (402)". A 403 with type `target_error` (e.g. code
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
minute := time.Minute
resp, err := client.FetchWithOptions(ctx, []string{"https://example.com"}, &keenable.FetchOptions{
    RequestOptions: keenable.RequestOptions{
        Timeout: &minute, // nil keeps the client's
        Headers: map[string]string{"X-Trace": "abc"},
    },
})
```

`RequestOptions` (embedded in `SearchOptions` and in `FetchOptions`, which
`FetchWithOptions` takes) overrides
the client's `Timeout`, `MaxRetries` and `Headers` for one call. `Timeout` is a
pointer: nil keeps the client's, and zero or less is an `InvalidRequestError`.
A header whose name is not an HTTP token, or whose value has a CR, LF or NUL, is
an `InvalidRequestError` too, before anything is sent. `X-API-Key`
always comes from `APIKey`. `SearchResponse.RequestID` and `FetchResponse.RequestID`
carry the API's request id; quote it when reporting a problem.
`SearchResponse.Warnings` lists what the request should change, such as a
deprecated parameter it used; it is nil otherwise.

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
It cannot include a query string, a fragment, a user name or password, or a
backslash before its path. `Timeout` of zero means 30
seconds when this SDK creates the HTTP client. When you pass `HTTPClient`,
zero adds no extra deadline and that client's `Timeout` is left unchanged.
`ClientSource` is sent as
`X-Keenable-Title`; empty means "Keenable SDK". Set it when you wrap this SDK
and want your own traffic attribution.

## License

MIT
