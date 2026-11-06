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
| `excludeDomains` | Never return results from these hosts or their subdomains; see below |
| `publishedAfter` / `publishedBefore` | Filter by publication date (`YYYY-MM-DD`) |
| `acquiredAfter` / `acquiredBefore` | Filter by when Keenable indexed the page |
| `snippetMaxLength` | Cap the page text returned per result |
| `maxResults` | How many results to return, 1 to 50 (default 10) |
| `queryTime` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `mode` | Search mode; `"pro"` (default) does deeper retrieval |
| `signal` | An `AbortSignal` to cancel the request |

### Excluding domains

`excludeDomains` drops results from the listed sites.

```ts
const results = await keenable.search(
  "how to repot a monstera without damaging the roots",
  { excludeDomains: ["pinterest.com", "quora.com"] },
);
```

Each entry is a host, such as `"pinterest.com"`. A host excludes itself and
every subdomain, so `"yahoo.com"` also drops `finance.yahoo.com`. Up to 1,000
distinct hosts. Hosts such as `github.io` and `blogspot.com` are accepted.

The API cleans up unambiguous input for you: surrounding whitespace, case, an
`http://` or `https://` scheme, a leading `www.`, a port, a trailing `/` and a
query string. So `"https://WWW.Pinterest.com/"` is read as `"pinterest.com"`.
Anything else is rejected with HTTP 400, thrown as `KeenableAPIError`:
a path (`"example.com/blog"`), a suffix or wildcard (`".com"`,
`"*.example.com"`), an IP address, a `user@host`, or an invalid host. The
`field`, `value` and `reason` properties name the rejected entry:

```ts
try {
  await keenable.search("q", { excludeDomains: ["example.com/blog"] });
} catch (err) {
  if (err instanceof KeenableAPIError) {
    console.log(err.field, err.value, err.reason);
    // exclude_domains example.com/blog paths are not supported; use the host example.com
  }
}
```

They are set only for that rejection (a 400 whose body has
`"error": "invalid_filter"`) and `undefined` on every other error.
`err.data` holds the whole decoded body.

If every match is excluded, the response can be empty. The SDK sends the list
as given and leaves validation to the API; `runToolCall` does the same with a
model's `exclude_domains` argument. `site` still works for a single domain,
and the `keenable_search` tool offers the model `site` and `exclude_domains`.

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
