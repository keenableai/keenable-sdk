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
| `mode` | Search mode; `"pro"` (default) does deeper retrieval |
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

It emits `[n] Title (url)` headers followed by the page text, adds results whole
until the character budget is reached (`maxChars: 12000` by default), and never
truncates a source mid-sentence.

## Read a full page

```ts
const page = await keenable.fetch("https://cerebras.ai/chip");

console.log(page.title);
console.log(page.content); // markdown, boilerplate stripped
```

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
whichever the model picked and returns text ready for the `tool` message.

## Errors

All errors extend `KeenableError`:

| Error | When |
|---|---|
| `KeenableRateLimitError` | HTTP 429. Set `KEENABLE_API_KEY` to lift the keyless cap |
| `KeenableAuthError` | HTTP 401/403, the key was rejected |
| `KeenableAPIError` | Any other non-2xx response; carries `statusCode` |
| `KeenableConnectionError` | The API could not be reached |
| `KeenableInvalidRequestError` | Bad arguments; no request was sent |

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KEENABLE_API_KEY` | unset | Lifts the hourly rate limit. Create one at [keenable.ai/console](https://keenable.ai/console) |
| `KEENABLE_API_URL` | `https://api.keenable.ai` | Override the API base URL |

Both can also be passed to the constructor as `apiKey` and `baseUrl`, alongside
`timeoutMs` and a custom `fetch`.

## License

MIT
