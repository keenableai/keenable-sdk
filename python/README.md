# keenable

Official Python SDK for [Keenable](https://keenable.ai), a web search API built
for AI agents: ranked results that come back with the page text already
extracted, plus a fetch endpoint that returns any URL as clean markdown.

**Keyless by default.** Every call works with no account and no key. An optional
`KEENABLE_API_KEY` only lifts the hourly rate limit.

```bash
pip install keenable
```

## Search

```python
from keenable import Keenable

keenable = Keenable()  # or Keenable("keen_...") / set KEENABLE_API_KEY

results = keenable.search("how wafer scale chips avoid the memory bottleneck")

for result in results:
    print(result.title, result.url)
    print(result.snippet)
```

Results carry the page text in `snippet`. (`description` is deprecated: the
API no longer fills it, so it is always `None`. Build prompts from `snippet`.)

Filters are optional and combine freely:

```python
results = keenable.search(
    "post-training quantization results",
    site="arxiv.org",
    published_after="2026-01-01",
    snippet_max_length=500,
)
```

| Argument | What it does |
|---|---|
| `site` | Restrict to one domain, e.g. `"arxiv.org"` |
| `exclude_domains` | Never return results from these hosts or their subdomains; see below |
| `published_after` / `published_before` | Filter by publication date (`YYYY-MM-DD`) |
| `acquired_after` / `acquired_before` | Filter by when Keenable indexed the page |
| `snippet_max_length` | Cap the page text returned per result |
| `max_results` | How many results to return, 1 to 50 (default 10) |
| `query_time` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `objective` | What the search is for, in two or three sentences (up to 1,000 characters); logged by the API, no effect on results or price. Not sent when empty |
| `mode` | Search mode: `"pro"` (default) does deeper retrieval; `"realtime"` gives the fastest response, for latency-sensitive agent loops |
| `disable_cards` | `True` returns ordinary web pages in place of Keenable's cards (results Keenable writes for prices, exchange rates or company facts, whose URLs expire after one day). Default `False`, which is not sent; any other value raises `KeenableInvalidRequestError`. In the next release after 0.1.3 |

### Excluding domains

`exclude_domains` drops results from the listed sites.

```python
results = keenable.search(
    "how to repot a monstera without damaging the roots",
    exclude_domains=["pinterest.com", "quora.com"],
)
```

Each entry is a host, such as `"pinterest.com"`. A host excludes itself and
every subdomain, so `"yahoo.com"` also drops `finance.yahoo.com`. Up to 1,000
distinct hosts. Hosts such as `github.io` and `blogspot.com` are accepted.

The API cleans up unambiguous input for you: surrounding whitespace, case, an
`http://` or `https://` scheme, a leading `www.`, a port, a trailing `/` or
dot, a query string or `#fragment`; international names become punycode. So
`"https://WWW.Pinterest.com/"` is read as `"pinterest.com"`. Anything else is
rejected with HTTP 400, raised as `KeenableAPIError`: a path
(`"example.com/blog"`), a suffix or wildcard (`".com"`, `"*.example.com"`), an
IP address, a `user@host`, or an invalid host. The `param`, `value` and
`reason` attributes name the rejected entry, and `fix` says what to change:

```python
try:
    keenable.search("q", exclude_domains=["example.com/blog"])
except KeenableAPIError as err:
    if err.error == "invalid_filter":
        print(err.param, err.value, err.reason)
        # exclude_domains example.com/blog paths are not supported; give only the host, such as example.com
    else:
        print(err.body)
```

`value` and `reason` are set only for that rejection (a 400 whose body has
`"error": "invalid_filter"`) and `None` on every other error. `value` is
usually the entry as sent; a size cap reports the list's size (`"2500 entries"`
or `"more than 1000 distinct hosts"`) or an over-long entry's first 64
characters followed by `"..."`.

If every match is excluded, the response can be empty. The SDK sends the list
as given and leaves validation to the API; `run_tool_call` does the same with a
model's `exclude_domains` argument. `site` still works for a single domain,
and the `keenable_search` tool offers the model `site` and `exclude_domains`.

## Ground a model in one line

`to_context()` renders the result set as a numbered, citable block you can drop
straight into a prompt:

```python
context = keenable.search("cerebras inference benchmarks").to_context()

prompt = f"Answer using only these sources, citing them by number.\n\n{context}\n\nQuestion: ..."
```

