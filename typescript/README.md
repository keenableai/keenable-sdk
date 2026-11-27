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

Results carry the page text in `snippet`. (`description` is deprecated: the
API no longer fills it, so it is always `undefined`. Build prompts from
`snippet`.)

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
| `objective` | What the search is for, in two or three sentences (up to 1,000 characters); the ranker scores results for it together with the query (retrieval reads only the query), same price. Not sent when empty |
| `mode` | Search mode: `"pro"` (default) does deeper retrieval; `"realtime"` gives the fastest response, for latency-sensitive agent loops |
| `disableCards` | `true` returns ordinary web pages in place of Keenable's cards (results Keenable writes for prices, exchange rates or company facts, whose URLs expire after one day). Default `false`, which is not sent; a non-boolean throws `KeenableInvalidRequestError`. In the next release after 0.1.4 |
| `moderation` | Filter unsafe results: `"moderate"` or `"strict"`. Unset, the default, is no moderation and is not sent. Works in `"pro"` and `"realtime"` modes, and not when the query is a URL (the API answers 400) |
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
`http://` or `https://` scheme, a leading `www.`, a port, a trailing `/` or
dot, a query string or `#fragment`; international names become punycode. So
`"https://WWW.Pinterest.com/"` is read as `"pinterest.com"`. Anything else is
rejected with HTTP 400, thrown as `KeenableAPIError`: a path
(`"example.com/blog"`), a suffix or wildcard (`".com"`, `"*.example.com"`), an
IP address, a `user@host`, or an invalid host. The `param`, `value` and
`reason` properties name the rejected entry, and `fix` says what to change:

```ts
try {
  await keenable.search("q", { excludeDomains: ["example.com/blog"] });
} catch (err) {
  if (err instanceof KeenableAPIError && err.error === "invalid_filter") {
    console.log(err.param, err.value, err.reason);
    // exclude_domains example.com/blog paths are not supported; give only the host, such as example.com
  } else if (err instanceof KeenableAPIError) {
    console.log(err.body);
  } else {
    throw err;
  }
}
```

`value` and `reason` are set only for that rejection (a 400 whose body has
`"error": "invalid_filter"`) and `undefined` on every other error. `value` is
usually the entry as sent; a size cap reports the list's size (`"2500 entries"`
or `"more than 1000 distinct hosts"`) or an over-long entry's first 64
characters followed by `"..."`.

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

## Read full pages

```ts
const response = await keenable.fetch(["https://cerebras.ai/chip", "https://cerebras.ai/blog"]);

for (const page of response.results) {
  if (page.error) {
    console.log(page.url, page.error.code);
    continue;
  }
  console.log(page.title);
  console.log(page.content); // markdown, boilerplate stripped
  console.log(page.toContext()); // same citable block shape as search results
}
```

`fetch()` sends one `POST /v1/fetch`. `results[i]` is for `urls[i]`; a URL
that failed has `error` set instead of throwing. `FetchOptions`, next to the
per-request ones, are sent only when set (the API checks their values):

| Option | What it does |
|---|---|
| `maxChars` | The most characters of content per page. The API default is 50000 |
| `prompt` | Up to 2,000 characters; each page's `content` is then only an LLM's answer to it |
| `schema` | A JSON Schema; each page's answer is in `page.structured` |
| `links` | The most links per page to return, in `page.links` |
| `images` | The most images per page to return, in `page.images` |
| `maxAgeHours` | Use a stored copy only if younger than this many hours; `0` reads every page live; `-1` reads only the stored copy, never the live page (no stored copy: a 404 error entry) |

## Billing

```ts
const billing = await keenable.billing();
for (const price of billing.prices) {
  console.log(price.sku, price.unitPrice.amount, price.unitPrice.currency);
}
if (billing.account) {
  // null without an API key
  console.log("available:", billing.account.balance.available.amount);
}
```

