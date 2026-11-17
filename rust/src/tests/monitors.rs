//! Monitors and verify_webhook against a local server.

use std::collections::HashMap;

use serde_json::{json, Value};

use super::server::{start, Reply, Script};
use super::*;
use crate::{
    BulkFilter, Error, MonitorBulkParams, MonitorCreateParams, MonitorListParams,
    MonitorPageParams, MonitorPagesParams, MonitorScheduleParams, MonitorSearchParams,
    MonitorUpdateParams, MonitorWebhookParams,
};

fn monitor() -> Value {
    json!({
        "id": "mon_1", "object": "monitor", "name": "LLM releases", "status": "active",
        "search": {"query": "new open-weights LLM releases", "max_results": 10, "include_domains": null,
                   "exclude_domains": ["example.com"], "content": {"text": true}},
        "agent_run_id": null, "backfill": null,
        "schedule": {"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
        "output_schema": null,
        "webhook": {"url": "https://hooks.example.com/k", "events": ["monitor.hit"], "secret": "whsec_abc"},
        "metadata": {"team": "research"}, "memory_scope": null,
        "estimated_cost_usd": null, "cost_this_month_usd": null,
        "last_run_at": null, "next_run_at": "2026-11-18T08:00:00Z",
        "upcoming_runs": ["2026-11-18T08:00:00Z"],
        "created_at": "2026-11-17T10:00:00Z", "updated_at": "2026-11-17T10:00:00Z"
    })
}

fn result() -> Value {
    json!({
        "url": "https://example.org/a", "title": "A model", "author": null,
        "published_at": "2026-11-17T09:00:00Z", "acquired_at": "2026-11-17T09:05:00Z",
        "image": null, "favicon": null, "highlights": null, "matched_at": "2026-11-17T09:10:00Z",
        "published_at_source": "declared", "summary": "A lab released a model.", "importance": 4,
        "kind": "news", "source_type": "original", "score": 0.7
    })
}

fn run() -> Value {
    json!({
        "id": "mrun_1", "object": "monitor_run", "monitor_id": "mon_1", "status": "completed",
        "results": [result()], "changes": null,
        "output": {"structured": {"n": 1}, "text": null, "grounding": []},
        "error": null, "usage": null, "created_at": "2026-11-17T10:00:00Z",
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
                events: Some(vec!["monitor.hit".into()]),
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
            "webhook": {"url": "https://hooks.example.com/k", "events": ["monitor.hit"]},
            "metadata": {"team": "research"}
        })
    );
    assert_eq!(m.id, "mon_1");
    assert!(m.search.content_text);
    assert_eq!(
        m.search.exclude_domains,
        Some(vec!["example.com".to_string()])
    );
    assert_eq!(m.webhook.unwrap().secret.as_deref(), Some("whsec_abc"));
    assert_eq!(
        m.schedule.unwrap().timezone.as_deref(),
        Some("Europe/Paris")
    );
    assert_eq!(m.metadata.unwrap()["team"], "research");
    assert_eq!(m.estimated_cost_usd, None);
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
                name: Some("New".into()),
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
                name: Some("x".into()),
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
        "id": "evt_1", "type": "monitor.hit", "url": "https://hooks.example.com/k",
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
    let pages = monitors
        .pages(
            "mon_1",
            &MonitorPagesParams {
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
                    ..Default::default()
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
            "/v1/monitors/mon_1/hits",
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
    assert_eq!(pages.data[0].id.as_deref(), Some("h1"));
    assert_eq!(pages.data[0].same_story, Some(2));
    assert_eq!(pages.data[0].source_type.as_deref(), Some("original"));
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
    assert_eq!(server.count(), 0);
}

const WEBHOOK_BODY: &str = r#"{"id":"msg_2nY8kTestVector01","type":"monitor.hit","created_at":"2026-11-17T17:20:00Z","data":{"monitor_id":"mon_test01","result":{"url":"https://example.com/news/1","title":"Open weights model released","author":null,"published_at":"2026-11-17T16:00:00Z","acquired_at":"2026-11-17T16:05:00Z","image":null,"favicon":null,"highlights":null,"matched_at":"2026-11-17T16:10:00Z","published_at_source":"declared","summary":"A lab released an open-weights model.","importance":4,"kind":"news","source_type":"original","score":0.82}},"metadata":{"team":"research"}}"#;
const WEBHOOK_SECRET: &str = "whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE=";

fn webhook_headers() -> reqwest::header::HeaderMap {
    let mut h = reqwest::header::HeaderMap::new();
    h.insert("webhook-id", "msg_2nY8kTestVector01".parse().unwrap());
    h.insert("webhook-timestamp", "1763400000".parse().unwrap());
    h.insert(
        "webhook-signature",
        "v1,9+ChBZb9nSbPYLix6nY+Pd+ykv10PwAjK5TDBLb2qp4="
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
    assert_eq!(event.event_type, "monitor.hit");
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
