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
| `includeDomains` | Only return results from these domains (allow-list); see below |
| `excludeDomains` | Never return results from these domains (block-list) |
| `publishedAfter` / `publishedBefore` | Filter by publication date (`YYYY-MM-DD`) |
| `acquiredAfter` / `acquiredBefore` | Filter by when Keenable indexed the page |
| `snippetMaxLength` | Cap the page text returned per result |
| `maxResults` | How many results to return, 1 to 50 (default 10) |
| `queryTime` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `mode` | Search mode; `"pro"` (default) does deeper retrieval |
| `signal` | An `AbortSignal` to cancel the request |

### Domain allow-lists and block-lists

`includeDomains` keeps only results from the listed sites; `excludeDomains`
drops results from them. Set both and a result must match the allow-list and
miss the block-list (exclude wins).

```ts
const results = await keenable.search(
  "Security Council resolution on the situation in Sudan",
  {
    includeDomains: ["press.un.org", "undocs.org", "documents.un.org"],
    excludeDomains: ["blogs.un.org"],
  },
);
```

Each entry is one of:

| Entry | Matches |
|---|---|
| `"un.org"` | the domain and all its subdomains |
| `"un.org/en/ga"` | that path prefix, on whole segments (`/en/ga/x`, not `/en/gax`) |
| `".gov"`, `"*.gov"`, `".gov.uk"` | every host under that suffix |

Matching ignores case, a leading `www.` and a trailing `/`. Up to 200 entries
across both lists. A narrow list can return fewer than `maxResults`; when
results had to be removed to honour it, the response says so in
`results.raw.warning`.

The lists are sent as given, including `[]`, and the API validates them. An
empty `includeDomains`, an entry with a scheme, port, query or IP address, the
same entry in both lists, or `includeDomains` together with `site` is rejected
with HTTP 400, thrown as `KeenableAPIError`. Its message names the field, the
entry and the reason:

```ts
try {
  await keenable.search("q", { includeDomains: ["https://un.org"] });
} catch (err) {
  if (err instanceof KeenableAPIError) {
    console.log(err.body); // Invalid include_domains value "https://un.org": scheme is not allowed
  }
}
```

The field, entry and reason are only in that message; the API sends no
separate keys for them. `err.data` holds the whole decoded body
(`{ error: "Bad request", message: "..." }`).

`site` still works for a single domain. The `keenable_search` tool offers the
model `site`, `include_domains` and `exclude_domains`.

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
| `KeenableAPIError` | Any other non-2xx response; carries `statusCode`, and `data` (the decoded JSON error body) when there is one |
| `KeenableConnectionError` | The API could not be reached |
| `KeenableInvalidRequestError` | Bad arguments; no request was sent |

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
