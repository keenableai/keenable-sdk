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

Each entry is a host, such as `"un.org"`. A host covers itself and every
subdomain, so `"yahoo.com"` also matches `finance.yahoo.com`. Up to 50 distinct
hosts in `includeDomains` and 200 in `excludeDomains`.

The API cleans up an entry for you without ever widening the filter: it trims
whitespace, lowercases, and drops an `http://` or `https://` scheme, a port, a
trailing `/` (or a `?query` / `#fragment` with no path), a trailing dot, a
leading `www.` (kept when the rest would be a public suffix, so `www.github.io`
stays as is), and duplicates. Internationalised names become punycode. So
`"https://WWW.UN.org/"` is read as `"un.org"`. When it changed an entry, the
response says so in `results.raw.warning`. That field also says when
results had to be removed to honour the lists, which can leave fewer than
`maxResults`.

A host that is a public suffix only in the private section of the Public
Suffix List (`blogspot.com`, `github.io`, `s3.amazonaws.com`) is accepted;
ICANN suffixes and non-registrable names (`com`, `co.uk`, `localhost`) are
rejected.

The SDK sends the lists as given, including `[]`, and the API validates them.
It rejects with HTTP 400, thrown as `KeenableAPIError`: a path (`"un.org/press"`),
a suffix or wildcard (`".gov"`, `"*.gov"`, `"*"`), another scheme (`ftp://`,
`mailto:`), a `user@host`, an IP address, an empty entry, an invalid hostname,
a name that is not a registrable domain (`"localhost"`, `"co.uk"`), an empty
`includeDomains`, the same host in both lists, too many hosts, or
`includeDomains` together with `site`. Its message names the field, the entry
and how to fix it, and `field`, `value` and `reason` hold them as separate
properties:

```ts
try {
  await keenable.search("q", { includeDomains: ["un.org/press"] });
} catch (err) {
  if (err instanceof KeenableAPIError) {
    console.log(err.body); // Invalid include_domains value "un.org/press": paths are not supported; use the host un.org
    console.log(err.field, err.value, err.reason); // include_domains un.org/press paths are not supported; use the host un.org
  }
}
```

`field` / `value` / `reason` are set only for that rejection (a 400 whose
body has `error: "invalid_filter"`); they are `undefined` on every other
error. `err.data` holds the whole decoded body.

`runToolCall` sends a model's `include_domains: []` as `[]` too, so it comes
back as that 400 rather than running an unrestricted search. Only an absent or
`null` list is left unset.

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
