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
| `mode` | `"pro"` (default) does deeper retrieval; `"realtime"` is the fastest |
| `signal` | An `AbortSignal` to cancel the request |

Advanced, for agent frameworks: `sessionId` groups the calls of one agent
session (send the same value on each call), and `enableWizards: true` turns on
experimental structured-data extraction (`"pro"` mode only).

## Ground a model in one line

`toContext()` renders the result set as a numbered, citable block you can drop
straight into a prompt:

```ts
const results = await keenable.search("cerebras inference benchmarks");
const prompt = `Answer using only these sources, citing them by number.

${results.toContext()}

Question: ...`;
```

It emits `[n] Title (url)` headers followed by the page text, adds results whole
until the character budget is reached (`maxChars: 12000` by default), and never
truncates a source mid-sentence.

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

| Option | What it does |
|---|---|
| `maxChars` | Cap the content (API default 50,000). A cut page ends with a note saying so |
| `live` | Fetch from the source when the page is not in the index yet |
| `prompt` | Return the answer to this instruction, extracted from the page, instead of the full page |
| `sessionId` | Same as on `search()` |
| `signal` | An `AbortSignal` to cancel the request |

## Going further

More results, faster, and only recent pages:

```ts
const results = await keenable.search("open-weight model releases", {
  mode: "realtime", // fastest mode, for latency-sensitive calls
  maxResults: 25, // up to 50; the default is 10
  publishedAfter: "2026-10-01", // recency filter
});
```

Read just the part of a page you need, from the source if it is not indexed
yet:

```ts
const page = await keenable.fetch("https://example.com/", {
  live: true,
  prompt: "What is this domain for? One sentence.",
});
console.log(page.content);
```

`queryTime` is the opposite of a recency filter: it searches the index as it
stood at that moment and excludes everything newer, which is useful for
reproducing past results.

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

All errors extend `KeenableError`. Every API error message ends with the
next step to take (also on `.hint`). When the API sent a request id, the
message includes it just before that step (also on `.requestId`); quote it to
support.

| Exception | When | What to do |
|---|---|---|
| `KeenableValidationError` | HTTP 400/422: the API rejected the request | Fix what the message names; retrying unchanged fails |
| `KeenableAuthError` | HTTP 401: the API key is missing or invalid | Check `KEENABLE_API_KEY` |
| `KeenableForbiddenError` | HTTP 403: not allowed for this key or tier (extends `KeenableAuthError`) | Set a key, or use a plan that includes the feature |
| `KeenableCreditsError` | HTTP 402: out of credits | Add credits at [keenable.ai/console](https://keenable.ai/console) |
| `KeenableRateLimitError` | HTTP 429; carries `limit`, `remaining`, `reset` | Retry after `reset`, or set `KEENABLE_API_KEY` to lift the keyless cap |
| `KeenableAPIError` | Any other non-2xx; base class of the above | Follow the hint: a 5xx is safe to retry, a 404 means the URL doesn't exist |
| `KeenableConnectionError` | The API could not be reached or timed out | Retry; check network and `KEENABLE_API_URL` |
| `KeenableInvalidRequestError` | The SDK rejected the arguments; no request was sent | Fix the call |

Every `KeenableAPIError` carries `statusCode`, `body` (the API's message),
`apiError` (the API's short label), `details`, `requestId` and `hint`.
Successful responses carry `requestId` too.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KEENABLE_API_KEY` | unset | Lifts the hourly rate limit. Create one at [keenable.ai/console](https://keenable.ai/console) |
| `KEENABLE_API_URL` | `https://api.keenable.ai` | Override the API base URL |

Both can also be passed to the constructor as `apiKey` and `baseUrl`, alongside
`timeoutMs`, a custom `fetch`, and `clientSource`. Building an integration on
top of this SDK? Set `clientSource: "Your Integration"` so your traffic is
attributed to you rather than to the bare SDK.

## License

MIT
