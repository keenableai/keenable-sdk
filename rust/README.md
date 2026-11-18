# keenable

Official Rust SDK for [Keenable](https://keenable.ai), a web search API built
for AI agents: ranked results that come back with the page text already
extracted, plus a fetch endpoint that returns any URL as clean markdown.

**Keyless by default.** Every call works with no account and no key. An
optional `KEENABLE_API_KEY` only lifts the hourly rate limit.

```bash
cargo add keenable
cargo add tokio --features macros,rt-multi-thread
```

Rust 1.80 or newer. The client is async and runs on [Tokio](https://tokio.rs).
TLS uses rustls by default; turn on the `native-tls` feature (with
`default-features = false`) to use the platform's TLS library instead.

From a checkout of this repo, the quickstart below is `examples/hello.rs`:

```bash
cd rust && cargo run --example hello
```

## Quickstart

```rust
#[tokio::main]
async fn main() -> Result<(), keenable::Error> {
    let client = keenable::Client::new()?; // or set KEENABLE_API_KEY
    let results = client
        .search("how wafer scale chips avoid the memory bottleneck")
        .await?;
    println!("{}", results.to_context()); // numbered, citable block for a prompt
    Ok(())
}
```

## Configuration

`Client::new()` reads two environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `KEENABLE_API_KEY` | unset | Your API key. Unset means keyless. |
| `KEENABLE_API_URL` | `https://api.keenable.ai` | The API base URL. |

`Client::with_options` takes the same settings in code:

```rust
use std::time::Duration;

let client = keenable::Client::with_options(keenable::Options {
    api_key: Some("keen_...".into()),
    timeout: Some(Duration::from_secs(10)),
    client_source: Some("My Agent".into()),
    ..Default::default()
})?;
```

| Field | What it does |
|---|---|
| `api_key` | `None` reads `KEENABLE_API_KEY`; `Some("")` forces the keyless tier |
| `base_url` | `None` reads `KEENABLE_API_URL`. Must be https, except http to `localhost`, `127.0.0.1` or `::1` |
| `timeout` | The deadline for one attempt, headers and body together. Default 30 s |
| `client_source` | Sent as `X-Keenable-Title`. Default `Keenable SDK`. Set it to your product's name if you build on this SDK |
| `max_retries` | Default 2; `Some(0)` turns retries off |
| `headers` | Sent with every request, for a proxy or gateway. `X-API-Key` is ignored here |
| `http_client` | Your own `reqwest::ClientBuilder`, for a proxy or custom TLS. The SDK turns redirects off on it |

`Client` is cheap to clone and shares its connection pool: build one and reuse it.

## Search

Results carry the page text in `snippet`.

```rust
let results = client
    .search_with(
        "post-training quantization results",
        &keenable::SearchOptions {
            site: Some("arxiv.org".into()),
            published_after: Some("2026-01-01".into()),
            max_results: Some(5),
            ..Default::default()
        },
    )
    .await?;
for result in &results {
    println!("{} {}", result.title, result.url);
}
```

| Field | What it does |
|---|---|
| `mode` | `"pro"` (the default) does deeper retrieval; `"realtime"` gives the fastest response |
| `site` | Restrict to one domain, such as `"arxiv.org"` |
| `exclude_domains` | Never return results from these hosts or their subdomains, up to 1,000 |
| `published_after` / `published_before` | Filter by publication date (`YYYY-MM-DD`) |
| `acquired_after` / `acquired_before` | Filter by when Keenable indexed the page |
| `snippet_max_length` | Cap the page text returned per result, 180 to 10000 characters |
| `max_results` | How many results to return, 1 to 50. The API default is 10 |
| `query_time` | Search the index as it stood at that moment (`YYYY-MM-DD`, ISO 8601, or `"7d"`); not a recency filter |
| `objective` | What the search is for, in two or three sentences (up to 1,000 characters); logged by the API, no effect on results or price |
| `disable_cards` | `true` returns ordinary web pages in place of Keenable's cards |
| `request` | This call's timeout, retry budget and headers (`RequestOptions`) |

An empty string is unset and is not sent. When the API rejects an
`exclude_domains` entry, the error is an `Error::Api` whose `ApiError` has
`param` (`exclude_domains`), `value` (the rejected entry) and `reason`.

## Ground a model in one line

`to_context()` renders results as `[n] Title (url)` headers followed by each
page's text. The text is cleaned (images dropped, relative links resolved,
tables flattened) and capped at 2000 characters per result; results are then
added whole until 12000 characters. `cited()` returns the results the block
numbered, so a source list matches the model's citations:

```rust
let prompt = format!(
    "Answer using only these sources, citing them by number.\n\n{}",
    results.to_context()
);
for (i, result) in results.cited().iter().enumerate() {
    println!("[{}] {} - {}", i + 1, result.title, result.url);
}
```

Pass a `ContextOptions` to `to_context_with` and `cited_with` to change
`max_chars`, `max_results`, `include_dates` or `max_snippet_chars`.

## Read a full page

```rust
let page = client.fetch("https://cerebras.ai/chip").await?;
println!("{}", page.content); // markdown, boilerplate stripped
println!("{}", page.to_context()); // same citable block shape as search results

let answer = client
    .fetch_with(
        "https://cerebras.ai/chip",
        &keenable::FetchOptions {
            prompt: Some("List the chip's specs".into()),
            ..Default::default()
        },
    )
    .await?;
```

`FetchOptions` has `max_chars` (the API default is 50000; `page.truncated` and
`page.total_chars` say whether the page was cut), `live` (fetch from the source
now instead of Keenable's indexed copy) and `prompt` (an extraction
instruction, up to 2000 characters).

Internal hosts and private addresses are refused before a request is sent:
`localhost` and names under `.localhost`, `metadata.google.internal`, and IP
addresses in private, loopback, link-local, carrier-grade NAT, documentation,
benchmarking, multicast and reserved ranges, however the address is spelled.

## Tool calling

`keenable::tools()` returns OpenAI-compatible definitions for
`keenable_search` and `keenable_fetch`. Serialize them into your chat request,
then run whichever tool the model calls:

```rust
let tools = serde_json::to_value(keenable::tools())?;
// ... send `tools` with your chat request, then for each tool call:
let content = match client.run_tool_call(&call.name, &call.arguments).await {
    Ok(text) => text,
    // One bad URL should not end the agent loop.
    Err(e) => format!("Tool call failed: {e}"),
};
```

`arguments` is the JSON text the model sent, or a `serde_json::Value`. The
model may set `site`, `exclude_domains`, `published_after`, `objective` and
`disable_cards` on search.

## Retries

Connection errors, timeouts, 408, 429 and 5xx are retried, unless the API says
the error is not retryable. The wait is the API's Retry-After when it sent
one, else exponential backoff from 0.5 s up to 8 s with jitter. A Retry-After
longer than 60 s (such as the keyless hourly cap) is not waited out: the error
is returned at once. A redirect is never followed or retried, so the API key
goes only to the configured host.

## Errors

Every call returns `keenable::Error`:

| Variant | When |
|---|---|
| `Error::RateLimit` | Type `rate_limit_error` (HTTP 429 when the API sends no type), rate limit exceeded |
| `Error::Auth` | Type `authentication_error` or `permission_error` (HTTP 401 or 403 when the API sends no type), key rejected |
| `Error::InsufficientCredits` | Type `billing_error` (HTTP 402 when the API sends no type), out of credits |
| `Error::Api` | Any other non-2xx response |
| `Error::Connection` | API could not be reached, or the deadline elapsed (`is_timeout()`) |
| `Error::InvalidRequest` | Bad arguments, no request sent |

`err.api_error()` gives the `ApiError` behind any of the HTTP variants:
`status_code`, `code` (the API's machine-readable reason), `error_type`,
`fix` (what to do next), `retryable`, `retry_after`, `request_id`, and for a
429, `limit`. `err.sdk_code()` is a stable string, and the same token ends the
error's text.

```rust
match client.search("q").await {
    Ok(results) => println!("{}", results.to_context()),
    Err(keenable::Error::RateLimit(e)) => eprintln!("slow down: {:?}", e.retry_after),
    Err(e) => eprintln!("{e}"),
}
```

## License

MIT
