//! Watch the web for a topic, read what the monitor found, and verify a
//! webhook delivery.
//!
//!     KEENABLE_API_KEY=keen_... cargo run --example monitors

use keenable::{
    MonitorCreateParams, MonitorPagesParams, MonitorScheduleParams, MonitorSearchParams,
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

    let pages = monitors
        .pages(
            &monitor.id,
            &MonitorPagesParams {
                min_importance: Some(4),
                ..Default::default()
            },
        )
        .await?;
    for page in pages.data {
        println!("{}", page.url);
    }

    monitors.delete(&monitor.id).await?;
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
            if let Some(result) = event.data.result {
                println!("new page: {}", result.url);
            }
            200
        }
        Err(_) => 400,
    }
}
