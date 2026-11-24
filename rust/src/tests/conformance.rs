//! Runs scripts/conformance/cases, as copied to tests/fixtures/conformance.json
//! by scripts/conformance/sync.ts. The Go, Python and TypeScript SDKs run the
//! same cases, so a behaviour that differs between the SDKs fails here or
//! there. See scripts/conformance/README.md for the rules.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{Map, Value};

use super::server::{deadline_server, start, Reply, Script, Server};
use super::*;
use crate::retry::retry_after_at;
use crate::test_hooks::{start_recording, take_waits};
use crate::{Client, Error, FetchOptions, Options, RequestOptions, SearchOptions};

fn fixture() -> Value {
    load_fixture("conformance.json")
}

fn cases<'a>(fixture: &'a Value, section: &str) -> &'a Vec<Value> {
    fixture[section].as_array().expect("a list of cases")
}

fn name(case: &Value) -> String {
    case["name"].as_str().unwrap_or("?").to_string()
}

/// The reason this SDK skips a case, if the fixture names one.
fn skipped(case: &Value) -> Option<&str> {
    case["skip"]["rust"].as_str()
}

fn ok_both() -> Script {
    Script::ByPath {
        search: Reply::new(200, r#"{"query":"q","results":[]}"#),
        fetch: Reply::new(
            200,
            r#"{"results":[{"url":"https://e.com","content":"c"}]}"#,
        ),
    }
}

fn reply_for(case: &Value) -> Reply {
    let mut reply = Reply::new(
        case["status"].as_u64().unwrap_or(200) as u16,
        case["body"].as_str().unwrap_or(""),
    );
    if let Some(headers) = case["headers"].as_object() {
        for (k, v) in headers {
            reply = reply.header(k, v.as_str().unwrap_or(""));
        }
    }
    reply
}

/// Every number as an f64, so an amount of `-1.0` matches the fixture's `-1`.
fn as_floats(v: &Value) -> Value {
    match v {
        Value::Number(n) => n.as_f64().map_or(Value::Null, Value::from),
        Value::Array(items) => Value::Array(items.iter().map(as_floats).collect()),
        Value::Object(m) => {
            Value::Object(m.iter().map(|(k, v)| (k.clone(), as_floats(v))).collect())
        }
        other => other.clone(),
    }
}

/// Fails with every failing case at once, so one run shows them all.
fn report(section: &str, failures: Vec<String>) {
    assert!(
        failures.is_empty(),
        "{section}: {} failing case(s):\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn is_invalid(r: &Result<impl std::fmt::Debug, Error>) -> bool {
    matches!(r, Err(Error::InvalidRequest(_)))
}

/// Whether `err` is the class a case names.
fn kind_matches(err: &Error, kind: &str) -> bool {
    match kind {
        "redirect" => matches!(err, Error::Connection(c) if c.is_redirect()),
        "auth" => matches!(err, Error::Auth(_)),
        "rate_limit" => matches!(err, Error::RateLimit(_)),
        "insufficient_credits" => matches!(err, Error::InsufficientCredits(_)),
        "api" => matches!(err, Error::Api(_)),
        _ => false,
    }
}

#[test]
fn the_fixture_is_the_same_in_every_sdk() {
    same_in_every_sdk("conformance.json", "tests/fixtures/conformance.json");
}

#[tokio::test]
async fn fetch_url() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "fetch_url") {
        let server = start(ok_both()).await;
        let client = keyed(&server);
        let url = case["url"].as_str().unwrap();
        let got = client.fetch([url]).await;
        let allowed = case["allowed"].as_bool().unwrap();
        let ok = if allowed {
            got.is_ok() && server.count() == 1
        } else {
            is_invalid(&got) && server.count() == 0
        };
        if !ok {
            failures.push(format!(
                "{}: {:?} requests={}",
                name(case),
                got.err(),
                server.count()
            ));
        }
    }
    report("fetch_url", failures);
}

#[test]
fn base_url() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "base_url") {
        let got = Client::with_options(Options {
            api_key: Some("k".into()),
            base_url: Some(case["base_url"].as_str().unwrap().into()),
            ..Default::default()
        });
        let valid = case["valid"].as_bool().unwrap();
        let ok = if valid { got.is_ok() } else { is_invalid(&got) };
        if !ok {
            failures.push(format!("{}: {:?}", name(case), got.err()));
        }
    }
    report("base_url", failures);
}

