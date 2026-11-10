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

`timeout` (default 30 s) is the deadline for each attempt. A timed-out request
raises `KeenableTimeoutError`, a subclass of `KeenableConnectionError`.

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