It emits `[1] Title (url)` headers followed by the page text. Each result's
text is cleaned (images dropped, relative links resolved, markdown tables
flattened to `cell · cell;` rows) and cut at a word boundary to
`max_snippet_chars` (2000 by default, `None` for no cap; a value below 1 also
disables the cap), ending in "…". Results are then added whole until the character budget is reached (`max_chars=12000`
by default), so a later source is dropped rather than cut off. The first result
is kept even when it alone is over the budget.

To print a source list that matches the citations in the answer, ask which
results were actually rendered rather than listing them all:

```python
results = keenable.search("cerebras inference benchmarks")

for index, result in enumerate(results.cited(), start=1):
    print(f"[{index}] {result.title} - {result.url}")
```

## Read a full page

```python
page = keenable.fetch("https://cerebras.ai/chip")
print(page.title)
print(page.content)  # markdown, boilerplate stripped
print(page.to_context())  # same citable block shape as search results
```

`fetch()` takes three optional arguments. They ship in the next release after 0.1.3, so the version on PyPI doesn't have them yet:

```python
page = keenable.fetch("https://cerebras.ai/chip", max_chars=5000, live=True)
answer = keenable.fetch("https://cerebras.ai/chip", prompt="List the chip's specs")
```

| Option | What it does |
|---|---|
| `max_chars` | Cap the characters of content returned, a positive integer. The API default is 50000; `page.truncated` and `page.total_chars` say whether the page was cut |
| `live` | `True` fetches the page from its source now instead of reading Keenable's indexed copy. Default `False` |
| `prompt` | An extraction instruction, up to 2000 characters. `page.content` is then only the model's output for it, not the page |

## Tool calling

The SDK ships OpenAI-compatible tool definitions, so any inference API that
speaks that schema can call Keenable directly:

```python
from keenable import Keenable, TOOLS, run_tool_call

keenable = Keenable()
response = client.chat.completions.create(model=..., messages=messages, tools=TOOLS)

for call in response.choices[0].message.tool_calls or []:
    messages.append(
        {
            "role": "tool",
            "tool_call_id": call.id,
            "content": run_tool_call(
                keenable, call.function.name, call.function.arguments
            ),
        }
    )
```

`TOOLS` exposes `keenable_search` and `keenable_fetch`; `run_tool_call` executes
whichever the model picked and returns text ready for the `tool` message. Both
tools render the same numbered, citable block, so the model can cite a fetched
page the way it cites a search result. `arun_tool_call` is the async
counterpart, for use with `AsyncKeenable`.

The model may set `site`, `exclude_domains`, `published_after` and
`disable_cards` on search. The other filters stay on `search()` for you to set
yourself.

## Async

`AsyncKeenable` mirrors the sync client:

```python
import asyncio
from keenable import AsyncKeenable


async def main():
    async with AsyncKeenable() as keenable:
        results = await keenable.search("wafer scale engine")
        print(results.to_context())


asyncio.run(main())
```

## Monitors

A search monitor is a standing search: it watches the web for a topic and
hands over every new result that matches, by webhook, in scheduled runs, or when
you poll it. A page monitor (`type="page"`) reads one page on a schedule and
reports the changes worth telling. Monitors need an API key
(`KEENABLE_API_KEY`); without one, every call raises `KeenableAuthError` with
`code == "missing_api_key"` and sends nothing. An organization can have 100 active monitors.

```python
from keenable import Keenable

keenable = Keenable()
monitor = keenable.monitors.create(
    search={"query": "new open-weights LLM releases", "max_results": 20},
    schedule={"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
    webhook={"url": "https://example.com/keenable", "events": ["monitor.result.found"]},
    metadata={"team": "research"},
)
secret = monitor.webhook.secret  # whsec_..., returned by create() only

for result in keenable.monitors.results(monitor.id, min_importance=4):
    print(result.importance, result.title, result.url)
```

A page monitor watches one page, here a pricing page every 6 hours:

```python
pricing = keenable.monitors.create(
    type="page",
    page={
        "url": "https://example.com/pricing",
        "watch_for": "plan prices and new plans",
        "sensitivity": "meaningful",  # or "any": every change that is not cosmetic
    },
    schedule={"type": "interval", "value": "6h"},
)
for run in keenable.monitors.runs(pricing.id):
    if run.changes and run.changes.notified:
        print(run.changes.summary, run.changes.items)
for version in keenable.monitors.versions(pricing.id):
    print(version.version, version.fetched_at, version.diff and version.diff.added)
```

