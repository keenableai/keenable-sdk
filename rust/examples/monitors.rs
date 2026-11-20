//! Watch the web for a topic, read what the monitor found, watch a pricing
//! page for changes, and verify a webhook delivery.
//!
//!     KEENABLE_API_KEY=keen_... cargo run --example monitors

use keenable::{
    MonitorCreateParams, MonitorPageTarget, MonitorResultsParams, MonitorScheduleParams,
    MonitorSearchParams, MonitorVersionsParams,
};

#[tokio::main]
async fn main() -> Result<(), keenable::Error> {
    let client = keenable::Client::new()?;
    let monitors = client.monitors();

    let monitor = monitors
        .create(&MonitorCreateParams {
            name: Some("Open-weights LLMs".into()),
            search: MonitorSearchParams {
                max_results: Some(20),
                ..MonitorSearchParams::new("new open-weights LLM releases")
            },
            schedule: Some(MonitorScheduleParams {
                schedule_type: "interval".into(),
                value: Some("6h".into()),
                timezone: None,
            }),
            ..Default::default()
        })
        .await?;
    println!("created {}", monitor.id);

    let run = monitors.trigger(&monitor.id).await?;
    println!("run {} is {}", run.id, run.status);

    let results = monitors
        .results(
            &monitor.id,
            &MonitorResultsParams {
                min_importance: Some(4),
                ..Default::default()
            },
        )
        .await?;
    for result in results.data {
        println!("{}", result.url);
    }

    monitors.delete(&monitor.id).await?;

    // A page monitor watches one page and reports the changes worth telling.
    let pricing = monitors
        .create(&MonitorCreateParams {
            name: Some("Example pricing".into()),
            monitor_type: Some("page".into()),
            page: Some(MonitorPageTarget {
                watch_for: Some("plan prices and new plans".into()),
                sensitivity: Some("meaningful".into()),
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
    let versions = monitors
        .versions(
            &pricing.id,
            &MonitorVersionsParams {
                limit: Some(10),
                ..Default::default()
            },
        )
        .await?;
    for v in versions.data {
        if let Some(diff) = v.diff {
            println!("version {} added {:?}", v.version, diff.added);
        }
    }
    monitors.delete(&pricing.id).await?;
    Ok(())
}

/// What a webhook endpoint does with a delivery: verify, then act.
#[allow(dead_code)]
fn handle_webhook(
    body: &[u8],
    headers: &keenable::reqwest::header::HeaderMap,
    secret: &str,
) -> u16 {
    match keenable::verify_webhook(body, headers, secret) {
        Ok(event) => {
            if event.event_type == "monitor.result.found" {
                if let Some(result) = &event.data.result {
                    println!("new result: {}", result.url);
                }
            }
            if event.event_type == "monitor.page.changed" {
                let summary = event.data.run.and_then(|r| r.changes?.summary);
                println!("the page changed: {}", summary.unwrap_or_default());
            }
            200
        }
        Err(_) => 400,
    }
}