/// Unix seconds for an RFC 3339 UTC time such as 2026-01-01T00:00:00.250Z.
fn unix_seconds(text: &str) -> f64 {
    let (date, time) = text.trim_end_matches('Z').split_once('T').unwrap();
    let d: Vec<i64> = date.split('-').map(|p| p.parse().unwrap()).collect();
    let t: Vec<f64> = time.split(':').map(|p| p.parse().unwrap()).collect();
    let days = crate::retry::days_from_civil(d[0], d[1], d[2]);
    days as f64 * 86_400.0 + t[0] * 3600.0 + t[1] * 60.0 + t[2]
}

#[test]
fn retry_after() {
    let fixture = fixture();
    let section = &fixture["retry_after"];
    let now = unix_seconds(section["now"].as_str().unwrap());
    let mut failures = Vec::new();
    for case in section["cases"].as_array().unwrap() {
        let got = retry_after_at(case["value"].as_str().unwrap(), now);
        let want = case["seconds"].as_f64().map(Duration::from_secs_f64);
        if got != want {
            failures.push(format!("{}: got {got:?}, want {want:?}", name(case)));
        }
    }
    report("retry_after", failures);
}

#[tokio::test]
async fn retry() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "retry") {
        let server = start(Script::Replies(vec![reply_for(case), ok_search()])).await;
        let client = Client::with_options(Options {
            api_key: Some("k".into()),
            base_url: Some(server.base_url.clone()),
            max_retries: Some(case["max_retries"].as_u64().unwrap() as u32),
            ..Default::default()
        })
        .unwrap();
        start_recording();
        let got = client.search("q").await;
        let waits = take_waits();
        let n = server.count();
        let problem = if case["retried"].as_bool().unwrap() {
            if got.is_err() || n != 2 || waits.len() != 1 {
                Some(format!("{:?} requests={n} waits={waits:?}", got.err()))
            } else if let Some(seconds) = case["wait"].as_f64() {
                (waits[0] != Duration::from_secs_f64(seconds))
                    .then(|| format!("wait {:?}, want {seconds}s", waits[0]))
            } else {
                let w = waits[0];
                (w < Duration::from_millis(375) || w > Duration::from_millis(500))
                    .then(|| format!("wait {w:?} is not the first backoff step"))
            }
        } else {
            let kind = case["kind"].as_str().unwrap();
            match &got {
                Err(e) if n == 1 && waits.is_empty() && kind_matches(e, kind) => None,
                _ => Some(format!("{got:?} requests={n} waits={waits:?}, want {kind}")),
            }
        };
        if let Some(p) = problem {
            failures.push(format!("{}: {p}", name(case)));
        }
    }
    report("retry", failures);
}

fn ok_search() -> Reply {
    Reply::new(200, r#"{"query":"q","results":[]}"#)
}

/// Every string an error shows a caller except `body` and `fix`, the API's
/// own text.
pub(super) fn exposed_text(err: &Error) -> Vec<String> {
    let mut out = vec![err.to_string()];
    if let Some(api) = err.api_error() {
        out.push(api.error_type.clone());
        for s in [
            &api.code,
            &api.error,
            &api.request_id,
            &api.param,
            &api.value,
            &api.reason,
        ]
        .into_iter()
        .flatten()
        {
            out.push(s.clone());
        }
        if let Some(limit) = &api.limit {
            out.push(format!("{limit:?}"));
        }
    }
    out
}

fn opt_str(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

#[tokio::test]
async fn errors() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "errors") {
        let server = start(Script::Replies(vec![reply_for(case)])).await;
        let err = keyed(&server).search("q").await.unwrap_err();
        let want = &case["expect"];
        let mut problems = Vec::new();
        if !kind_matches(&err, want["kind"].as_str().unwrap()) {
            problems.push(format!("kind: got {err:?}"));
        }
        if let Some(api) = err.api_error() {
            let status = case["status"].as_u64().unwrap() as u16;
            if api.status_code != status || api.error_type != want["type"].as_str().unwrap() {
                problems.push(format!(
                    "status {} type {}",
                    api.status_code, api.error_type
                ));
            }
            for (field, got) in [
                ("detail", &api.body),
                ("code", &api.code),
                ("error", &api.error),
                ("fix", &api.fix),
                ("request_id", &api.request_id),
                ("param", &api.param),
                ("value", &api.value),
                ("reason", &api.reason),
            ] {
                if *got != opt_str(&want[field]) {
                    problems.push(format!("{field} = {got:?}, want {}", want[field]));
                }
            }
            if api.retryable != want["retryable"].as_bool() {
                problems.push(format!("retryable {:?}", api.retryable));
            }
            let wait = want["retry_after_seconds"]
                .as_f64()
                .map(Duration::from_secs_f64);
            if api.retry_after != wait {
                problems.push(format!("retry after {:?}, want {wait:?}", api.retry_after));
            }
            let limit = &want["limit"];
            let want_limit = limit.as_object().map(|l| crate::RateLimitInfo {
                scope: opt_str(&l["scope"]),
                window: opt_str(&l["window"]),
                max: l.get("max").and_then(Value::as_u64),
                resets_at: opt_str(&l["resets_at"]),
            });
            if api.limit != want_limit {
                problems.push(format!("limit {:?}, want {want_limit:?}", api.limit));
            }
        }
        let msg = err.to_string();
        for s in want["message_contains"].as_array().unwrap() {
            if !msg.contains(s.as_str().unwrap()) {
                problems.push(format!("message {msg:?} lacks {s}"));
            }
        }
        for s in want["message_excludes"].as_array().unwrap() {
            if msg.contains(s.as_str().unwrap()) {
                problems.push(format!("message {msg:?} has {s}"));
            }
        }
        for a in want["absent"].as_array().unwrap() {
            let a = a.as_str().unwrap();
            if !a.is_empty() && exposed_text(&err).iter().any(|t| t.contains(a)) {
                problems.push(format!("{a:?} exposed"));
            }
        }
        if !problems.is_empty() {
            failures.push(format!("{}: {}", name(case), problems.join("; ")));
        }
    }
    report("errors", failures);
}