Schedules: `cron` (runs at least 10 minutes apart, in `timezone`), `interval`
(`"10m"` to `"90d"`) or `once`. Without one, a search monitor runs only on
`trigger()` and a page monitor every hour. The API checks the schedule and the
`output_schema`: one that breaks a rule raises `KeenableAPIError` with status
400, `code == "invalid_request"` and a message that names the rule.

| Method | What it does |
|---|---|
| `create(*, search, type, page, name, schedule, output_schema, webhook, metadata, idempotency_key)` | Make a search monitor (`search`) or a page monitor (`type="page"`, `page`) (`POST /v1/monitors`) |
| `list(*, status, name, metadata, limit, cursor)` / `list_all(...)` | One page of monitors / an iterator over all of them |
| `get(id)`, `update(id, **fields)`, `delete(id)` | Read, change (only the fields passed; `search`, `page` and `webhook` are merged; `None` removes the schedule, webhook or output schema), delete |
| `pause(id)`, `resume(id)` | `update(id, status="paused" / "active")` |
| `trigger(id)` | Start a run now; returns the queued `MonitorRun` |
| `runs(id, *, limit, cursor)`, `run(id, run_id)` | A monitor's runs |
| `results(id, *, limit, cursor, min_importance)` | The results a search monitor accepted, newest first, one per story (`GET /v1/monitors/{id}/results`) |
| `versions(id, *, limit, cursor)` | A page monitor's history, newest first: each version whose text changed, with its `diff` |
| `deliveries(id, *, limit, cursor)` | Webhook events of the last 7 days, with attempts and errors |
| `stats()` | Counts by status and by kind of schedule |
| `bulk(action, *, ids, filter, limit, dry_run=True)` | Pause, resume or delete many; a dry run unless `dry_run=False` |

`AsyncKeenable().monitors` has the same methods, awaitable (`list_all` is an
async iterator). Every call also takes `timeout`, `max_retries` and
`extra_headers`. Reads and deletes are retried like a search; `create()` sends
an `Idempotency-Key` (yours, or a new one per call), so its retries cannot make
a second monitor; `update()`, `trigger()` and `bulk()` are retried only on a 429.

A `Monitor` has `type` (`"search"` or `"page"`), `search` (None for a page
monitor), `page` (None for a search monitor), `disabled_reason` (`code`
`runs_failed`, `webhook_unreachable` or `data_policy` (a page monitor whose organization turned on zero data retention), while it is
disabled). A completed `MonitorRun` has, for a page
monitor, `changes` (`changed`, `notified`, `baseline`, `version`, `source`,
`summary`, `items`, `diff`). With an `output_schema`, `output` has
`structured`, `fresh` and `error`.

### Verify webhooks

