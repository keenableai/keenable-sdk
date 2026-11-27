//! The client against a local server: what it sends and what it returns.

use serde_json::{json, Value};

use super::server::{start, Reply, Script};
use super::*;
use crate::{Error, FetchOptions, RequestOptions, SearchOptions};

fn search_reply() -> Reply {
    Reply::new(
        200,
        r#"{"query":"q","mode":"pro","request_id":"r1","extra":1,"results":[{"title":"T","url":"https://e.com/","snippet":"S"}]}"#,
    )
}

#[tokio::test]
async fn a_keyed_search_sends_the_key_and_the_sdk_headers() {
    let server = start(Script::Replies(vec![search_reply()])).await;
    let resp = keyed(&server).search("q").await.unwrap();
    let seen = &server.requests()[0];
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.path, "/v1/search");
    assert_eq!(seen.header("X-API-Key"), Some("k"));
    assert_eq!(seen.header("X-Keenable-Title"), Some("Keenable SDK"));
    assert_eq!(seen.header("Content-Type"), Some("application/json"));
    assert_eq!(seen.header("Accept"), Some("application/json"));
    assert_eq!(
        seen.header("User-Agent"),
        Some(crate::user_agent::USER_AGENT.as_str())
    );
    assert_eq!(resp.request_id.as_deref(), Some("r1"));
    assert_eq!(resp.raw["extra"], json!(1));
    assert_eq!(resp.to_context(), "[1] T (https://e.com/)\nS");
    assert_eq!(resp.cited().len(), 1);
}

