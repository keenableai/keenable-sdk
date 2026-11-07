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

Results carry the page text in `snippet`. (`description` is the page's meta
description and is empty for most pages, so build prompts from `snippet`.)

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
| `published_after` / `published_before` | Filter by publication date (`YYYY-MM-DD`) |
| `acquired_after` / `acquired_before` | Filter by when Keenable indexed the page |
| `snippet_max_length` | Cap the page text returned per result |
| `max_results` | How many results to return, 1 to 50 (default 10) |
| `query_time` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `mode` | Search mode; `"pro"` (default) does deeper retrieval |

## Ground a model in one line

`to_context()` renders the result set as a numbered, citable block you can drop
straight into a prompt:

```python
context = keenable.search("cerebras inference benchmarks").to_context()

prompt = f"Answer using only these sources, citing them by number.\n\n{context}\n\nQuestion: ..."
```

It emits `[1] Title (url)` headers followed by the page text, adds results whole
until the character budget is reached (`max_chars=12000` by default), and never
truncates a source mid-sentence.

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
| `KeenableInvalidRequestError` | Bad arguments; no request was sent |

## Handling errors

Every `KeenableAPIError` carries what the API says about the failure. Branch on
`code`, not on the message, and wait `retry_after_seconds` before a retry. Each
field is `None` when the API did not send it.

```python
import time

from keenable import Keenable, KeenableAPIError

keenable = Keenable()
for attempt in range(3):
    try:
        results = keenable.search("wafer scale engine")
        break
    except KeenableAPIError as err:
        print(err.code, err.fix, err.docs_url, err.request_id)
        if not err.retryable or attempt == 2:
            raise  # e.g. insufficient_credits, invalid_parameter
        time.sleep(err.retry_after_seconds or 1)
```

| Field | Meaning |
|---|---|
| `code` | Stable reason, e.g. `rate_limit_per_second`, `insufficient_credits`, `target_blocked` |
| `type` | The category: `invalid_request_error`, `authentication_error`, `permission_error`, `billing_error`, `rate_limit_error`, `target_error` (the page being fetched failed, not Keenable) or `api_error`; derived from the status when an older API leaves it out |
| `fix` | One sentence on what to do next |
| `docs_url` | The docs page for this error |
| `retryable` | Whether the same request can succeed later |
| `retry_after_seconds` | Seconds to wait (body, else the `Retry-After` header) |
| `request_id` | Quote it when reporting a problem |
| `param` | The parameter a 400 is about |
| `limit` | On a 429: `RateLimitInfo(scope, window, max, resets_at)` |
| `billing_url`, `auto_top_up_url`, `pay_per_request` | On a 402: where to add credits and the alternatives |
| `raw` | The whole JSON error body |

When the API sends `fix`, the error message ends with it, then with
`Docs: <docs_url>` and `(request_id: <id>)`, as in the Go and TypeScript SDKs.
A 403 with type `target_error` (e.g. code `target_blocked`, the fetched site
refused us) is a plain `KeenableAPIError`, not a `KeenableAuthError`. The SDK does not retry on its
own.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `KEENABLE_API_KEY` | unset | Lifts the hourly rate limit. Create one at [keenable.ai/console](https://keenable.ai/console) |
| `KEENABLE_API_URL` | `https://api.keenable.ai` | Override the API base URL |

Both can also be passed to the constructor as `api_key` and `base_url`, alongside
`timeout` and `client_source`. Building an integration on top of this SDK? Set
`client_source="Your Integration"` so your traffic is attributed to you rather
than to the bare SDK.

## License

MIT
