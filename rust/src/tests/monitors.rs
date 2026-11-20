//! Monitors and verify_webhook against a local server.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::server::{start, Reply, Script};
use super::*;
use crate::{
    BulkFilter, Error, MonitorBulkParams, MonitorCreateParams, MonitorListParams,
    MonitorPageParams, MonitorPageTarget, MonitorResultsParams, MonitorRunOutputError,
    MonitorScheduleParams, MonitorSearchParams, MonitorUpdateParams, MonitorVersionsParams,
    MonitorWebhookParams,
};

fn monitor() -> Value {
    json!({
        "id": "mon_1", "object": "monitor", "name": "LLM releases", "status": "active",
        "search": {"query": "new open-weights LLM releases", "max_results": 10, "include_domains": null,
                   "exclude_domains": ["example.com"], "content": {"text": true}},
        "schedule": {"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
        "output_schema": null,
        "webhook": {"url": "https://hooks.example.com/k", "events": ["monitor.result.found"], "secret": "whsec_abc"},
        "metadata": {"team": "research"},
        "last_run_at": null, "next_run_at": "2026-11-18T08:00:00Z",
        "upcoming_runs": ["2026-11-18T08:00:00Z"],
        "created_at": "2026-11-17T10:00:00Z", "updated_at": "2026-11-17T10:00:00Z"
    })
}

fn result() -> Value {
    json!({
        "url": "https://example.org/a", "title": "A model", "author": null,
        "published_at": "2026-11-17T09:00:00Z", "acquired_at": "2026-11-17T09:05:00Z",
        "image": null, "matched_at": "2026-11-17T09:10:00Z",
        "published_at_source": "declared", "summary": "A lab released a model.", "importance": 4,
        "kind": "news", "source_type": "original"
    })
}

fn run() -> Value {
    json!({
        "id": "mrun_1", "object": "monitor_run", "monitor_id": "mon_1", "status": "completed",
        "results": [result()], "changes": null,
        "output": {"structured": {"n": 1}, "text": null, "grounding": []},
        "error": null, "created_at": "2026-11-17T10:00:00Z",
        "started_at": "2026-11-17T10:00:01Z", "ended_at": "2026-11-17T10:00:09Z"
    })
}

fn ok(status: u16, body: Value) -> Reply {
    Reply::new(status, &body.to_string())
}

fn body(seen: &super::server::Seen) -> Value {
    serde_json::from_slice(&seen.body).unwrap()
}

#[tokio::test]
async fn create_sends_the_body_and_an_idempotency_key() {
    let server = start(Script::Replies(vec![ok(201, monitor())])).await;
    let client = keyed(&server);
    let m = client
        .monitors()
        .create(&MonitorCreateParams {
            search: MonitorSearchParams {
                exclude_domains: Some(vec!["x.com".into()]),
                content_text: Some(true),
                ..MonitorSearchParams::new("new open-weights LLM releases")
            },
            name: Some("LLM releases".into()),
            schedule: Some(MonitorScheduleParams {
                schedule_type: "cron".into(),
                value: Some("0 9 * * 1-5".into()),
                timezone: Some("Europe/Paris".into()),
            }),
            webhook: Some(MonitorWebhookParams {
                url: Some("https://hooks.example.com/k".into()),
                events: Some(vec!["monitor.result.found".into()]),
            }),
            metadata: Some(HashMap::from([("team".into(), "research".into())])),
            ..Default::default()
        })
        .await
        .unwrap();
    let seen = &server.requests()[0];
    assert_eq!(seen.method, "POST");
    assert_eq!(seen.path, "/v1/monitors");
    assert_eq!(seen.header("X-API-Key"), Some("k"));
    assert_eq!(seen.header("Idempotency-Key").map(str::len), Some(36));
    assert_eq!(
        body(seen),
        json!({
            "search": {"query": "new open-weights LLM releases", "exclude_domains": ["x.com"], "content": {"text": true}},
            "name": "LLM releases",
            "schedule": {"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
            "webhook": {"url": "https://hooks.example.com/k", "events": ["monitor.result.found"]},
            "metadata": {"team": "research"}
        })
    );
    assert_eq!(m.id, "mon_1");
    let search = m.search.unwrap();
    assert!(search.content_text);
    assert_eq!(
        search.exclude_domains,
        Some(vec!["example.com".to_string()])
    );
    assert_eq!(m.monitor_type, "search");
    assert!(m.page.is_none());
    assert_eq!(m.webhook.unwrap().secret.as_deref(), Some("whsec_abc"));
    assert_eq!(
        m.schedule.unwrap().timezone.as_deref(),
        Some("Europe/Paris")
    );
    assert_eq!(m.metadata.unwrap()["team"], "research");
    assert_eq!(m.raw["id"], json!("mon_1"));
}

#[tokio::test]
async fn create_retries_with_the_same_key() {
    let server = start(Script::Replies(vec![
        ok(503, json!({})),
        ok(201, monitor()),
    ]))
    .await;
    keyed(&server)
        .monitors()
        .create(&MonitorCreateParams {
            search: MonitorSearchParams::new("q"),
            idempotency_key: Some("key-1".into()),
            ..Default::default()
        })
        .await
        .unwrap();
    let seen = server.requests();
    assert_eq!(seen.len(), 2);
    assert!(seen
        .iter()
        .all(|r| r.header("Idempotency-Key") == Some("key-1")));
}

#[tokio::test]
async fn create_needs_a_query_and_monitors_need_a_key() {
    let server = start(Script::Replies(vec![ok(201, monitor())])).await;
    let err = keyed(&server)
        .monitors()
        .create(&MonitorCreateParams::default())
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidRequest(_)));
    let keyless = Client::with_options(Options {
        api_key: Some(String::new()),
        base_url: Some(server.base_url.clone()),
        ..Default::default()
    })
    .unwrap();
    let err = keyless.monitors().get("mon_1").await.unwrap_err();
    assert!(matches!(err, Error::Auth(_)));
    assert_eq!(
        err.api_error().unwrap().code.as_deref(),
        Some("missing_api_key")
    );
    assert_eq!(server.count(), 0);
}