`billing()` reads `GET /v1/billing`: read-only and free, with or without a key.
Without one, `prices` are the public list prices and `account` is `null`. With
one, `prices` are your organization's (with `listUnitPrice` and `source`,
`"list"` or `"contract"`), and `account` holds the available balance and
`billingUrl`, the console page for adding funds. Amounts are numbers in US
dollars (`Money.amount`, such as `0.004`, up to nine decimal places, negative
for an account in debt). `Money.amountDecimal` (the API's `amount_decimal`) is
the same amount as an exact decimal string (`"0.004"`); add amounts with it,
not with the float, when they must match a bill: with a decimal library, or as
BigInt nano-dollars:

```ts
const nanos = (d: string) => {
  const [whole, fraction = ""] = d.replace("-", "").split(".");
  const n = BigInt(whole! + fraction.padEnd(9, "0"));
  return d.startsWith("-") ? -n : n;
};
const total = billing.prices.reduce((sum, p) => sum + nanos(p.unitPrice.amountDecimal), 0n);
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

The model may set `site`, `exclude_domains`, `published_after`, `objective`,
`disable_cards` and `moderation` on search. The other filters stay on
`search()` for you to set yourself.

On fetch the model sets `urls` (1 to 20) and may set `max_chars` (per page),
`prompt` (applied to every page) and `max_age_hours` (0 reads every page
live, -1 only the stored copy), as on the hosted MCP tool. A call without
`urls` is an invalid request. Each page comes back as its own numbered block. A URL
that failed while others were read becomes a `[n] <url> - failed: <reason>`
block; `runToolCall` throws its error only when no URL could be read.

## Monitors

A search monitor is a standing search: it watches the web for a topic and
hands over every new result that matches, by webhook, in scheduled runs, or when
you poll it. A page monitor (`type: "page"`) reads one page on a schedule and
reports the changes worth telling. Monitors need an API key
(`KEENABLE_API_KEY`); without one, every call throws `KeenableAuthError` with
`code === "missing_api_key"` and sends nothing. An organization can have 100 active monitors.

```ts
import { Keenable } from "keenable";

const keenable = new Keenable();
const monitor = await keenable.monitors.create({
  search: { query: "new open-weights LLM releases", maxResults: 20 },
  schedule: { type: "cron", value: "0 9 * * 1-5", timezone: "Europe/Paris" },
  webhook: { url: "https://example.com/keenable" },
  metadata: { team: "research" },
});
const secret = monitor.webhook?.secret; // whsec_..., returned by create() only

const results = await keenable.monitors.results(monitor.id, { minImportance: 4 });
for (const result of results.data) console.log(result.importance, result.title, result.url);
```

A page monitor watches one page, here a pricing page every 6 hours:

```ts
const pricing = await keenable.monitors.create({
  type: "page",
  page: {
    url: "https://example.com/pricing",
    watchFor: "plan prices and new plans",
    sensitivity: "meaningful", // or "any": every change that is not cosmetic
  },
  schedule: { type: "interval", value: "6h" },
});
const runs = await keenable.monitors.runs(pricing.id);
for (const run of runs.data) {
  if (run.changes?.notified) console.log(run.changes.summary, run.changes.items);
}
const versions = await keenable.monitors.versions(pricing.id, { limit: 10 });
for (const version of versions.data) console.log(version.version, version.fetchedAt, version.diff?.added);
```

Schedules: `cron` (runs at least 10 minutes apart, in `timezone`), `interval`
(`"10m"` to `"90d"`) or `once`. Without one, a search monitor runs only on
`trigger()` and a page monitor every hour. The API checks the schedule and the
`outputSchema`: one that breaks a rule throws `KeenableAPIError` with status
400, `code === "invalid_request"` and a message that names the rule.

| Method | What it does |
|---|---|
| `create({ type, search, page, name, schedule, outputSchema, webhook, metadata, idempotencyKey })` | Make a search monitor (`search`) or a page monitor (`type: "page"`, `page`) (`POST /v1/monitors`) |
| `list({ status, name, metadata, limit, cursor })` / `listAll(...)` | One page of monitors / an async iterator over all of them |
| `get(id)`, `update(id, fields)`, `delete(id)` | Read, change (only the fields set; `search`, `page` and `webhook` are merged; `null` removes the schedule, webhook or output schema), delete |
| `pause(id)`, `resume(id)` | `update(id, { status: "paused" / "active" })` |
| `trigger(id)` | Start a run now; returns the queued `MonitorRun` |
| `runs(id, { limit, cursor })`, `run(id, runId)` | A monitor's runs |
| `results(id, { limit, cursor, minImportance })` | The results a search monitor accepted, newest first, one per story (`GET /v1/monitors/{id}/results`) |
| `versions(id, { limit, cursor })` | A page monitor's history, newest first: each version whose text changed, with its `diff` |
| `deliveries(id, { limit, cursor })` | Webhook events of the last 7 days, with attempts and errors |
| `stats()` | Counts by status and by kind of schedule |
| `bulk(action, { ids, filter, limit, dryRun })` | Pause, resume or delete many; a dry run unless `dryRun: false` |

Every call also takes `signal`, `timeoutMs`, `maxRetries` and `headers`. Reads
and deletes are retried like a search; `create()` sends an `Idempotency-Key`
(yours, or a new one per call), so its retries cannot make a second monitor;
`update()`, `trigger()` and `bulk()` are retried only on a 429.

A `Monitor` has `type` (`"search"` or `"page"`), `search` (null for a page
monitor), `page` (null for a search monitor), `disabledReason` (`code`
`runs_failed`, `webhook_unreachable` or `data_policy` (a page monitor whose organization turned on zero data retention), while it is
disabled). A completed `MonitorRun`
has, for a page monitor, `changes`
(`changed`, `notified`, `baseline`, `version`, `source`, `summary`, `items`,
`diff`). With an output schema, `output` has `structured`, `fresh` and `error`.

### Verify webhooks

Deliveries are signed as [Standard Webhooks](https://www.standardwebhooks.com).
Verify the raw body before trusting it:

```ts
import { verifyWebhook, WebhookVerificationError } from "keenable";

try {
  const event = await verifyWebhook(rawBody, request.headers, secret);
  if (event.type === "monitor.result.found") console.log(event.data.result?.url);
  if (event.type === "monitor.page.changed") console.log(event.data.run?.changes?.summary);
} catch (error) {
  if (error instanceof WebhookVerificationError) return new Response(null, { status: 400 });
  throw error;
}
```

`verifyWebhook` is async (it uses Web Crypto), checks the HMAC-SHA256
signature in constant time and refuses a timestamp more than 5 minutes from
now (`{ toleranceSeconds }` changes it). Drop repeats by `event.id`, which stays
the same across retries.

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
| `value`, `reason` | What a 400 `invalid_filter` rejected (usually the entry; for a size cap the count or a truncated entry), and why |
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
await keenable.fetch(["https://example.com"], { timeoutMs: 60_000, headers: { "X-Trace": "abc" } });
```

Every call takes `signal`, `timeoutMs`, `maxRetries` and `headers`, which
override the client's settings for that call. Results carry `requestId` (quote
it when reporting a problem). A search response's `warnings` lists what the
request should change, such as a deprecated parameter it used; it is empty
otherwise. Redirects are never followed, so the API key
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

A custom `fetch` must honour `redirect: "manual"`, which the SDK passes on
every request so the API key never follows a redirect. If yours follows one
anyway, the SDK throws a `KeenableRedirectError` that tells you to rotate the
key, since it may already have been sent to the redirect's target.

## Community

Questions, feedback and news: join the [Keenable Discord](https://discord.gg/be3QybVZ2P)
and follow [@KeenableAI on X](https://x.com/KeenableAI). Report SDK bugs in the
[issue tracker](https://github.com/keenableai/keenable-sdk/issues).

## License

MIT