Deliveries are signed as [Standard Webhooks](https://www.standardwebhooks.com).
Verify the raw body before trusting it:

```python
from keenable import WebhookVerificationError, verify_webhook

try:
    event = verify_webhook(raw_body, request.headers, secret)
except WebhookVerificationError:
    ...  # answer 400
if event.type == "monitor.result.found":
    print(event.data.result.url)
elif event.type == "monitor.page.changed":  # a page monitor's change worth telling
    print(event.data.run.changes.summary)
```

`verify_webhook` checks the HMAC-SHA256 signature in constant time and refuses
a timestamp more than 5 minutes from now (`tolerance=` changes it). Drop
repeats by `event.id`, which stays the same across retries.

## Errors

All errors subclass `KeenableError`:

| Exception | When |
|---|---|
| `KeenableRateLimitError` | HTTP 429. Set `KEENABLE_API_KEY` to lift the keyless cap |
| `KeenableAuthError` | HTTP 401/403, the key was rejected |
| `KeenableInsufficientCreditsError` (alias `KeenableCreditsError`) | HTTP 402, no credits left; retrying will not help |
| `KeenableAPIError` | Any other non-2xx response; carries `status_code` |
| `KeenableConnectionError` | The API could not be reached |
| `KeenableTimeoutError` | A `KeenableConnectionError`: the API did not answer within `timeout` |
| `KeenableInvalidRequestError` | Bad arguments; no request was sent |

## Handling errors

The SDK already retries what can be retried (see
[Retries and timeouts](#retries-and-timeouts)), so an error that reaches you is
final for this call. Every `KeenableAPIError` carries what the API says about
the failure. Branch on `code`, not on the message. Each field is `None` when the
API did not send it.

```python
from keenable import Keenable, KeenableAPIError, KeenableRateLimitError

keenable = Keenable()
try:
    results = keenable.search("wafer scale engine")
except KeenableRateLimitError as err:
    # Only reaches you when the wait is over a minute (e.g. the keyless
    # hourly cap) or the retries ran out.
    print(f"rate limited, retry in {err.retry_after_seconds}s:", err.fix)
except KeenableAPIError as err:
    print(err.code, err.fix, err.request_id)
```

| Field | Meaning |
|---|---|
| `code` | Stable reason, e.g. `rate_limit_per_second`, `insufficient_credits`, `target_blocked` |
| `type` | The category: `invalid_request_error`, `authentication_error`, `permission_error`, `billing_error`, `rate_limit_error`, `target_error` (the page being fetched failed, not Keenable) or `api_error`; derived from the status when an older API leaves it out |
| `fix` | One sentence on what to do next |
| `retryable` | Whether the same request can succeed later |
| `retry_after_seconds` | Seconds to wait (body, else the `Retry-After` header) |
| `request_id` | Quote it when reporting a problem |
| `param` | The parameter a 400 is about |
| `value`, `reason` | What a 400 `invalid_filter` rejected (usually the entry; for a size cap the count or a truncated entry), and why |
| `limit` | On a 429: `RateLimitInfo(scope, window, max, resets_at)` |

When the API sends `fix`, the error message ends with it, then with
`(code: <code>)` and `(request_id: <id>)`, as in the Go and TypeScript SDKs.
A 402 is a `KeenableInsufficientCreditsError` whose message is the SDK's own:
"insufficient credits", or "payment required" for a pay-per-request (x402)
response, which this SDK cannot pay (call the API with a key instead). The SDK
does not expose billing links or payment offers.
A 403 with type `target_error` (e.g. code `target_blocked`, the fetched site
refused us) is a plain `KeenableAPIError`, not a `KeenableAuthError`.

## Retries and timeouts

Failed requests are retried twice by default. Connection errors, timeouts, 408,
429 and 5xx are retried, unless the API marks the error `retryable: false`
(credits, bad parameters and blocked pages never are). The SDK waits the API's
`Retry-After` when it sent one, else backs off exponentially from 0.5 s to 8 s
with jitter. A `Retry-After` over 60 s, such as the keyless hourly cap, is not
waited out: the error is raised at once so your code decides.

`timeout` (default 30 s) is the deadline for each attempt as a whole, from
connecting to the end of the answer, headers included: a server that keeps
sending a few bytes at a time still times out on schedule. A timed-out request
raises `KeenableTimeoutError`, a subclass of `KeenableConnectionError`, and its
connection is closed, so nothing keeps running after it. Pass an
`httpx.Timeout` instead of a number to set httpx's per-phase timeouts
(connect, read, write, pool) with no overall deadline.

The overall deadline needs the HTTP client the SDK creates. With your own
`client=httpx.Client(...)`, a numeric `timeout` keeps httpx's per-phase
meaning: each connect and each read gets the timeout, and a server that keeps
trickling bytes is not cut off. `AsyncKeenable` enforces the deadline either
way.

```python
keenable = Keenable(max_retries=4, timeout=10, default_headers={"X-Team": "search"})
keenable.search("wafer scale engine", max_retries=0)  # no retries for this call
keenable.fetch("https://example.com", timeout=60, extra_headers={"X-Trace": "abc"})
```

Every call takes `timeout`, `max_retries` and `extra_headers`, which override
the client's settings for that call. Results carry `request_id` (quote it when
reporting a problem). Redirects are never followed, so the API key cannot leak
to another host.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KEENABLE_API_KEY` | unset | Lifts the hourly rate limit. Create one at [keenable.ai/console](https://keenable.ai/console) |
| `KEENABLE_API_URL` | `https://api.keenable.ai` | Override the API base URL |

Both can also be passed to the constructor as `api_key` and `base_url`, alongside
`timeout`, `max_retries`, `default_headers`, `client` (your own `httpx.Client`,
e.g. for a proxy) and `client_source`. Building an integration on top of this SDK? Set
`client_source="Your Integration"` so your traffic is attributed to you rather
than to the bare SDK.

## License

MIT