#[tokio::test]
async fn responses() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "responses") {
        let server = start(Script::Replies(vec![reply_for(case)])).await;
        let client = keyed(&server);
        let want = &case["expect"];
        let arg = case["arg"].as_str().unwrap();
        let problem = match (client.search(arg).await, want["error"].as_str()) {
            (Err(e), Some(kind)) => {
                (!kind_matches(&e, kind) || server.count() != 1).then(|| format!("{e:?}"))
            }
            (Ok(r), None) => {
                let mut got = Map::new();
                got.insert("query".into(), r.query.clone().into());
                got.insert("mode".into(), r.mode.clone().into());
                got.insert("request_id".into(), r.request_id.clone().into());
                let results: Vec<Value> = r
                        .results
                        .iter()
                        .map(|x| {
                            serde_json::json!({
                                "title": x.title, "url": x.url, "snippet": x.snippet,
                                // The crate has no deprecated `description` field;
                                // the API's value stays in `raw`.
                                "description": x.raw.get("description").and_then(|d| crate::models::non_blank(Some(d))),
                                "published_at": x.published_at,
                                "acquired_at": x.acquired_at,
                            })
                        })
                        .collect();
                got.insert("results".into(), results.into());
                let warnings: Vec<Value> = r
                    .warnings
                    .iter()
                    .map(|w| serde_json::json!({"code": w.code, "path": w.path, "message": w.message}))
                    .collect();
                got.insert("warnings".into(), warnings.into());
                let money = |m: &Option<crate::models::Money>| {
                    m.as_ref().map_or(
                        Value::Null,
                        |m| serde_json::json!({"amount": m.amount, "currency": m.currency}),
                    )
                };
                let usage = r.usage.as_ref().map_or(Value::Null, |u| {
                    serde_json::json!({
                        "sku": u.sku, "amount": u.amount, "credits": u.credits, "paid": u.paid,
                        "credits_remaining": u.credits_remaining,
                        "cost": money(&u.cost), "balance": money(&u.balance),
                    })
                });
                got.insert("usage".into(), usage);
                got.insert("error".into(), Value::Null);
                (as_floats(&Value::Object(got)) != as_floats(want)).then(|| format!("got {r:?}"))
            }
            (got, _) => Some(format!("{got:?}")),
        };
        if let Some(p) = problem {
            failures.push(format!("{}: {p}, want {want}", name(case)));
        }
    }
    report("responses", failures);
}

