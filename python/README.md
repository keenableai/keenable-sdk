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
| `include_domains` | Only return results from these domains (allow-list); see below |
| `exclude_domains` | Never return results from these domains (block-list) |
| `published_after` / `published_before` | Filter by publication date (`YYYY-MM-DD`) |
| `acquired_after` / `acquired_before` | Filter by when Keenable indexed the page |
| `snippet_max_length` | Cap the page text returned per result |
| `max_results` | How many results to return, 1 to 50 (default 10) |
| `query_time` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `mode` | Search mode; `"pro"` (default) does deeper retrieval |

### Domain allow-lists and block-lists

`include_domains` keeps only results from the listed sites; `exclude_domains`
drops results from them. Set both and a result must match the allow-list and
miss the block-list (exclude wins).

```python
results = keenable.search(
    "Security Council resolution on the situation in Sudan",
    include_domains=["press.un.org", "undocs.org", "documents.un.org"],
    exclude_domains=["blogs.un.org"],
)
```

Each entry is one of:

| Entry | Matches |
|---|---|
| `"un.org"` | the domain and all its subdomains |
| `"un.org/en/ga"` | that path prefix, on whole segments (`/en/ga/x`, not `/en/gax`) |
| `".gov"`, `"*.gov"`, `".gov.uk"` | every host under that suffix |

Matching ignores case, a leading `www.` and a trailing `/`. Up to 200 entries
across both lists. A narrow list can return fewer than `max_results`; when
results had to be removed to honour it, the response says so in
`results.raw["warning"]`.

The lists are sent as given, including `[]`, and the API validates them. An
empty `include_domains`, an entry with a scheme, port, query or IP address,
the same entry in both lists, or `include_domains` together with `site` is
rejected with HTTP 400, raised as `KeenableAPIError`. Its message names the
field, the entry and the reason:

```python
try:
    keenable.search("q", include_domains=["https://un.org"])
except KeenableAPIError as err:
    print(err.body)
    # Invalid include_domains value "https://un.org": scheme is not allowed
```

The field, entry and reason are only in that message; the API sends no
separate keys for them. `err.data` holds the whole decoded body
(`{"error": "Bad request", "message": "..."}`).

`site` still works for a single domain. The `keenable_search` tool offers the
model `site`, `include_domains` and `exclude_domains`.

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
| `KeenableAPIError` | Any other non-2xx response; carries `status_code`, and `data` (the decoded JSON error body) when there is one |
| `KeenableConnectionError` | The API could not be reached |
| `KeenableInvalidRequestError` | Bad arguments; no request was sent |

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
