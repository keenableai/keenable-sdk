# keenable

Official TypeScript SDK for [Keenable](https://keenable.ai), a web search API
built for AI agents: ranked results that come back with the page text already
extracted, plus a fetch endpoint that returns any URL as clean markdown.

**Keyless by default.** Every call works with no account and no key. An optional
`KEENABLE_API_KEY` only lifts the hourly rate limit.

```bash
npm install keenable
```

Node 18 or newer (the SDK uses the built-in `fetch`). No runtime dependencies.

## Search

```ts
import { Keenable } from "keenable";

const keenable = new Keenable(); // or new Keenable({ apiKey: "keen_..." })

const results = await keenable.search(
  "how wafer scale chips avoid the memory bottleneck",
);

for (const result of results) {
  console.log(result.title, result.url);
  console.log(result.snippet);
}
```

Results carry the page text in `snippet`. (`description` is the page's meta
description and is absent for most pages, so build prompts from `snippet`.)

Filters are optional and combine freely:

```ts
const results = await keenable.search("post-training quantization results", {
  site: "arxiv.org",
  publishedAfter: "2026-01-01",
  snippetMaxLength: 500,
});
```

| Option | What it does |
|---|---|
| `site` | Restrict to one domain, e.g. `"arxiv.org"` |
| `publishedAfter` / `publishedBefore` | Filter by publication date (`YYYY-MM-DD`) |
| `acquiredAfter` / `acquiredBefore` | Filter by when Keenable indexed the page |
| `snippetMaxLength` | Cap the page text returned per result |
| `maxResults` | How many results to return, 1 to 50 (default 10) |
| `queryTime` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `mode` | Search mode: `"pro"` (default) does deeper retrieval; `"realtime"` gives the fastest response, for latency-sensitive agent loops |
| `signal` | An `AbortSignal` to cancel the request |

## Ground a model in one line

`toContext()` renders the result set as a numbered, citable block you can drop
straight into a prompt:

```ts
const results = await keenable.search("cerebras inference benchmarks");
const prompt = `Answer using only these sources, citing them by number.

${results.toContext()}

Question: ...`;
```

It emits `[n] Title (url)` headers followed by the page text. Each result's
text is cleaned (images dropped, relative links resolved, markdown tables
flattened to `cell · cell;` rows) and cut at a word boundary to
`maxSnippetChars` (2000 by default, `null` for no cap; a value below 1 also
disables the cap), ending in "…". Results are then added whole until the character budget is reached (`maxChars: 12000`
by default), so a later source is dropped rather than cut off. The first result
is kept even when it alone is over the budget.

To print a source list that matches the citations in the answer, ask which
results were actually rendered rather than listing them all:

```ts
const results = await keenable.search("cerebras inference benchmarks");

results.cited().forEach((result, index) => {
  console.log(`[${index + 1}] ${result.title} - ${result.url}`);
});
```

## Read a full page

```ts
const page = await keenable.fetch("https://cerebras.ai/chip");

console.log(page.title);
console.log(page.content); // markdown, boilerplate stripped
console.log(page.toContext()); // same citable block shape as search results
```

`fetch()` takes three options (`FetchOptions`), next to the per-request ones. They ship in the next release after 0.1.4, so the version on npm doesn't have them yet:

```ts
const capped = await keenable.fetch("https://cerebras.ai/chip", { maxChars: 5000, live: true });
const answer = await keenable.fetch("https://cerebras.ai/chip", { prompt: "List the chip's specs" });
```

| Option | What it does |
|---|---|
| `maxChars` | Cap the characters of content returned, a positive integer. The API default is 50000; `page.truncated` and `page.totalChars` say whether the page was cut |
| `live` | `true` fetches the page from its source now instead of reading Keenable's indexed copy. Default `false` |
| `prompt` | An extraction instruction, up to 2000 characters. `page.content` is then only the model's output for it, not the page |

## Tool calling

The SDK ships OpenAI-compatible tool definitions, so any inference API that
speaks that schema can call Keenable directly:

```ts
import { Keenable, TOOLS, runToolCall } from "keenable";

const keenable = new Keenable();
const completion = await client.chat.completions.create({ model, messages, tools: TOOLS });

for (const call of completion.choices[0].message.tool_calls ?? []) {
  messages.push({
    role: "tool",
    tool_call_id: call.id,
    content: await runToolCall(keenable, call.function.name, call.function.arguments),
  });
}
```

`TOOLS` exposes `keenable_search` and `keenable_fetch`; `runToolCall` executes
whichever the model picked and returns text ready for the `tool` message. Both
tools render the same numbered, citable block, so the model can cite a fetched
page the way it cites a search result.

## Errors

All errors extend `KeenableError`:

| Error | When |
|---|---|
| `KeenableRateLimitError` | HTTP 429. Set `KEENABLE_API_KEY` to lift the keyless cap |
| `KeenableAuthError` | HTTP 401/403, the key was rejected |
| `KeenableInsufficientCreditsError` (alias `KeenableCreditsError`) | HTTP 402, no credits left; retrying will not help |
| `KeenableAPIError` | Any other non-2xx response; carries `statusCode` |
| `KeenableConnectionError` | The API could not be reached |
| `KeenableTimeoutError` | A `KeenableConnectionError`: the API did not answer within `timeoutMs` |
| `KeenableInvalidRequestError` | Bad arguments; no request was sent |

## Handling errors

The SDK already retries what can be retried (see
[Retries and timeouts](#retries-and-timeouts)), so an error that reaches you is
final for this call. Every `KeenableAPIError` carries what the API says about
the failure. Branch on `code`, not on the message. Each field is `undefined`
when the API did not send it.

```ts
import { Keenable, KeenableAPIError, KeenableRateLimitError } from "keenable";

const keenable = new Keenable();
try {
  const results = await keenable.search("wafer scale engine");
} catch (err) {
  if (err instanceof KeenableRateLimitError) {
    // Only reaches you when the wait is over a minute (e.g. the keyless
    // hourly cap) or the retries ran out.
    console.log(`rate limited, retry in ${err.retryAfterSeconds}s:`, err.fix);
  } else if (err instanceof KeenableAPIError) {
    console.log(err.code, err.fix, err.requestId);
  } else {
    throw err;
  }
}
```

| Field | Meaning |
|---|---|
| `code` | Stable reason, e.g. `rate_limit_per_second`, `insufficient_credits`, `target_blocked` |
| `type` | The category (`KeenableErrorType`): `invalid_request_error`, `authentication_error`, `permission_error`, `billing_error`, `rate_limit_error`, `target_error` (the page being fetched failed, not Keenable) or `api_error`; derived from the status when an older API leaves it out |
| `fix` | One sentence on what to do next |
| `retryable` | Whether the same request can succeed later |
| `retryAfterSeconds` | Seconds to wait (body, else the `Retry-After` header) |
| `requestId` | Quote it when reporting a problem |
| `param` | The parameter a 400 is about |
| `limit` | On a 429: `{ scope, window, max, resetsAt }` |

When the API sends `fix`, the error message ends with it, then with
`(code: <code>)` and `(request_id: <id>)`, as in the Go and Python SDKs. A 402
is a `KeenableInsufficientCreditsError` whose message is the SDK's own: the
SDK does not expose billing or checkout links, and it cannot pay an x402
payment offer, so set `KEENABLE_API_KEY` instead. A 403
with type `target_error` (e.g. code `target_blocked`, the fetched site refused
us) is a plain `KeenableAPIError`, not a `KeenableAuthError`.

## Retries and timeouts

Failed requests are retried twice by default. Connection errors, timeouts, 408,
429 and 5xx are retried, unless the API marks the error `retryable: false`
(credits, bad parameters and blocked pages never are). The SDK waits the API's
`Retry-After` when it sent one, else backs off exponentially from 0.5 s to 8 s
with jitter. A `Retry-After` over 60 s, such as the keyless hourly cap, is not
waited out: the error is thrown at once so your code decides.

`timeoutMs` (default 30000) is the deadline for each attempt. A timed-out
request throws `KeenableTimeoutError`, a subclass of `KeenableConnectionError`.
Aborting your `signal` also cancels a pending retry.

```ts
const keenable = new Keenable({
  maxRetries: 4,
  timeoutMs: 10_000,
  defaultHeaders: { "X-Team": "search" },
});
await keenable.search("wafer scale engine", { maxRetries: 0 }); // no retries for this call
await keenable.fetch("https://example.com", { timeoutMs: 60_000, headers: { "X-Trace": "abc" } });
```

Every call takes `signal`, `timeoutMs`, `maxRetries` and `headers`, which
override the client's settings for that call. Results carry `requestId` (quote
it when reporting a problem). Redirects are never followed, so the API key
cannot leak to another host.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KEENABLE_API_KEY` | unset | Lifts the hourly rate limit. Create one at [keenable.ai/console](https://keenable.ai/console) |
| `KEENABLE_API_URL` | `https://api.keenable.ai` | Override the API base URL |

Both can also be passed to the constructor as `apiKey` and `baseUrl`, alongside
`timeoutMs`, `maxRetries`, `defaultHeaders`, a custom `fetch` (e.g. for a
proxy), and `clientSource`. Building an integration on
top of this SDK? Set `clientSource: "Your Integration"` so your traffic is
attributed to you rather than to the bare SDK.

## License

MIT