#[tokio::test]
async fn billing() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "billing") {
        let server = start(Script::Replies(vec![reply_for(case)])).await;
        let keyed_case = case["keyed"].as_bool().unwrap();
        let client = Client::with_options(Options {
            api_key: Some(if keyed_case { "k" } else { "" }.into()),
            base_url: Some(server.base_url.clone()),
            max_retries: Some(0),
            ..Default::default()
        })
        .unwrap();
        let want = &case["expect"];
        let result = client.billing().await;
        let seen = server.requests();
        let sent_ok = seen.len() == 1
            && seen[0].method == "GET"
            && seen[0].path == want["path"].as_str().unwrap()
            && seen[0].query.is_empty()
            && seen[0].body.is_empty()
            && seen[0].header("X-API-Key") == keyed_case.then_some("k");
        let problem = if !sent_ok {
            Some(format!(
                "sent {:?}",
                seen.iter()
                    .map(|r| (
                        r.method.clone(),
                        r.path.clone(),
                        r.header("X-API-Key").map(str::to_string)
                    ))
                    .collect::<Vec<_>>()
            ))
        } else {
            match (result, want["error"].as_str()) {
                (Err(e), Some(kind)) => (!kind_matches(&e, kind)).then(|| format!("{e:?}")),
                (Ok(b), None) => {
                    let mut got = serde_json::to_value(&b).unwrap();
                    let request_id = got.as_object_mut().unwrap().remove("request_id");
                    (as_floats(&got) != as_floats(&want["billing"])
                        || request_id.as_ref() != Some(&want["request_id"]))
                    .then(|| format!("got {got} with request id {request_id:?}"))
                }
                (got, _) => Some(format!("{got:?}")),
            }
        };
        if let Some(p) = problem {
            failures.push(format!("{}: {p}, want {want}", name(case)));
        }
    }
    report("billing", failures);
}

#[tokio::test]
async fn options() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "options") {
        if skipped(case).is_some() {
            continue;
        }
        let value = &case["value"];
        let client_scope = case["scope"] == "client";
        let mut client_opts = Options {
            api_key: Some("k".into()),
            ..Default::default()
        };
        let mut req = RequestOptions::default();
        let mut query = "q".to_string();
        let mut search = SearchOptions::default();
        let option = case["option"].as_str().unwrap();
        match option {
            "max_retries" => {
                let n = value.as_u64().map(|n| n as u32);
                if client_scope {
                    client_opts.max_retries = n;
                } else {
                    req.max_retries = n;
                }
            }
            "timeout" => {
                let t = value.as_f64().map(Duration::from_secs_f64);
                if client_scope {
                    client_opts.timeout = t;
                } else {
                    req.timeout = t;
                }
            }
            "headers" => {
                let h: HashMap<String, String> = serde_json::from_value(value.clone()).unwrap();
                if client_scope {
                    client_opts.headers = h;
                } else {
                    req.headers = h;
                }
            }
            "query" => query = value.as_str().unwrap().to_string(),
            "disable_cards" => search.disable_cards = value.as_bool().unwrap_or(false),
            other => {
                failures.push(format!("{}: no Rust mapping for {other}", name(case)));
                continue;
            }
        }
        let valid = case["valid"].as_bool().unwrap();
        let server = start(ok_both()).await;
        client_opts.base_url = Some(server.base_url.clone());
        let client = match Client::with_options(client_opts) {
            Ok(c) => c,
            Err(e) => {
                if valid || !matches!(e, Error::InvalidRequest(_)) {
                    failures.push(format!("{}: with_options: {e:?}", name(case)));
                }
                continue;
            }
        };
        if client_scope && !valid {
            failures.push(format!("{}: with_options accepted it", name(case)));
            continue;
        }
        search.request = req;
        let got = client.search_with(&query, &search).await;
        let ok = if valid {
            // A real socket can outlast a 1 ms deadline; the value was still
            // accepted, which is what this checks.
            (option == "timeout" && matches!(&got, Err(e) if e.is_timeout()))
                || (got.is_ok() && server.count() == 1)
        } else {
            is_invalid(&got) && server.count() == 0
        };
        if !ok {
            failures.push(format!(
                "{}: {:?} requests={}",
                name(case),
                got.err(),
                server.count()
            ));
        }
    }
    report("options", failures);
}

fn opt_string(v: &Value) -> Option<String> {
    v.as_str().map(str::to_string)
}

#[tokio::test]
async fn search_body() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "search_body") {
        if skipped(case).is_some() {
            continue;
        }
        let mut opts = SearchOptions::default();
        for (wire, v) in case["options"].as_object().unwrap() {
            match wire.as_str() {
                "mode" => opts.mode = opt_string(v),
                "site" => opts.site = opt_string(v),
                "exclude_domains" => {
                    opts.exclude_domains = Some(serde_json::from_value(v.clone()).unwrap())
                }
                "published_after" => opts.published_after = opt_string(v),
                "published_before" => opts.published_before = opt_string(v),
                "acquired_after" => opts.acquired_after = opt_string(v),
                "acquired_before" => opts.acquired_before = opt_string(v),
                "query_time" => opts.query_time = opt_string(v),
                "objective" => opts.objective = opt_string(v),
                "snippet_max_length" => opts.snippet_max_length = v.as_u64().map(|n| n as u32),
                "max_results" => opts.max_results = v.as_u64().map(|n| n as u32),
                "disable_cards" => opts.disable_cards = v.as_bool().unwrap(),
                "moderation" => opts.moderation = opt_string(v),
                other => failures.push(format!("{}: no Rust mapping for {other}", name(case))),
            }
        }
        let server = start(ok_both()).await;
        let got = keyed(&server)
            .search_with(case["query"].as_str().unwrap(), &opts)
            .await;
        let sent = only_body(&server);
        if got.is_err() || sent != case["sent"] {
            failures.push(format!("{}: {:?} sent {sent}", name(case), got.err()));
        }
    }
    report("search_body", failures);
}

