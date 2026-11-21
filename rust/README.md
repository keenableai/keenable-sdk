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

## Read full pages

```rust
let response = client
    .fetch_with(
        ["https://cerebras.ai/chip", "https://cerebras.ai/blog"],
        &keenable::FetchOptions {
            max_chars: Some(5000),
            ..Default::default()
        },
    )
    .await?;
for page in &response.results {
    match &page.error {
        Some(error) => println!("{} failed: {:?}", page.url, error.code),
        None => println!("{}", page.to_context()), // same citable block as search results
    }
}
```

`fetch` sends one `POST /v1/fetch`. `results[i]` is for `urls[i]`; a URL that
failed has `error` set instead of returning `Err`. `FetchOptions` has
`max_chars`, `prompt` (each page's `content` is then only an LLM's answer to
it), `schema` (each page's answer is in `page.structured`), `links`,
`images` and `max_age_hours` (`Some(0.0)` reads every page live), sent only
when set; the API checks their values.

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

On fetch the model sets `urls` (1 to 20) and may set `max_chars` (per page),
`prompt` (applied to every page) and `max_age_hours` (0 reads every page
live), as on the hosted MCP tool. A lone `url`, the shape older models
learned, still works. Each page comes back as its own numbered block. A URL
that failed while others were read becomes a `[n] <url> - failed: <reason>`
block; `run_tool_call` returns its error only when no URL could be read.

## Retries

Connection errors, timeouts, 408, 429 and 5xx are retried, unless the API says
the error is not retryable. The wait is the API's Retry-After when it sent
one, else exponential backoff from 0.5 s up to 8 s with jitter. A Retry-After
longer than 60 s (such as the keyless hourly cap) is not waited out: the error
is returned at once. A redirect is never followed or retried, so the API key
goes only to the configured host.

## Monitors

A search monitor is a standing search: it watches the web for a topic and
hands over every new result that matches, by webhook, in scheduled runs, or when
you poll it. A page monitor (`monitor_type: Some("page".into())`, sent as
`type`) reads one page on a schedule and reports the changes worth telling.
Monitors need an API key (`KEENABLE_API_KEY`); without one, every call returns
`Error::Auth` with code `missing_api_key` and sends nothing. An organization can have 100 active monitors.

```rust
use keenable::{MonitorCreateParams, MonitorResultsParams, MonitorScheduleParams, MonitorSearchParams};

let client = keenable::Client::new()?;
let monitor = client
    .monitors()
    .create(&MonitorCreateParams {
        search: MonitorSearchParams::new("new open-weights LLM releases"),
        schedule: Some(MonitorScheduleParams {
            schedule_type: "cron".into(),
            value: Some("0 9 * * 1-5".into()),
            timezone: Some("Europe/Paris".into()),
        }),
        ..Default::default()
    })
    .await?;
let results = client
    .monitors()
    .results(&monitor.id, &MonitorResultsParams { min_importance: Some(4), ..Default::default() })
    .await?;
for result in results.data {
    println!("{}", result.url);
}
```

A page monitor watches one page, here a pricing page every 6 hours:

```rust
use keenable::{MonitorPageTarget, MonitorVersionsParams};

let pricing = client
    .monitors()
    .create(&MonitorCreateParams {
        monitor_type: Some("page".into()),
        page: Some(MonitorPageTarget {
            watch_for: Some("plan prices and new plans".into()),
            sensitivity: Some("meaningful".into()), // or "any": every change that is not cosmetic
            ..MonitorPageTarget::new("https://example.com/pricing")
        }),
        schedule: Some(MonitorScheduleParams {
            schedule_type: "interval".into(),
            value: Some("6h".into()),
            timezone: None,
        }),
        ..Default::default()
    })
    .await?;
let versions = client
    .monitors()
    .versions(&pricing.id, &MonitorVersionsParams { limit: Some(10), ..Default::default() })
    .await?;
for v in versions.data {
    println!("{} {:?}", v.version, v.diff.map(|d| d.added));
}
```

Schedules: `cron` (runs at least 10 minutes apart, in `timezone`), `interval`
("10m" to "90d") or `once`. Without one, a search monitor runs only on
`trigger` and a page monitor every hour. The API checks the schedule and the
`output_schema`: one that breaks a rule returns `Error::Api` with status 400,
code `invalid_request` and a message that names the rule.

| Method on `client.monitors()` | What it does |
|---|---|
| `create(&MonitorCreateParams)` | Make a search monitor (`search`) or a page monitor (`monitor_type` "page", `page`) (`POST /v1/monitors`) |
| `list(&MonitorListParams)` / `list_all(&MonitorListParams)` | One page of monitors / a `MonitorPager` over all of them |
| `get(id)`, `update(id, &MonitorUpdateParams)`, `delete(id)` | Read, change (only what is set; `search`, `page` and `webhook` are merged; `Some(None)` removes the name, schedule, webhook, output schema or metadata), delete |
| `pause(id)`, `resume(id)` | Update with status "paused" / "active" |
| `trigger(id)` | Start a run now; returns the queued `MonitorRun` |
| `runs(id, &MonitorPageParams)`, `run(id, run_id)` | A monitor's runs |
| `results(id, &MonitorResultsParams)` | The results a search monitor accepted, newest first, one per story (`GET /v1/monitors/{id}/results`) |
| `versions(id, &MonitorVersionsParams)` | A page monitor's history, newest first: each version whose text changed, with its `diff` |
| `deliveries(id, &MonitorPageParams)` | Webhook events of the last 7 days, with attempts and errors |
| `stats()` | Counts by status and by kind of schedule |
| `bulk(action, &MonitorBulkParams)` | Pause, resume or delete many; a dry run unless `dry_run: Some(false)` |

`client.monitors().with_request(RequestOptions { .. })` sets a timeout, retry
budget or headers for the calls made through it. Reads and deletes are retried
like a search; `create` sends an `Idempotency-Key` (yours, or a new one per
call), so its retries cannot make a second monitor; `update`, `trigger` and
`bulk` are retried only on a 429.

A `Monitor` has `monitor_type` ("search" or "page"), `search` (`None` for a
page monitor), `page` (`None` for a search monitor), `disabled_reason` (`code`
`runs_failed`, `webhook_unreachable` or `data_policy` (a page monitor whose organization turned on zero data retention), while it is
disabled). A completed `MonitorRun` has, for a page
monitor, `changes` (`changed`, `notified`, `baseline`, `version`, `source`,
`summary`, `items`, `diff`). With an output schema, `output` has `structured`,
`fresh` and `error`.

### Verify webhooks

Deliveries are signed as [Standard Webhooks](https://www.standardwebhooks.com).
Verify the raw body before trusting it:

```rust
// body: the raw request body; headers: a keenable::reqwest::header::HeaderMap
match keenable::verify_webhook(body, &headers, secret) {
    Ok(event) if event.event_type == "monitor.result.found" => {
        println!("{}", event.data.result.map(|r| r.url).unwrap_or_default());
    }
    Ok(event) if event.event_type == "monitor.page.changed" => {
        // a page monitor's change worth telling
        let changes = event.data.run.and_then(|r| r.changes);
        println!("{:?}", changes.and_then(|c| c.summary));
    }
    Ok(_) => {}
    Err(_) => { /* answer 400 */ }
}
```

`verify_webhook` checks the HMAC-SHA256 signature in constant time and refuses
a timestamp more than 5 minutes from now (`verify_webhook_with` and
`WebhookOptions::tolerance` change it). A failure is
`Error::WebhookVerification`. Drop repeats by `event.id`, which stays the same
across retries.

## Errors

Every call returns `keenable::Error`:

| Variant | When |
|---|---|
| `Error::RateLimit` | HTTP 429, rate limit exceeded |
| `Error::Auth` | HTTP 401 or 403, key rejected |
| `Error::InsufficientCredits` | HTTP 402, out of credits |
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