#[tokio::test]
async fn list_all_follows_the_cursor() {
    let mut second = monitor();
    second["id"] = json!("mon_2");
    let server = start(Script::Replies(vec![
        ok(
            200,
            json!({"data": [monitor()], "has_more": true, "next_cursor": "c1"}),
        ),
        ok(
            200,
            json!({"data": [second], "has_more": false, "next_cursor": null}),
        ),
    ]))
    .await;
    let client = keyed(&server);
    let monitors = client.monitors();
    let mut pager = monitors.list_all(&MonitorListParams {
        status: Some("active".into()),
        metadata: HashMap::from([("team".into(), "research".into())]),
        limit: Some(1),
        ..Default::default()
    });
    let mut ids = Vec::new();
    while let Some(m) = pager.next().await.unwrap() {
        ids.push(m.id);
    }
    assert_eq!(ids, ["mon_1", "mon_2"]);
    let seen = server.requests();
    assert_eq!(
        seen[0].query,
        [
            ("status".to_string(), "active".to_string()),
            ("metadata[team]".to_string(), "research".to_string()),
            ("limit".to_string(), "1".to_string()),
        ]
    );
    assert!(seen[1]
        .query
        .contains(&("cursor".to_string(), "c1".to_string())));
}

#[tokio::test]
async fn paths_get_delete_update_pause_resume() {
    let server = start(Script::Replies(vec![ok(200, monitor())])).await;
    let client = keyed(&server);
    let monitors = client.monitors();
    monitors.get("mon/1").await.unwrap();
    monitors.delete("mon_1").await.unwrap();
    monitors
        .update(
            "mon_1",
            &MonitorUpdateParams {
                name: Some(Some("New".into())),
                schedule: Some(None),
                search: Some(MonitorSearchParams {
                    max_results: Some(5),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    monitors.pause("mon_1").await.unwrap();
    monitors.resume("mon_1").await.unwrap();
    monitors
        .update(
            "mon_1",
            &MonitorUpdateParams {
                name: Some(None),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let seen = server.requests();
    assert_eq!(seen[0].path, "/v1/monitors/mon%2F1");
    assert_eq!(seen[1].method, "DELETE");
    assert_eq!(seen[2].method, "PATCH");
    assert_eq!(
        body(&seen[2]),
        json!({"name": "New", "schedule": null, "search": {"max_results": 5}})
    );
    assert_eq!(body(&seen[3]), json!({"status": "paused"}));
    assert_eq!(body(&seen[4]), json!({"status": "active"}));
    assert_eq!(body(&seen[5]), json!({"name": null}));
}

#[tokio::test]
async fn unsafe_calls_are_not_retried_on_a_5xx() {
    let server = start(Script::Replies(vec![ok(503, json!({}))])).await;
    let client = keyed(&server);
    let monitors = client.monitors();
    assert!(monitors
        .update(
            "mon_1",
            &MonitorUpdateParams {
                name: Some(Some("x".into())),
                ..Default::default()
            }
        )
        .await
        .is_err());
    assert!(monitors.trigger("mon_1").await.is_err());
    assert!(monitors
        .bulk(
            "pause",
            &MonitorBulkParams {
                ids: Some(vec!["mon_1".into()]),
                ..Default::default()
            }
        )
        .await
        .is_err());
    assert_eq!(server.count(), 3);
}

#[tokio::test]
async fn trigger_is_retried_on_a_429() {
    let mut queued = run();
    queued["status"] = json!("queued");
    queued["results"] = Value::Null;
    let server = start(Script::Replies(vec![ok(429, json!({})), ok(200, queued)])).await;
    let r = keyed(&server).monitors().trigger("mon_1").await.unwrap();
    let seen = server.requests();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[0].path, "/v1/monitors/mon_1/trigger");
    assert_eq!(r.status, "queued");
    assert_eq!(r.results, None);
}

#[tokio::test]
async fn reads() {
    let mut hit = result();
    hit["id"] = json!("h1");
    hit["same_story"] = json!(2);
    let delivery = json!({
        "id": "evt_1", "type": "monitor.result.found", "url": "https://hooks.example.com/k",
        "created_at": "2026-11-17T10:00:00Z", "attempts": 2, "delivered_at": null,
        "last_error": "HTTP 500", "next_attempt_at": null
    });
    let page = |items: Value| json!({"data": items, "has_more": false, "next_cursor": null});
    let server = start(Script::Replies(vec![
        ok(200, page(json!([run()]))),
        ok(200, run()),
        ok(200, page(json!([hit]))),
        ok(200, page(json!([delivery]))),
        ok(200, json!({"total": 3, "by_status": {"active": 2}, "by_schedule": {"manual": 3}})),
        ok(200, json!({"action": "pause", "affected": 1, "ids": ["mon_1"], "dry_run": true, "has_more": false, "not_found": ["mon_x"]})),
    ]))
    .await;
    let client = keyed(&server);
    let monitors = client.monitors();
    let runs = monitors
        .runs(
            "mon_1",
            &MonitorPageParams {
                limit: Some(5),
                cursor: Some("r0".into()),
            },
        )
        .await
        .unwrap();
    let r = monitors.run("mon_1", "mrun_1").await.unwrap();
    let results = monitors
        .results(
            "mon_1",
            &MonitorResultsParams {
                min_importance: Some(4),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let deliveries = monitors
        .deliveries("mon_1", &MonitorPageParams::default())
        .await
        .unwrap();
    let stats = monitors.stats().await.unwrap();
    let bulk = monitors
        .bulk(
            "pause",
            &MonitorBulkParams {
                ids: Some(vec!["mon_1".into(), "mon_x".into()]),
                filter: Some(BulkFilter {
                    status: Some("active".into()),
                    name: Some(String::new()),
                    metadata: Some(HashMap::new()),
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let seen = server.requests();
    let paths: Vec<&str> = seen.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(
        paths,
        [
            "/v1/monitors/mon_1/runs",
            "/v1/monitors/mon_1/runs/mrun_1",
            "/v1/monitors/mon_1/results",
            "/v1/monitors/mon_1/deliveries",
            "/v1/monitors/stats",
            "/v1/monitors/bulk",
        ]
    );
    assert_eq!(
        seen[0].query,
        [
            ("limit".to_string(), "5".to_string()),
            ("cursor".to_string(), "r0".to_string())
        ]
    );
    assert_eq!(
        seen[2].query,
        [("min_importance".to_string(), "4".to_string())]
    );
    assert_eq!(
        body(&seen[5]),
        json!({"action": "pause", "dry_run": true, "ids": ["mon_1", "mon_x"], "filter": {"status": "active"}})
    );
    assert_eq!(runs.data[0].monitor_id, "mon_1");
    assert_eq!(r.results.as_ref().unwrap()[0].importance, Some(4));
    assert_eq!(r.output.as_ref().unwrap().structured, Some(json!({"n": 1})));
    assert_eq!(results.data[0].id.as_deref(), Some("h1"));
    assert_eq!(results.data[0].same_story, Some(2));
    assert_eq!(results.data[0].source_type.as_deref(), Some("original"));
    assert_eq!(deliveries.data[0].last_error.as_deref(), Some("HTTP 500"));
    assert_eq!(stats.by_status["active"], 2);
    assert!(bulk.dry_run);
    assert_eq!(bulk.not_found, ["mon_x"]);
}

#[tokio::test]
async fn bulk_checks_its_arguments() {
    let server = start(Script::Replies(vec![ok(200, json!({}))])).await;
    let client = keyed(&server);
    let ids = MonitorBulkParams {
        ids: Some(vec!["mon_1".into()]),
        ..Default::default()
    };
    assert!(matches!(
        client.monitors().bulk("archive", &ids).await,
        Err(Error::InvalidRequest(_))
    ));
    assert!(matches!(
        client
            .monitors()
            .bulk("pause", &MonitorBulkParams::default())
            .await,
        Err(Error::InvalidRequest(_))
    ));
    let empty = MonitorBulkParams {
        filter: Some(BulkFilter {
            status: Some(String::new()),
            name: Some(String::new()),
            metadata: Some(Default::default()),
        }),
        ..Default::default()
    };
    assert!(matches!(
        client.monitors().bulk("pause", &empty).await,
        Err(Error::InvalidRequest(_))
    ));
    assert_eq!(server.count(), 0);
}

#[tokio::test]
async fn dot_ids_are_refused() {
    let server = start(Script::Replies(vec![ok(200, monitor())])).await;
    let client = keyed(&server);
    let monitors = client.monitors();
    for id in [".", ".."] {
        assert!(matches!(
            monitors.get(id).await,
            Err(Error::InvalidRequest(_))
        ));
        assert!(matches!(
            monitors.delete(id).await,
            Err(Error::InvalidRequest(_))
        ));
    }
    assert_eq!(server.count(), 0);
}

const WEBHOOK_BODY: &str = r#"{"id":"msg_2nY8kTestVector01","type":"monitor.result.found","created_at":"2026-11-17T17:20:00Z","data":{"monitor_id":"mon_test01","result":{"url":"https://example.com/news/1","title":"Open weights model released","author":null,"published_at":"2026-11-17T16:00:00Z","acquired_at":"2026-11-17T16:05:00Z","image":null,"matched_at":"2026-11-17T16:10:00Z","published_at_source":"declared","summary":"A lab released an open-weights model.","importance":4,"kind":"news","source_type":"original"}},"metadata":{"team":"research"}}"#;
const WEBHOOK_SECRET: &str = "whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE=";

fn webhook_headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert("webhook-id", "msg_2nY8kTestVector01".parse().unwrap());
    h.insert("webhook-timestamp", "1763400000".parse().unwrap());
    h.insert(
        "webhook-signature",
        "v1,ifN2KIni7msErjuVooGtcP9OlWfUymaJfl41PUpTBMc="
            .parse()
            .unwrap(),
    );
    h
}

#[test]
fn verify_webhook_with_the_known_vector() {
    let event = crate::verify_webhook_with(
        WEBHOOK_BODY.as_bytes(),
        &webhook_headers(),
        WEBHOOK_SECRET,
        &crate::WebhookOptions {
            now: Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_763_400_000)),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(event.id, "msg_2nY8kTestVector01");
    assert_eq!(event.event_type, "monitor.result.found");
    assert_eq!(event.data.monitor_id, "mon_test01");
    let result = event.data.result.unwrap();
    assert_eq!(result.url, "https://example.com/news/1");
    assert_eq!(result.importance, Some(4));
    assert_eq!(event.metadata.unwrap()["team"], "research");
}

#[test]
fn verify_webhook_refuses_a_stale_delivery_by_the_clock() {
    let err = crate::verify_webhook(WEBHOOK_BODY.as_bytes(), &webhook_headers(), WEBHOOK_SECRET)
        .unwrap_err();
    assert!(matches!(err, Error::WebhookVerification(_)));
    assert_eq!(err.sdk_code(), "webhook_verification");
}

#[test]
fn verify_webhook_refuses_an_empty_key_and_a_long_timestamp() {
    let opts = crate::WebhookOptions {
        now: Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_763_400_000)),
        ..Default::default()
    };
    let err =
        crate::verify_webhook_with(WEBHOOK_BODY.as_bytes(), &webhook_headers(), "whsec_", &opts)
            .unwrap_err();
    assert!(matches!(err, Error::WebhookVerification(_)));
    let mut headers = webhook_headers();
    headers.insert("webhook-timestamp", "1".repeat(400).parse().unwrap());
    let err = crate::verify_webhook_with(WEBHOOK_BODY.as_bytes(), &headers, WEBHOOK_SECRET, &opts)
        .unwrap_err();
    assert!(matches!(err, Error::WebhookVerification(_)));
    assert!(err.to_string().contains("not a Unix time"));
}

fn page_monitor() -> Value {
    let mut m = monitor();
    m["id"] = json!("mon_p");
    m["type"] = json!("page");
    m["search"] = Value::Null;
    m["page"] = json!({"url": "https://example.com/pricing", "watch_for": "plan prices", "sensitivity": "meaningful"});
    m["webhook"] = Value::Null;
    m["status"] = json!("disabled");
    m["disabled_reason"] = json!({"code": "data_policy", "message": "The organization turned on zero data retention."});
    m
}

fn diff() -> Value {
    json!({"previous_at": "2026-11-17T08:00:00Z", "ratio": 0.12,
           "added": ["Pro: $30/month"], "removed": ["Pro: $25/month"]})
}

fn page_run() -> Value {
    let mut r = run();
    r["id"] = json!("mrun_p");
    r["monitor_id"] = json!("mon_p");
    r["results"] = json!([]);
    r["changes"] = json!({
        "changed": true, "notified": true, "baseline": false, "version": 3, "source": "live",
        "summary": "The Pro plan went from $25 to $30 a month.", "items": ["Pro: $30/month"],
        "diff": diff()
    });
    r["output"] = json!({
        "structured": null, "text": null, "grounding": [], "fresh": false,
        "error": {"code": "output_invalid", "message": "missing field price"}
    });
    r
}

fn version() -> Value {
    json!({
        "id": "ver_3", "object": "page_version", "version": 3, "fetched_at": "2026-11-18T08:00:00Z",
        "title": "Pricing", "source": "live", "notified": true,
        "summary": "The Pro plan went from $25 to $30 a month.", "items": ["Pro: $30/month"],
        "diff": diff()
    })
}

#[tokio::test]
async fn create_a_page_monitor() {
    let server = start(Script::Replies(vec![ok(201, page_monitor())])).await;
    let client = keyed(&server);
    let m = client
        .monitors()
        .create(&MonitorCreateParams {
            monitor_type: Some("page".into()),
            page: Some(MonitorPageTarget {
                watch_for: Some("plan prices".into()),
                sensitivity: Some("any".into()),
                ..MonitorPageTarget::new("https://example.com/pricing")
            }),
            schedule: Some(MonitorScheduleParams {
                schedule_type: "interval".into(),
                value: Some("10m".into()),
                timezone: None,
            }),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        body(&server.requests()[0]),
        json!({
            "type": "page",
            "page": {"url": "https://example.com/pricing", "watch_for": "plan prices", "sensitivity": "any"},
            "schedule": {"type": "interval", "value": "10m"}
        })
    );
    assert_eq!(m.monitor_type, "page");
    assert!(m.search.is_none());
    assert_eq!(
        m.page,
        Some(MonitorPageTarget {
            url: "https://example.com/pricing".into(),
            watch_for: Some("plan prices".into()),
            sensitivity: Some("meaningful".into()),
        })
    );
    assert_eq!(m.disabled_reason.unwrap().code, "data_policy");
}

#[tokio::test]
async fn create_sends_type_search_when_given() {
    let server = start(Script::Replies(vec![ok(201, monitor())])).await;
    keyed(&server)
        .monitors()
        .create(&MonitorCreateParams {
            monitor_type: Some("search".into()),
            search: MonitorSearchParams::new("q"),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(
        body(&server.requests()[0]),
        json!({"type": "search", "search": {"query": "q"}})
    );
}

#[tokio::test]
async fn create_checks_the_kind_of_monitor() {
    let server = start(Script::Replies(vec![ok(201, monitor())])).await;
    let client = keyed(&server);
    let page = || Some(MonitorPageTarget::new("https://example.com"));
    let cases = [
        MonitorCreateParams {
            monitor_type: Some("page".into()),
            ..Default::default()
        },
        MonitorCreateParams {
            monitor_type: Some("page".into()),
            page: Some(MonitorPageTarget::new(" ")),
            ..Default::default()
        },
        MonitorCreateParams {
            monitor_type: Some("page".into()),
            page: page(),
            search: MonitorSearchParams::new("q"),
            ..Default::default()
        },
        MonitorCreateParams {
            search: MonitorSearchParams::new("q"),
            page: page(),
            ..Default::default()
        },
        MonitorCreateParams {
            monitor_type: Some("feed".into()),
            search: MonitorSearchParams::new("q"),
            ..Default::default()
        },
    ];
    for params in &cases {
        let err = client.monitors().create(params).await.unwrap_err();
        assert!(matches!(err, Error::InvalidRequest(_)), "{params:?}");
    }
    assert_eq!(server.count(), 0);
}

#[tokio::test]
async fn update_sends_page() {
    let server = start(Script::Replies(vec![ok(200, page_monitor())])).await;
    let client = keyed(&server);
    client
        .monitors()
        .update(
            "mon_p",
            &MonitorUpdateParams {
                page: Some(MonitorPageTarget {
                    watch_for: Some(String::new()),
                    sensitivity: Some("any".into()),
                    ..Default::default()
                }),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    client
        .monitors()
        .update(
            "mon_p",
            &MonitorUpdateParams {
                page: Some(MonitorPageTarget::new("https://example.com/plans")),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let seen = server.requests();
    assert_eq!(
        body(&seen[0]),
        json!({"page": {"watch_for": null, "sensitivity": "any"}})
    );
    assert_eq!(
        body(&seen[1]),
        json!({"page": {"url": "https://example.com/plans"}})
    );
}

#[tokio::test]
async fn a_page_run_has_changes_and_output() {
    let mut bare = run();
    bare["output"] = json!({"structured": null, "error": "output_failed"});
    let server = start(Script::Replies(vec![
        ok(200, page_run()),
        ok(200, run()),
        ok(200, bare),
    ]))
    .await;
    let client = keyed(&server);
    let r = client.monitors().run("mon_p", "mrun_p").await.unwrap();
    let changes = r.changes.unwrap();
    assert!(changes.changed && changes.notified && !changes.baseline);
    assert_eq!(changes.version, Some(3));
    assert_eq!(changes.source.as_deref(), Some("live"));
    assert_eq!(changes.items, ["Pro: $30/month"]);
    let d = changes.diff.unwrap();
    assert_eq!(d.ratio, Some(0.12));
    assert_eq!(d.removed, ["Pro: $25/month"]);
    let output = r.output.unwrap();
    assert!(!output.fresh);
    let error = output.error.unwrap();
    assert_eq!(
        (error.code.as_str(), error.message.as_str()),
        ("output_invalid", "missing field price")
    );

    let search = client.monitors().run("mon_1", "mrun_1").await.unwrap();
    assert!(search.changes.is_none());
    let output = search.output.unwrap();
    assert!(output.fresh && output.error.is_none());

    let bare = client.monitors().run("mon_1", "mrun_2").await.unwrap();
    let error: MonitorRunOutputError = bare.output.unwrap().error.unwrap();
    assert_eq!(error.code, "output_failed");
    assert_eq!(error.message, "");
}

#[tokio::test]
async fn versions() {
    let mut first = version();
    first["id"] = json!("ver_1");
    first["version"] = json!(1);
    first["notified"] = json!(false);
    first["summary"] = Value::Null;
    first["items"] = json!([]);
    first["diff"] = Value::Null;
    let server = start(Script::Replies(vec![ok(
        200,
        json!({"data": [version(), first], "has_more": true, "next_cursor": "ver_1"}),
    )]))
    .await;
    let client = keyed(&server);
    let list = client
        .monitors()
        .versions(
            "mon_p",
            &MonitorVersionsParams {
                limit: Some(2),
                cursor: Some("ver_4".into()),
            },
        )
        .await
        .unwrap();
    let seen = server.requests();
    assert_eq!(seen[0].method, "GET");
    assert_eq!(seen[0].path, "/v1/monitors/mon_p/versions");
    assert_eq!(
        seen[0].query,
        [
            ("limit".to_string(), "2".to_string()),
            ("cursor".to_string(), "ver_4".to_string())
        ]
    );
    assert!(list.has_more);
    assert_eq!(list.next_cursor.as_deref(), Some("ver_1"));
    let v = &list.data[0];
    assert_eq!(
        (v.version, v.source.as_str(), v.notified),
        (3, "live", true)
    );
    assert_eq!(v.diff.as_ref().unwrap().added, ["Pro: $30/month"]);
    assert!(list.data[1].diff.is_none() && list.data[1].items.is_empty());
    let err = client
        .monitors()
        .versions("..", &Default::default())
        .await
        .unwrap_err();
    assert!(matches!(err, Error::InvalidRequest(_)));
    assert_eq!(server.count(), 1);
}

#[test]
fn verify_webhook_reads_a_page_changed() {
    use base64::Engine;
    use hmac::Mac;
    let body = json!({
        "id": "msg_change1", "type": "monitor.page.changed", "created_at": "2026-11-18T08:00:05Z",
        "data": {"monitor_id": "mon_p", "run": page_run()}, "metadata": null
    })
    .to_string();
    let key = base64::engine::general_purpose::STANDARD
        .decode(WEBHOOK_SECRET.trim_start_matches("whsec_"))
        .unwrap();
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(&key).unwrap();
    mac.update(format!("msg_change1.1763452805.{body}").as_bytes());
    let signature = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    let mut h = reqwest::header::HeaderMap::new();
    h.insert("webhook-id", "msg_change1".parse().unwrap());
    h.insert("webhook-timestamp", "1763452805".parse().unwrap());
    h.insert(
        "webhook-signature",
        format!("v1,{signature}").parse().unwrap(),
    );
    let event = crate::verify_webhook_with(
        body.as_bytes(),
        &h,
        WEBHOOK_SECRET,
        &crate::WebhookOptions {
            now: Some(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_763_452_805)),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(event.event_type, "monitor.page.changed");
    assert!(event.data.result.is_none());
    let changes = event.data.run.unwrap().changes.unwrap();
    assert_eq!(
        changes.summary.as_deref(),
        Some("The Pro plan went from $25 to $30 a month.")
    );
}