fn only_body(server: &Server) -> Value {
    let seen = server.requests();
    match seen.as_slice() {
        [one] => serde_json::from_slice(&one.body).unwrap_or(Value::Null),
        _ => Value::Null,
    }
}

#[tokio::test]
async fn tool_call() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "tool_call") {
        let server = start(ok_both()).await;
        let got = keyed(&server)
            .run_tool_call("keenable_search", case["arguments"].as_str().unwrap())
            .await;
        let ok = if case["invalid"].as_bool().unwrap() {
            is_invalid(&got) && server.count() == 0
        } else {
            got.is_ok() && only_body(&server) == case["sent"]
        };
        if !ok {
            failures.push(format!(
                "{}: {:?} sent {}",
                name(case),
                got.err(),
                only_body(&server)
            ));
        }
    }
    report("tool_call", failures);
}

#[tokio::test]
async fn fetch_options_do_not_bypass_the_url_refusal() {
    let server = start(ok_both()).await;
    let opts = FetchOptions {
        max_chars: Some(10),
        max_age_hours: Some(0.0),
        ..Default::default()
    };
    let got = keyed(&server)
        .fetch_with(["http://127.0.0.1/"], &opts)
        .await;
    assert!(is_invalid(&got) && server.count() == 0, "{got:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn deadline() {
    let fixture = fixture();
    let section = &fixture["deadline"];
    let slack = Duration::from_secs_f64(section["slack"].as_f64().unwrap());
    let mut failures = Vec::new();
    for case in section["cases"].as_array().unwrap() {
        if skipped(case).is_some() {
            continue;
        }
        let interval = Duration::from_secs_f64(case["interval"].as_f64().unwrap());
        let base = deadline_server(
            case["phase"].as_str().unwrap(),
            interval,
            case["pieces"].as_u64().unwrap() as usize,
        )
        .await;
        let timeout = Duration::from_secs_f64(case["timeout"].as_f64().unwrap());
        let client = Client::with_options(Options {
            api_key: Some(String::new()),
            base_url: Some(base),
            timeout: Some(timeout),
            max_retries: Some(0),
            ..Default::default()
        })
        .unwrap();
        let started = Instant::now();
        let got = client.search("q").await;
        let elapsed = started.elapsed();
        let problem = if case["outcome"] == "timeout" {
            let low = timeout.saturating_sub(Duration::from_millis(50));
            match &got {
                Err(e) if e.is_timeout() && elapsed >= low && elapsed <= timeout + slack => None,
                _ => Some(format!("{got:?} after {elapsed:?}")),
            }
        } else {
            match &got {
                Ok(r) if r.results.is_empty() && elapsed < timeout => None,
                _ => Some(format!("{got:?} after {elapsed:?}")),
            }
        };
        if let Some(p) = problem {
            failures.push(format!("{}: {p}", name(case)));
        }
    }
    report("deadline", failures);
}

#[test]
fn webhook() {
    let fixture = fixture();
    let mut failures = Vec::new();
    for case in cases(&fixture, "webhook") {
        let mut headers = reqwest::header::HeaderMap::new();
        for (k, v) in case["headers"].as_object().unwrap() {
            headers.insert(
                reqwest::header::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                reqwest::header::HeaderValue::from_str(v.as_str().unwrap()).unwrap(),
            );
        }
        let opts = crate::WebhookOptions {
            tolerance: Some(Duration::from_secs_f64(case["tolerance"].as_f64().unwrap())),
            now: Some(std::time::UNIX_EPOCH + Duration::from_secs(case["now"].as_u64().unwrap())),
        };
        let got = crate::verify_webhook_with(
            case["body"].as_str().unwrap().as_bytes(),
            &headers,
            case["secret"].as_str().unwrap(),
            &opts,
        );
        let ok = match (&got, case["valid"].as_bool().unwrap()) {
            (Ok(event), true) => case["type"].as_str() == Some(event.event_type.as_str()),
            (Err(Error::WebhookVerification(_)), false) => true,
            _ => false,
        };
        if !ok {
            failures.push(format!("{}: {got:?}", name(case)));
        }
    }
    report("webhook", failures);
}
