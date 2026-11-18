//! Verify the webhooks Keenable Monitors send (Standard Webhooks).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use hmac::{Hmac, Mac};
use reqwest::header::HeaderMap;
use serde::Deserialize;
use serde_json::{Map, Value};
use sha2::Sha256;

use crate::error::{Error, Result, WebhookVerificationError};
use crate::monitors::{Monitor, MonitorResult, MonitorRun};

/// How far a delivery's timestamp may be from now by default.
pub const DEFAULT_WEBHOOK_TOLERANCE: Duration = Duration::from_secs(300);

/// The optional arguments to [`verify_webhook_with`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct WebhookOptions {
    /// How far the delivery's timestamp may be from now. `None` means
    /// [`DEFAULT_WEBHOOK_TOLERANCE`]; zero is refused.
    pub tolerance: Option<Duration>,
    /// The current time; tests pin it. `None` means the clock.
    pub now: Option<SystemTime>,
}

/// What an event is about. Which field is set depends on the event's type.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct WebhookEventData {
    /// The monitor.
    pub monitor_id: String,
    /// On monitor.created, updated, deleted and disabled.
    pub monitor: Option<Monitor>,
    /// On monitor.run.created, completed and failed.
    pub run: Option<MonitorRun>,
    /// On monitor.hit and monitor.update.
    pub result: Option<MonitorResult>,
    /// Why, on monitor.disabled.
    pub reason: Option<String>,
}

/// A verified webhook event.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct WebhookEvent {
    /// The delivery's id, the same across retries: use it to drop repeats.
    pub id: String,
    /// The event's type, such as "monitor.hit".
    #[serde(rename = "type")]
    pub event_type: String,
    /// When the event happened.
    pub created_at: String,
    /// What it is about.
    pub data: WebhookEventData,
    /// The monitor's metadata.
    pub metadata: Option<std::collections::HashMap<String, String>>,
    /// The unmodified JSON object.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

fn fail<T>(msg: impl Into<String>) -> Result<T> {
    Err(Error::WebhookVerification(WebhookVerificationError {
        msg: msg.into(),
    }))
}

const MAX_STAMP_DIGITS: usize = 12;

fn key(secret: &str) -> Vec<u8> {
    let text = secret.strip_prefix("whsec_").unwrap_or(secret);
    match STANDARD.decode(text) {
        Ok(key) if !text.is_empty() => key,
        _ => text.as_bytes().to_vec(),
    }
}

/// Checks a webhook delivery's signature and returns the event it carries.
///
/// Pass the body exactly as received, before any JSON parsing, the request's
/// headers, and the monitor's `webhook.secret` (`whsec_...`). Returns
/// [`Error::WebhookVerification`] when the delivery is not authentic or not
/// fresh (more than 5 minutes from now).
pub fn verify_webhook(payload: &[u8], headers: &HeaderMap, secret: &str) -> Result<WebhookEvent> {
    verify_webhook_with(payload, headers, secret, &WebhookOptions::default())
}

/// [`verify_webhook`] with another tolerance or a pinned clock.
pub fn verify_webhook_with(
    payload: &[u8],
    headers: &HeaderMap,
    secret: &str,
    opts: &WebhookOptions,
) -> Result<WebhookEvent> {
    if secret.trim().is_empty() {
        return fail("the webhook secret is empty: pass the monitor's webhook.secret");
    }
    let tolerance = opts.tolerance.unwrap_or(DEFAULT_WEBHOOK_TOLERANCE);
    if tolerance.is_zero() {
        return fail("the tolerance must be more than zero");
    }
    let get = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let (Some(id), Some(stamp), Some(signatures)) = (
        get("webhook-id"),
        get("webhook-timestamp"),
        get("webhook-signature"),
    ) else {
        return fail("missing webhook-id, webhook-timestamp or webhook-signature header");
    };
    if stamp.len() > MAX_STAMP_DIGITS || !stamp.bytes().all(|b| b.is_ascii_digit()) {
        return fail(format!("webhook-timestamp is not a Unix time: {stamp:?}"));
    }
    let Ok(sent) = stamp.parse::<f64>() else {
        return fail(format!("webhook-timestamp is not a Unix time: {stamp:?}"));
    };
    let now = opts.now.unwrap_or_else(SystemTime::now);
    let clock = match now.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs_f64(),
        Err(e) => -e.duration().as_secs_f64(),
    };
    if (clock - sent).abs() > tolerance.as_secs_f64() {
        return fail(
            "webhook-timestamp is too far from now: the delivery is stale or the clock is off",
        );
    }
    let key = key(secret);
    if key.is_empty() {
        return fail(
            "the webhook secret has no key after whsec_: pass the monitor's webhook.secret",
        );
    }
    let mut mac = match Hmac::<Sha256>::new_from_slice(&key) {
        Ok(mac) => mac,
        Err(_) => return fail("the webhook secret cannot key an HMAC"),
    };
    mac.update(format!("{id}.{stamp}.").as_bytes());
    mac.update(payload);
    let matched = signatures.split_whitespace().any(|candidate| {
        let Some(("v1", sig)) = candidate.split_once(',') else {
            return false;
        };
        let Ok(sig) = STANDARD.decode(sig) else {
            return false;
        };
        mac.clone().verify_slice(&sig).is_ok()
    });
    if !matched {
        return fail("no webhook-signature matches: check the secret and verify the raw body");
    }
    let Some(Value::Object(obj)) = crate::json::parse(payload) else {
        return fail("the signed body is not a JSON object");
    };
    let mut event: WebhookEvent = match serde_json::from_value(Value::Object(obj.clone())) {
        Ok(event) => event,
        Err(e) => return fail(format!("the signed body is not a webhook event: {e}")),
    };
    event.raw = obj;
    Ok(event)
}