#[tokio::test]
async fn a_keyless_client_calls_the_public_endpoints_without_a_key() {
    let server = start(Script::Replies(vec![
        search_reply(),
        Reply::new(200, r#"{"results":[{"content":"c"}]}"#),
    ]))
    .await;
    let client = Client::with_options(Options {
        api_key: Some(" ".into()),
        base_url: Some(server.base_url.clone()),
        client_source: Some("My Agent".into()),
        ..Default::default()
    })
    .unwrap();
    assert!(client.is_keyless());
    client.search("q").await.unwrap();
    let page = client.fetch(["https://example.com/a"]).await.unwrap();
    let seen = server.requests();
    assert_eq!(seen[0].path, "/v1/search/public");
    assert_eq!(seen[1].path, "/v1/fetch/public");
    assert!(seen.iter().all(|r| r.header("X-API-Key").is_none()));
    assert_eq!(seen[0].header("X-Keenable-Title"), Some("My Agent"));
    assert_eq!(page.results[0].url, "https://example.com/a");
}

#[tokio::test]
async fn call_headers_go_over_client_headers_and_never_set_the_key() {
    let server = start(Script::Replies(vec![search_reply()])).await;
    let client = Client::with_options(Options {
        api_key: Some("k".into()),
        base_url: Some(server.base_url.clone()),
        headers: [
            ("X-Gateway".to_string(), "client".to_string()),
            ("X-API-Key".into(), "nope".into()),
        ]
        .into(),
        ..Default::default()
    })
    .unwrap();
    let opts = SearchOptions {
        request: RequestOptions {
            headers: [("x-gateway".to_string(), "call".to_string())].into(),
            ..Default::default()
        },
        ..Default::default()
    };
    client.search_with("q", &opts).await.unwrap();
    let seen = &server.requests()[0];
    assert_eq!(seen.header("X-Gateway"), Some("call"));
    assert_eq!(seen.header("X-API-Key"), Some("k"));
}

#[tokio::test]
async fn a_redirect_is_not_followed() {
    let server = start(Script::Replies(vec![
        Reply::new(302, "").header("Location", "https://elsewhere.example/v1/search")
    ]))
    .await;
    let err = keyed(&server).search("q").await.unwrap_err();
    assert!(
        matches!(&err, Error::Connection(c) if c.is_redirect()),
        "{err:?}"
    );
    assert!(err.to_string().contains("https://elsewhere.example"));
    assert_eq!(server.count(), 1);
}

#[tokio::test]
async fn a_server_error_is_retried() {
    let server = start(Script::Replies(vec![Reply::new(503, "{}"), search_reply()])).await;
    let resp = keyed(&server).search("q").await.unwrap();
    assert_eq!(resp.results.len(), 1);
    assert_eq!(server.count(), 2);
    assert_eq!(crate::test_hooks::take_waits().len(), 1);
}

#[tokio::test]
async fn an_unreachable_api_is_a_connection_error() {
    let client = Client::with_options(Options {
        api_key: Some("k".into()),
        base_url: Some("http://127.0.0.1:1".into()),
        max_retries: Some(0),
        ..Default::default()
    })
    .unwrap();
    let err = client.search("q").await.unwrap_err();
    assert!(
        matches!(&err, Error::Connection(c) if !c.is_timeout()),
        "{err:?}"
    );
    assert_eq!(err.sdk_code(), "connection");
    assert!(err.to_string().ends_with("(connection)"));
}

#[tokio::test]
async fn the_keyless_rate_limit_says_how_to_lift_it() {
    let server = start(Script::Replies(vec![Reply::new(
        429,
        r#"{"error":"Rate limit exceeded"}"#,
    )
    .header("Retry-After", "3600")
    .header("X-RateLimit-Limit", "100")
    .header("X-RateLimit-Remaining", "0")]))
    .await;
    let client = Client::with_options(Options {
        api_key: Some(String::new()),
        base_url: Some(server.base_url.clone()),
        ..Default::default()
    })
    .unwrap();
    let err = client.search("q").await.unwrap_err();
    let Error::RateLimit(rate) = &err else {
        panic!("{err:?}")
    };
    assert_eq!(rate.header_limit, Some(100));
    assert_eq!(rate.header_remaining, Some(0));
    assert_eq!(rate.status_code, 429);
    assert!(err.to_string().contains("Set KEENABLE_API_KEY"), "{err}");
    // An hour is not waited out.
    assert_eq!(server.count(), 1);
}

#[tokio::test]
async fn the_environment_supplies_the_key_and_base_url() {
    let server = start(Script::Replies(vec![search_reply()])).await;
    // Every other test passes both explicitly, so this cannot leak into them.
    std::env::set_var("KEENABLE_API_KEY", " env-key ");
    std::env::set_var("KEENABLE_API_URL", format!("{}/", server.base_url));
    let client = Client::new();
    std::env::remove_var("KEENABLE_API_KEY");
    std::env::remove_var("KEENABLE_API_URL");
    client.unwrap().search("q").await.unwrap();
    let seen = &server.requests()[0];
    assert_eq!(seen.header("X-API-Key"), Some("env-key"));
    assert_eq!(seen.path, "/v1/search");
}

#[test]
fn the_tool_definitions_match_the_other_sdks() {
    let tools = serde_json::to_value(crate::tools()).unwrap();
    assert_eq!(tools[0]["type"], "function");
    assert_eq!(tools[0]["function"]["name"], "keenable_search");
    assert_eq!(tools[1]["function"]["name"], "keenable_fetch");
    assert_eq!(
        tools[0]["function"]["parameters"]["required"],
        json!(["query"])
    );
    let props = tools[0]["function"]["parameters"]["properties"]
        .as_object()
        .unwrap();
    let mut names: Vec<&str> = props.keys().map(String::as_str).collect();
    names.sort_unstable();
    assert_eq!(
        names,
        [
            "disable_cards",
            "exclude_domains",
            "moderation",
            "objective",
            "published_after",
            "query",
            "site"
        ]
    );
    assert_eq!(props["exclude_domains"]["items"], json!({"type": "string"}));
    assert_eq!(props["disable_cards"]["type"], "boolean");
    assert_eq!(props["moderation"]["type"], "string");
    assert_eq!(props["moderation"]["enum"], json!(["moderate", "strict"]));
    assert!(props["moderation"]["description"]
        .as_str()
        .unwrap()
        .contains("no moderation"));
    let max_age = &tools[1]["function"]["parameters"]["properties"]["max_age_hours"];
    assert_eq!(max_age["minimum"], json!(-1));
    assert!(max_age["description"]
        .as_str()
        .unwrap()
        .contains("-1 reads only the stored copy"));
}

#[tokio::test]
async fn search_sends_moderation_only_when_set() {
    let server = start(Script::Replies(vec![search_reply(), search_reply()])).await;
    let client = keyed(&server);
    let opts = SearchOptions {
        mode: Some("realtime".into()),
        moderation: Some("strict".into()),
        ..Default::default()
    };
    client.search_with("q", &opts).await.unwrap();
    client.search("q").await.unwrap();
    let first: Value = serde_json::from_slice(&server.requests()[0].body).unwrap();
    assert_eq!(
        first,
        json!({"query": "q", "mode": "realtime", "moderation": "strict"})
    );
    let second: Value = serde_json::from_slice(&server.requests()[1].body).unwrap();
    assert!(second.get("moderation").is_none());
}

#[tokio::test]
async fn search_parses_warnings() {
    let server = start(Script::Replies(vec![
        Reply::new(
            200,
            r#"{"query":"q","results":[],"warnings":[{"code":"deprecated_parameter","path":"/safety_mode","message":"safety_mode is deprecated. Use moderation."}]}"#,
        ),
        search_reply(),
    ]))
    .await;
    let client = keyed(&server);
    let resp = client.search("q").await.unwrap();
    assert_eq!(resp.warnings.len(), 1);
    assert_eq!(resp.warnings[0].code, "deprecated_parameter");
    assert_eq!(resp.warnings[0].path, "/safety_mode");
    assert_eq!(
        resp.warnings[0].message,
        "safety_mode is deprecated. Use moderation."
    );
    assert!(client.search("q").await.unwrap().warnings.is_empty());
}

#[tokio::test]
async fn fetch_posts_the_urls_and_only_the_options_set() {
    let server = start(Script::Replies(vec![
        Reply::new(200, r#"{"results":[]}"#),
        Reply::new(200, r#"{"results":[]}"#),
    ]))
    .await;
    let opts = FetchOptions {
        max_chars: Some(500),
        prompt: Some("List the prices".into()),
        schema: Some(json!({"type": "object"})),
        links: Some(5),
        images: Some(2),
        max_age_hours: Some(0.0),
        ..Default::default()
    };
    let client = keyed(&server);
    client
        .fetch_with(["https://example.com"], &opts)
        .await
        .unwrap();
    let empty_prompt = FetchOptions {
        prompt: Some(String::new()),
        ..Default::default()
    };
    client
        .fetch_with(["https://example.com"], &empty_prompt)
        .await
        .unwrap();
    let seen = &server.requests()[0];
    assert_eq!(
        (seen.method.as_str(), seen.path.as_str()),
        ("POST", "/v1/fetch")
    );
    let body: Value = serde_json::from_slice(&seen.body).unwrap();
    assert_eq!(
        body,
        json!({
            "urls": ["https://example.com"],
            "content": {
                "max_chars": 500,
                "prompt": "List the prices",
                "schema": {"type": "object"},
                "links": 5,
                "images": 2,
            },
            "retrieval": {"max_age_hours": 0.0},
        })
    );
    let body: Value = serde_json::from_slice(&server.requests()[1].body).unwrap();
    assert_eq!(body, json!({"urls": ["https://example.com"]}));
}

#[tokio::test]
async fn fetch_parses_a_page_and_a_failed_url() {
    let server = start(Script::Replies(vec![Reply::new(
        200,
        r#"{"results":[{"url":"https://e.com/","title":"T","content":"Body"},{"url":"https://e.com/x","error":{"status":404,"error":"Not found","code":"page_not_found"}},{"url":"https://e.com/y","error":{"message":"gone"}}]}"#,
    )]))
    .await;
    let resp = keyed(&server)
        .fetch(["https://e.com/", "https://e.com/x", "https://e.com/y"])
        .await
        .unwrap();
    let (page, missing) = (&resp.results[0], &resp.results[1]);
    assert_eq!((page.title.as_str(), page.content.as_str()), ("T", "Body"));
    assert!(page.error.is_none());
    assert_eq!(missing.url, "https://e.com/x");
    let error = missing.error.as_ref().unwrap();
    assert_eq!(
        (error.status, error.code.as_deref()),
        (404, Some("page_not_found"))
    );
    let partial = resp.results[2].error.as_ref().unwrap();
    assert_eq!(
        (partial.status, partial.message.as_deref()),
        (0, Some("gone"))
    );
}

#[tokio::test]
async fn a_fetch_tool_call_renders_the_page() {
    let server = start(Script::Replies(vec![Reply::new(
        200,
        r#"{"results":[{"url":"https://e.com/","title":"T","content":"Body","published_at":1714564800}]}"#,
    )]))
    .await;
    let text = keyed(&server)
        .run_tool_call("keenable_fetch", json!({"urls": ["https://e.com/"]}))
        .await
        .unwrap();
    assert_eq!(
        text,
        "[1] T (https://e.com/) - published 2024-05-01T12:00:00Z\nBody"
    );
}

#[tokio::test]
async fn a_fetch_tool_call_reads_several_urls_and_keeps_a_failed_one() {
    let server = start(Script::Replies(vec![Reply::new(
        200,
        r#"{"results":[{"url":"https://e.com/","title":"T","content":"Body"},{"url":"https://e.com/x","error":{"status":404,"error":"Not found"}}]}"#,
    )]))
    .await;
    let text = keyed(&server)
        .run_tool_call(
            "keenable_fetch",
            json!({"urls": ["https://e.com/", "https://e.com/x"], "max_chars": 500,
                   "prompt": "Who runs it?", "max_age_hours": 0}),
        )
        .await
        .unwrap();
    let body: Value = serde_json::from_slice(&server.requests()[0].body).unwrap();
    assert_eq!(
        body,
        json!({
            "urls": ["https://e.com/", "https://e.com/x"],
            "content": {"max_chars": 500, "prompt": "Who runs it?"},
            "retrieval": {"max_age_hours": 0.0},
        })
    );
    assert_eq!(
        text,
        "[1] T (https://e.com/)\nBody\n\n[2] https://e.com/x - failed: Not found"
    );
}

#[tokio::test]
async fn a_bad_tool_call_sends_nothing() {
    let server = start(Script::Replies(vec![search_reply()])).await;
    let client = keyed(&server);
    for (name, args) in [
        ("keenable_search", Value::from("{}")),
        ("keenable_search", Value::from("[1]")),
        ("keenable_search", Value::from("not json")),
        ("keenable_fetch", Value::from(r#"{"url":"https://e.com/"}"#)),
        ("other_tool", Value::from(r#"{"query":"q"}"#)),
    ] {
        let got = client.run_tool_call(name, args.as_str().unwrap()).await;
        assert!(
            matches!(got, Err(Error::InvalidRequest(_))),
            "{name} {args}: {got:?}"
        );
    }
    let got = client
        .run_tool_call("keenable_fetch", json!({"url": "https://e.com/"}))
        .await;
    assert!(
        matches!(&got, Err(Error::InvalidRequest(m)) if m.to_string().contains("'urls'")),
        "{got:?}"
    );
    assert_eq!(server.count(), 0);
}

#[tokio::test]
async fn a_tool_call_with_a_moderation_that_is_not_a_string_sends_nothing() {
    let server = start(Script::Replies(vec![search_reply()])).await;
    let client = keyed(&server);
    for moderation in [
        json!(true),
        json!(false),
        json!(1),
        json!(["strict"]),
        json!({"level": "strict"}),
    ] {
        let got = client
            .run_tool_call(
                "keenable_search",
                json!({"query": "q", "moderation": moderation}),
            )
            .await;
        assert!(
            matches!(&got, Err(Error::InvalidRequest(m)) if m.to_string().contains(r#"moderation must be "moderate" or "strict""#)),
            "{moderation}: {got:?}"
        );
    }
    assert_eq!(server.count(), 0);
}

#[test]
fn debug_output_never_shows_the_api_key() {
    let opts = Options {
        api_key: Some("keen_secret_value".into()),
        headers: [("X-Gateway".to_string(), "header-secret".to_string())].into(),
        ..Default::default()
    };
    let shown = format!("{opts:?}");
    assert!(
        !shown.contains("keen_secret_value") && !shown.contains("header-secret"),
        "{shown}"
    );
    assert!(shown.contains("<redacted>"), "{shown}");
    let client = Client::with_options(opts).unwrap();
    let shown = format!("{client:?}");
    assert!(
        !shown.contains("keen_secret_value") && !shown.contains("header-secret"),
        "{shown}"
    );
    assert!(shown.contains("<redacted>"), "{shown}");
    let keyless = Client::with_options(Options {
        api_key: Some(String::new()),
        ..Default::default()
    })
    .unwrap();
    assert!(format!("{keyless:?}").contains("<empty>"));
}

#[tokio::test]
async fn parsed_null_arguments_are_rejected_like_the_text_null() {
    let server = start(Script::Replies(vec![search_reply()])).await;
    let client = keyed(&server);
    let parsed = client.run_tool_call("keenable_search", Value::Null).await;
    let text = client.run_tool_call("keenable_search", "null").await;
    for got in [parsed, text] {
        let Err(Error::InvalidRequest(e)) = got else {
            panic!("{got:?}")
        };
        assert!(e.to_string().contains("must be a JSON object"), "{e}");
    }
    assert_eq!(server.count(), 0);
}

#[tokio::test]
async fn billing_retries_and_sends_the_call_headers() {
    let server = start(Script::Replies(vec![
        Reply::new(503, "{}"),
        Reply::new(200, r#"{"object":"billing","prices":[],"account":null}"#),
    ]))
    .await;
    let opts = RequestOptions {
        max_retries: Some(1),
        headers: [("X-Trace".to_string(), "t".to_string())].into(),
        ..Default::default()
    };
    let billing = keyed(&server).billing_with(&opts).await.unwrap();
    assert!(billing.prices.is_empty());
    assert!(billing.account.is_none());
    assert_eq!(crate::test_hooks::take_waits().len(), 1);
    let seen = server.requests();
    assert!(seen.iter().all(|r| r.path == "/v1/billing"));
    assert_eq!(seen[1].header("X-Trace"), Some("t"));
    assert_eq!(seen[1].header("X-API-Key"), Some("k"));
}
