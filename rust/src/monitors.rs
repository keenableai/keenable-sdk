//! Keenable Monitors: standing searches that report new results as they
//! appear, and page monitors that report changes to one page.

use std::collections::{HashMap, VecDeque};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use crate::client::RequestOptions;
use crate::error::{ApiError, Error, Result};
use crate::{types, Client};

/// What a monitor watches for. `query` is required on create; on update the
/// fields set are merged into the stored search, and an empty `query` is
/// unset.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorSearchParams {
    /// The topic in plain words, e.g. "new open-weights LLM releases".
    pub query: String,
    /// Results a run returns at most, 1 to 100 (the API's default is 10).
    pub max_results: Option<u32>,
    /// Only pages on these sites.
    pub include_domains: Option<Vec<String>>,
    /// Never pages on these sites.
    pub exclude_domains: Option<Vec<String>>,
    /// Return each page's text (first 6,000 characters).
    pub content_text: Option<bool>,
}

impl MonitorSearchParams {
    /// Search parameters with only a query.
    pub fn new(query: impl Into<String>) -> Self {
        MonitorSearchParams {
            query: query.into(),
            ..Default::default()
        }
    }

    fn body(&self) -> Value {
        let mut out = Map::new();
        if !self.query.is_empty() {
            out.insert("query".into(), Value::String(self.query.clone()));
        }
        if let Some(n) = self.max_results {
            out.insert("max_results".into(), Value::from(n));
        }
        if let Some(d) = &self.include_domains {
            out.insert("include_domains".into(), Value::from(d.clone()));
        }
        if let Some(d) = &self.exclude_domains {
            out.insert("exclude_domains".into(), Value::from(d.clone()));
        }
        if let Some(text) = self.content_text {
            out.insert("content".into(), serde_json::json!({ "text": text }));
        }
        Value::Object(out)
    }
}

/// The page a page monitor watches. On create `url` is required; on update
/// the fields set are merged into the stored page, an empty `url` is unset,
/// a new one starts a new baseline, and `watch_for: Some(String::new())`
/// clears it. A monitor read from the API carries it too.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct MonitorPageTarget {
    /// A public http(s) address.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub url: String,
    /// What on the page matters, in plain words, e.g. "plan prices". `None`
    /// means every meaningful change counts.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watch_for: Option<String>,
    /// "meaningful" (the API's default: a change is judged worth telling or
    /// not) or "any" (every change that is not cosmetic is told).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sensitivity: Option<String>,
}

impl MonitorPageTarget {
    /// A page target with only a URL.
    pub fn new(url: impl Into<String>) -> Self {
        MonitorPageTarget {
            url: url.into(),
            ..Default::default()
        }
    }
}

/// When runs happen.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct MonitorScheduleParams {
    /// "cron", "interval" or "once".
    #[serde(rename = "type")]
    pub schedule_type: String,
    /// cron: five fields whose runs are at least 10 minutes apart. interval:
    /// 10m to 90d ("10m", "6h", "2w"). once: a timestamp or a delay ("2h");
    /// `None` means now.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value: Option<String>,
    /// An IANA name, for cron; UTC when unset.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
}

/// Where a monitor's events go.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct MonitorWebhookParams {
    /// A public HTTPS address. On update, `None` keeps the stored one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// For a search monitor, defaults to the monitor.* and monitor.run.*
    /// events plus monitor.result.found (each new result as soon as it is
    /// found), monitor.result.changed and, once a page is attached,
    /// monitor.page.changed. For a page monitor, defaults to
    /// monitor.created, updated, deleted, disabled, run.failed and
    /// monitor.page.changed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub events: Option<Vec<String>>,
}

/// The arguments to [`Monitors::create`].
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MonitorCreateParams {
    /// "search" or "page", sent as `type`. `None` is unset (the API's default
    /// is search).
    pub monitor_type: Option<String>,
    /// What a search monitor watches for: required, with a query, unless
    /// `monitor_type` is "page".
    pub search: MonitorSearchParams,
    /// The page a page monitor watches: required, with a URL, when
    /// `monitor_type` is "page", and refused otherwise.
    pub page: Option<MonitorPageTarget>,
    /// Up to 200 characters.
    pub name: Option<String>,
    /// When runs happen. `None` means a search monitor runs only on
    /// [`Monitors::trigger`] and a page monitor every hour.
    pub schedule: Option<MonitorScheduleParams>,
    /// The JSON Schema of each run's `output.structured`, in the subset the
    /// API supports; the API checks it.
    pub output_schema: Option<Value>,
    /// Where events go.
    pub webhook: Option<MonitorWebhookParams>,
    /// Your own tags (at most 50), echoed in every webhook.
    pub metadata: Option<HashMap<String, String>>,
    /// Makes a retry safe: the same key with the same body returns the
    /// monitor the first call created, for 24 hours. `None` makes a new key
    /// for this call.
    pub idempotency_key: Option<String>,
}

/// The arguments to [`Monitors::update`]. `None` leaves a field as it is; for
/// the fields that can be removed, `Some(None)` removes it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct MonitorUpdateParams {
    /// A new name, or `Some(None)` to remove it.
    pub name: Option<Option<String>>,
    /// "active" or "paused"; active also re-enables a disabled monitor.
    pub status: Option<String>,
    /// Merged into the stored search (search monitors).
    pub search: Option<MonitorSearchParams>,
    /// Merged into the stored page (page monitors).
    pub page: Option<MonitorPageTarget>,
    /// A new schedule, or `Some(None)` to remove it.
    pub schedule: Option<Option<MonitorScheduleParams>>,
    /// A new output schema, or `Some(None)` to remove it.
    pub output_schema: Option<Option<Value>>,
    /// Merged into the stored webhook, or `Some(None)` to remove it.
    pub webhook: Option<Option<MonitorWebhookParams>>,
    /// New metadata, or `Some(None)` to remove it.
    pub metadata: Option<Option<HashMap<String, String>>>,
}

/// The arguments to [`Monitors::list`].
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorListParams {
    /// Only monitors in this status: active, paused, disabled or completed.
    pub status: Option<String>,
    /// Only monitors whose name contains this.
    pub name: Option<String>,
    /// Only monitors with these metadata values.
    pub metadata: HashMap<String, String>,
    /// Monitors per page (the API's default is 50).
    pub limit: Option<u32>,
    /// The previous page's `next_cursor`.
    pub cursor: Option<String>,
}

/// Paging through runs or deliveries.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorPageParams {
    /// Items per page.
    pub limit: Option<u32>,
    /// The previous page's `next_cursor`.
    pub cursor: Option<String>,
}

/// Paging through a page monitor's versions.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorVersionsParams {
    /// Versions per page (the API's default is 50).
    pub limit: Option<u32>,
    /// The previous page's `next_cursor`.
    pub cursor: Option<String>,
}

/// Paging through a monitor's results.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorResultsParams {
    /// Results per page.
    pub limit: Option<u32>,
    /// The previous page's `next_cursor`.
    pub cursor: Option<String>,
    /// Keep results rated at least this important (1 to 5).
    pub min_importance: Option<u32>,
}

/// Which monitors [`Monitors::bulk`] acts on.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BulkFilter {
    /// Monitors in this status.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    /// Monitors whose name contains this.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Monitors with these metadata values.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<HashMap<String, String>>,
}

/// The arguments to [`Monitors::bulk`]: `ids` or a `filter`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MonitorBulkParams {
    /// These monitors.
    pub ids: Option<Vec<String>>,
    /// Or the monitors this matches.
    pub filter: Option<BulkFilter>,
    /// At most this many monitors (default 50, up to 500).
    pub limit: Option<u32>,
    /// Only report what would change. `None` means true: pass `Some(false)`
    /// to act.
    pub dry_run: Option<bool>,
}

#[derive(Deserialize, Default)]
struct WireContent {
    #[serde(default)]
    text: bool,
}

/// What a monitor watches for.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(from = "WireSearch")]
#[non_exhaustive]
pub struct MonitorSearch {
    /// The topic in plain words, as written when the monitor was made.
    pub query: String,
    /// Results a run returns at most.
    pub max_results: u32,
    /// Only pages on these sites.
    pub include_domains: Option<Vec<String>>,
    /// Never pages on these sites.
    pub exclude_domains: Option<Vec<String>>,
    /// Whether each page's text is returned.
    pub content_text: bool,
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct WireSearch {
    query: String,
    max_results: u32,
    include_domains: Option<Vec<String>>,
    exclude_domains: Option<Vec<String>>,
    content: Option<WireContent>,
}

impl From<WireSearch> for MonitorSearch {
    fn from(w: WireSearch) -> Self {
        MonitorSearch {
            query: w.query,
            max_results: w.max_results,
            include_domains: w.include_domains,
            exclude_domains: w.exclude_domains,
            content_text: w.content.is_some_and(|c| c.text),
        }
    }
}

/// When a monitor's runs happen.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorSchedule {
    /// "cron", "interval" or "once".
    #[serde(rename = "type")]
    pub schedule_type: String,
    /// The cron fields, the interval or the time of a once schedule.
    pub value: Option<String>,
    /// An IANA name, for cron.
    pub timezone: Option<String>,
}

/// Where a monitor's events go.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorWebhook {
    /// The address.
    pub url: String,
    /// The events sent.
    pub events: Vec<String>,
    /// The signing secret (`whsec_...`), only in the response to
    /// [`Monitors::create`]. Keep it for [`verify_webhook`](crate::verify_webhook).
    pub secret: Option<String>,
}

/// Why Keenable disabled a monitor.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorDisabledReason {
    /// runs_failed (10 failed runs in a row), webhook_unreachable (no
    /// delivery succeeded for 3 days) or data_policy (a page
    /// monitor of an organization that turned on zero data retention).
    pub code: String,
    /// What happened.
    pub message: String,
}

fn null_as_default<'de, D, T>(d: D) -> std::result::Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + Deserialize<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

fn default_type() -> String {
    "search".into()
}

/// A monitor as the API returns it.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct Monitor {
    /// Its id.
    pub id: String,
    /// "monitor".
    pub object: String,
    /// Its name.
    pub name: Option<String>,
    /// search (new results about a topic) or page (changes to one page).
    #[serde(rename = "type", default = "default_type")]
    pub monitor_type: String,
    /// active, paused, disabled or completed.
    pub status: String,
    /// Why a disabled monitor stopped; `None` otherwise.
    pub disabled_reason: Option<MonitorDisabledReason>,
    /// What a search monitor watches for; `None` for a page monitor.
    pub search: Option<MonitorSearch>,
    /// The page a page monitor watches; `None` for a search monitor.
    pub page: Option<MonitorPageTarget>,
    /// When its runs happen.
    pub schedule: Option<MonitorSchedule>,
    /// The JSON Schema of each run's `output.structured`.
    pub output_schema: Option<Value>,
    /// Where its events go.
    pub webhook: Option<MonitorWebhook>,
    /// Your tags.
    pub metadata: Option<HashMap<String, String>>,
    /// When it last ran.
    pub last_run_at: Option<String>,
    /// When it runs next.
    pub next_run_at: Option<String>,
    /// The next three run times, UTC.
    pub upcoming_runs: Vec<String>,
    /// When it was made.
    pub created_at: String,
    /// When it last changed.
    pub updated_at: String,
    /// The API's id for this request.
    #[serde(skip)]
    pub request_id: Option<String>,
    /// The unmodified JSON object.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

/// How a page that came back changed since the version the monitor sent.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorResultChange {
    /// When the earlier version was seen.
    pub previous_at: Option<String>,
    /// The earlier version's title.
    pub previous_title: Option<String>,
    /// Whether the earlier version was sent.
    pub previous_sent: Option<bool>,
    /// The share of the new text that was not in the old one, 0 to 1.
    pub ratio: Option<f64>,
    /// Text added.
    pub added: Option<Vec<String>>,
    /// Text removed.
    pub removed: Option<Vec<String>>,
}

/// A result a monitor found: in a run, a webhook event or [`Monitors::results`].
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorResult {
    /// The page.
    pub url: String,
    /// Its title.
    pub title: Option<String>,
    /// Its author.
    pub author: Option<String>,
    /// When it was published.
    pub published_at: Option<String>,
    /// When Keenable crawled it.
    pub acquired_at: Option<String>,
    /// Its image.
    pub image: Option<String>,
    /// When the monitor accepted the page.
    pub matched_at: Option<String>,
    /// declared, url, x or text: where the date comes from.
    pub published_at_source: Option<String>,
    /// One line on what the page reports.
    pub summary: Option<String>,
    /// 1 to 5 for the monitor's topic; results under 3 are not sent.
    pub importance: Option<u32>,
    /// The kind of page.
    pub kind: Option<String>,
    /// original or rewrite.
    pub source_type: Option<String>,
    /// The page's text, when the monitor's search asks for it.
    pub text: Option<String>,
    /// On monitor.result.changed: how the page changed.
    pub change: Option<MonitorResultChange>,
    /// From [`Monitors::results`]: identifies the match, and is the cursor of
    /// the page of results it ends.
    pub id: Option<String>,
    /// From [`Monitors::results`]: how many more results reported the same story
    /// and were left out.
    pub same_story: Option<u32>,
}

/// Why a run failed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorRunError {
    /// The reason's code.
    pub code: String,
    /// What happened.
    pub message: String,
}

/// Why a run has no output.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(from = "WireOutputError")]
#[non_exhaustive]
pub struct MonitorRunOutputError {
    /// output_failed (it could not be made) or output_invalid (it did not
    /// match the schema). The run still completes.
    pub code: String,
    /// What happened.
    pub message: String,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireOutputError {
    Code(String),
    Object {
        #[serde(default)]
        code: String,
        #[serde(default)]
        message: String,
    },
}

impl From<WireOutputError> for MonitorRunOutputError {
    fn from(w: WireOutputError) -> Self {
        match w {
            WireOutputError::Code(code) => MonitorRunOutputError {
                code,
                message: String::new(),
            },
            WireOutputError::Object { code, message } => MonitorRunOutputError { code, message },
        }
    }
}

fn default_true() -> bool {
    true
}

/// A run's digest, when the monitor has an output schema.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorRunOutput {
    /// The output in the monitor's schema; `None` with `error`.
    pub structured: Option<Value>,
    /// The output as text.
    pub text: Option<String>,
    /// Each field filled, with the pages that support it.
    #[serde(deserialize_with = "null_as_default")]
    pub grounding: Vec<Value>,
    /// False when a page monitor's page did not change and the last reading
    /// is carried forward.
    #[serde(default = "default_true")]
    pub fresh: bool,
    /// Why there is no output.
    pub error: Option<MonitorRunOutputError>,
}

impl Default for MonitorRunOutput {
    fn default() -> Self {
        MonitorRunOutput {
            structured: None,
            text: None,
            grounding: Vec::new(),
            fresh: true,
            error: None,
        }
    }
}

/// How a version of a page differs from the version before it from the same
/// source.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorDiff {
    /// When the version compared with was read.
    pub previous_at: Option<String>,
    /// The share of the text that is new, 0 to 1.
    pub ratio: Option<f64>,
    /// Text added.
    #[serde(deserialize_with = "null_as_default")]
    pub added: Vec<String>,
    /// Text removed.
    #[serde(deserialize_with = "null_as_default")]
    pub removed: Vec<String>,
}

/// What a page monitor's run found on its page.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorRunChanges {
    /// The text changed since the previous version (a baseline is not a
    /// change).
    pub changed: bool,
    /// The change is worth telling: monitor.page.changed was sent.
    pub notified: bool,
    /// The first reading of the page (or of a new URL).
    pub baseline: bool,
    /// The page's version after this run; [`Monitors::versions`] has them
    /// all.
    pub version: Option<u32>,
    /// live (fetched now) or stream (the crawler's fresh copy).
    pub source: Option<String>,
    /// One sentence on what changed, when it was judged.
    pub summary: Option<String>,
    /// The new entries, facts or figures.
    #[serde(deserialize_with = "null_as_default")]
    pub items: Vec<String>,
    /// The diff against the previous version.
    pub diff: Option<MonitorDiff>,
}

/// One stored version of a page monitor's page: a reading whose text
/// changed.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorVersion {
    /// Opaque; the cursor of the page of versions it ends.
    pub id: String,
    /// "page_version".
    pub object: String,
    /// Counts up from 1, the baseline.
    pub version: u32,
    /// When it was read.
    pub fetched_at: Option<String>,
    /// The page's title.
    pub title: Option<String>,
    /// live or stream; versions are compared only with versions of the same
    /// source.
    pub source: String,
    /// This version's change was told (monitor.page.changed).
    pub notified: bool,
    /// One sentence on what changed, when it was told.
    pub summary: Option<String>,
    /// The new entries, facts or figures.
    #[serde(deserialize_with = "null_as_default")]
    pub items: Vec<String>,
    /// Against the version before it from the same source; `None` for a
    /// first version.
    pub diff: Option<MonitorDiff>,
}

/// One run of a monitor.
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorRun {
    /// Its id.
    pub id: String,
    /// "monitor_run".
    pub object: String,
    /// The monitor.
    pub monitor_id: String,
    /// queued, running, completed, failed or cancelled.
    pub status: String,
    /// New results; empty when none; `None` until the run completes.
    pub results: Option<Vec<MonitorResult>>,
    /// A page monitor's completed run: what changed on the page. `None` for
    /// a search monitor.
    pub changes: Option<MonitorRunChanges>,
    /// The digest, when the monitor has an output schema.
    pub output: Option<MonitorRunOutput>,
    /// Why it failed.
    pub error: Option<MonitorRunError>,
    /// When it was made.
    pub created_at: Option<String>,
    /// When it started.
    pub started_at: Option<String>,
    /// When it ended.
    pub ended_at: Option<String>,
    /// The API's id for this request.
    #[serde(skip)]
    pub request_id: Option<String>,
    /// The unmodified JSON object.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

/// One webhook event and its delivery attempts.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorDelivery {
    /// The event's id.
    pub id: String,
    /// The event's type.
    #[serde(rename = "type")]
    pub event_type: String,
    /// Where it was sent.
    pub url: String,
    /// When it was made.
    pub created_at: String,
    /// How many times it was sent.
    pub attempts: u32,
    /// When it was delivered.
    pub delivered_at: Option<String>,
    /// The last error.
    pub last_error: Option<String>,
    /// When it is sent again.
    pub next_attempt_at: Option<String>,
}

/// How many monitors there are, by status and by kind of schedule (cron,
/// interval, once, manual).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct MonitorStats {
    /// All monitors.
    pub total: u64,
    /// By status.
    pub by_status: HashMap<String, u64>,
    /// By kind of schedule.
    pub by_schedule: HashMap<String, u64>,
    /// The API's id for this request.
    #[serde(skip)]
    pub request_id: Option<String>,
    /// The unmodified JSON object.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

/// What [`Monitors::bulk`] changed, or would change on a dry run.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct BulkResult {
    /// pause, resume or delete.
    pub action: String,
    /// How many monitors.
    pub affected: u64,
    /// Which monitors.
    pub ids: Vec<String>,
    /// Whether nothing changed.
    pub dry_run: bool,
    /// More monitors matched than `limit`.
    pub has_more: bool,
    /// The ids sent that are not monitors of this key.
    pub not_found: Vec<String>,
    /// The API's id for this request.
    #[serde(skip)]
    pub request_id: Option<String>,
    /// The unmodified JSON object.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

/// One page of a list; `next_cursor` fetches the next.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(default)]
#[non_exhaustive]
pub struct List<T> {
    /// The items.
    pub data: Vec<T>,
    /// Whether there are more.
    pub has_more: bool,
    /// The cursor of the next page.
    pub next_cursor: Option<String>,
    /// The API's id for this request.
    #[serde(skip)]
    pub request_id: Option<String>,
    /// The unmodified JSON object.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

impl<T> Default for List<T> {
    fn default() -> Self {
        List {
            data: Vec::new(),
            has_more: false,
            next_cursor: None,
            request_id: None,
            raw: Map::new(),
        }
    }
}

/// A page of monitors.
pub type MonitorList = List<Monitor>;
/// A page of runs.
pub type RunList = List<MonitorRun>;
/// A page of a monitor's results.
pub type ResultList = List<MonitorResult>;
/// A page of webhook deliveries.
pub type DeliveryList = List<MonitorDelivery>;
/// A page of a page monitor's versions.
pub type VersionList = List<MonitorVersion>;

trait Response: DeserializeOwned {
    fn attach(&mut self, _request_id: Option<String>, _raw: Map<String, Value>) {}
}

macro_rules! response {
    ($($t:ty),*) => {$(
        impl Response for $t {
            fn attach(&mut self, request_id: Option<String>, raw: Map<String, Value>) {
                self.request_id = request_id;
                self.raw = raw;
            }
        }
    )*};
}

response!(Monitor, MonitorRun, MonitorStats, BulkResult);

impl<T: DeserializeOwned> Response for List<T> {
    fn attach(&mut self, request_id: Option<String>, raw: Map<String, Value>) {
        self.request_id = request_id;
        self.raw = raw;
    }
}

/// `client.monitors()`: create, read and manage monitors. Needs an API key;
/// without one every call returns [`Error::Auth`] with code
/// `missing_api_key` and sends nothing.
///
/// Reads and deletes are retried like a search. [`Monitors::create`] sends an
/// `Idempotency-Key` (yours, or a new one for each call), so retrying it
/// cannot make a second monitor. [`Monitors::update`], [`Monitors::trigger`]
/// and [`Monitors::bulk`] are retried only on a 429, which the API sends
/// before it does anything.
///
/// ```no_run
/// # async fn run() -> Result<(), keenable::Error> {
/// use keenable::{MonitorCreateParams, MonitorSearchParams};
///
/// let client = keenable::Client::new()?;
/// let monitor = client
///     .monitors()
///     .create(&MonitorCreateParams {
///         search: MonitorSearchParams::new("new open-weights LLM releases"),
///         ..Default::default()
///     })
///     .await?;
/// for result in client.monitors().results(&monitor.id, &Default::default()).await?.data {
///     println!("{} {}", result.title.unwrap_or_default(), result.url);
/// }
/// # Ok(())
/// # }
/// ```
#[derive(Debug, Clone)]
pub struct Monitors<'a> {
    client: &'a Client,
    request: RequestOptions,
}

struct Call {
    method: reqwest::Method,
    path: String,
    query: Vec<(String, String)>,
    body: Option<Value>,
    headers: HashMap<String, String>,
    safe: bool,
}

impl Call {
    fn new(method: reqwest::Method, path: String, safe: bool) -> Self {
        Call {
            method,
            path,
            query: Vec::new(),
            body: None,
            headers: HashMap::new(),
            safe,
        }
    }
}

fn segment(name: &str, value: &str) -> Result<String> {
    if value.trim().is_empty() {
        return Err(Error::invalid(format!("{name} must be a non-empty string")));
    }
    if value == "." || value == ".." {
        return Err(Error::invalid(format!(
            "{name} must not be {value:?}: it would change the request's path"
        )));
    }
    Ok(url::form_urlencoded::byte_serialize(value.as_bytes())
        .collect::<String>()
        .replace('+', "%20"))
}

fn monitor_path(id: &str, rest: &[&str]) -> Result<String> {
    let mut path = format!("monitors/{}", segment("monitor id", id)?);
    for part in rest {
        path.push('/');
        path.push_str(part);
    }
    Ok(path)
}

fn page_query(limit: Option<u32>, cursor: &Option<String>) -> Vec<(String, String)> {
    let mut q = Vec::new();
    if let Some(n) = limit {
        q.push(("limit".into(), n.to_string()));
    }
    if let Some(c) = cursor.as_deref().filter(|c| !c.is_empty()) {
        q.push(("cursor".into(), c.to_string()));
    }
    q
}

fn new_idempotency_key() -> String {
    let mut b: [u8; 16] = rand::random();
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

fn to_value<T: Serialize>(v: &T) -> Value {
    serde_json::to_value(v).unwrap_or(Value::Null)
}

impl<'a> Monitors<'a> {
    pub(crate) fn new(client: &'a Client) -> Self {
        Monitors {
            client,
            request: RequestOptions::default(),
        }
    }

    /// The same calls with this timeout, retry budget and headers.
    pub fn with_request(&self, request: RequestOptions) -> Monitors<'a> {
        Monitors {
            client: self.client,
            request,
        }
    }

    async fn send<T: Response>(&self, call: Call) -> Result<T> {
        if self.client.is_keyless() {
            let mut api = ApiError::plain(
                401,
                "Keenable authentication failed (401): Monitors need an API key. Set Options::api_key or KEENABLE_API_KEY; create one at https://keenable.ai/console.".into(),
                None,
            );
            api.code = Some("missing_api_key".into());
            api.error_type = types::AUTHENTICATION_ERROR.into();
            api.retryable = Some(false);
            return Err(Error::Auth(Box::new(api)));
        }
        let mut url = format!("{}/v1/{}", self.client.base_url(), call.path);
        if !call.query.is_empty() {
            let encoded = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(&call.query)
                .finish();
            url.push('?');
            url.push_str(&encoded);
        }
        let body = match &call.body {
            Some(v) => Some(serde_json::to_vec(v).map_err(|e| {
                Error::invalid(format!(
                    "could not encode the request: {e}. Pass JSON-encodable arguments."
                ))
            })?),
            None => None,
        };
        let (data, id) = self
            .client
            .send_url(
                call.method,
                url,
                body,
                &call.headers,
                &self.request,
                call.safe,
            )
            .await?;
        let request_id = crate::models::non_blank(data.get("request_id")).or(id);
        let mut out: T = serde_json::from_value(Value::Object(data.clone())).map_err(|e| {
            Error::Api(Box::new(ApiError::plain(
                200,
                format!("Unexpected response from the Keenable API: {e}. Retry the request. If it keeps failing, confirm KEENABLE_API_URL."),
                request_id.clone(),
            )))
        })?;
        out.attach(request_id, data);
        Ok(out)
    }

    /// Creates a monitor: a search monitor (`search.query`) or, with
    /// `monitor_type` "page", a page monitor (`page.url`). Takes a few
    /// seconds. `webhook.secret` is set in this response only.
    pub async fn create(&self, params: &MonitorCreateParams) -> Result<Monitor> {
        let mut body = Map::new();
        match params.monitor_type.as_deref() {
            Some("page") => {
                let page = params
                    .page
                    .as_ref()
                    .filter(|p| !p.url.trim().is_empty())
                    .ok_or_else(|| {
                        Error::invalid("a page monitor needs page.url, the page to watch")
                    })?;
                if params.search != MonitorSearchParams::default() {
                    return Err(Error::invalid("a page monitor takes page, not search"));
                }
                body.insert("type".into(), Value::String("page".into()));
                body.insert("page".into(), to_value(page));
            }
            None | Some("search") => {
                if params.page.is_some() {
                    return Err(Error::invalid(
                        "page is only for monitor_type \"page\"; a search monitor takes search",
                    ));
                }
                if params.search.query.trim().is_empty() {
                    return Err(Error::invalid(
                        "create needs search.query, the topic in plain words",
                    ));
                }
                if let Some(t) = &params.monitor_type {
                    body.insert("type".into(), Value::String(t.clone()));
                }
                body.insert("search".into(), params.search.body());
            }
            Some(other) => {
                return Err(Error::invalid(format!(
                    "monitor_type must be \"search\" or \"page\", got {other:?}"
                )));
            }
        }
        if let Some(name) = &params.name {
            body.insert("name".into(), Value::String(name.clone()));
        }
        if let Some(s) = &params.schedule {
            body.insert("schedule".into(), to_value(s));
        }
        if let Some(s) = &params.output_schema {
            body.insert("output_schema".into(), s.clone());
        }
        if let Some(w) = &params.webhook {
            body.insert("webhook".into(), to_value(w));
        }
        if let Some(m) = &params.metadata {
            body.insert("metadata".into(), to_value(m));
        }
        let key = params
            .idempotency_key
            .clone()
            .filter(|k| !k.is_empty())
            .unwrap_or_else(new_idempotency_key);
        let mut call = Call::new(reqwest::Method::POST, "monitors".into(), true);
        call.body = Some(Value::Object(body));
        call.headers.insert("Idempotency-Key".into(), key);
        self.send(call).await
    }

    /// One page of monitors, newest first.
    pub async fn list(&self, params: &MonitorListParams) -> Result<MonitorList> {
        let mut call = Call::new(reqwest::Method::GET, "monitors".into(), true);
        if let Some(s) = params.status.as_deref().filter(|s| !s.is_empty()) {
            call.query.push(("status".into(), s.into()));
        }
        if let Some(n) = params.name.as_deref().filter(|s| !s.is_empty()) {
            call.query.push(("name".into(), n.into()));
        }
        let mut metadata: Vec<_> = params.metadata.iter().collect();
        metadata.sort();
        for (k, v) in metadata {
            call.query.push((format!("metadata[{k}]"), v.clone()));
        }
        call.query.extend(page_query(params.limit, &params.cursor));
        self.send(call).await
    }

    /// Every monitor, newest first, fetching pages as needed:
    /// `while let Some(m) = pager.next().await? { ... }`.
    pub fn list_all(&self, params: &MonitorListParams) -> MonitorPager<'a> {
        MonitorPager {
            monitors: self.clone(),
            params: params.clone(),
            buffer: VecDeque::new(),
            done: false,
        }
    }

    /// One monitor.
    pub async fn get(&self, monitor_id: &str) -> Result<Monitor> {
        let path = monitor_path(monitor_id, &[])?;
        self.send(Call::new(reqwest::Method::GET, path, true)).await
    }

    /// Changes a monitor; only what `params` sets is sent. Not retried on a
    /// 5xx.
    pub async fn update(&self, monitor_id: &str, params: &MonitorUpdateParams) -> Result<Monitor> {
        let path = monitor_path(monitor_id, &[])?;
        let mut body = Map::new();
        if let Some(n) = &params.name {
            body.insert(
                "name".into(),
                n.clone().map(Value::String).unwrap_or(Value::Null),
            );
        }
        if let Some(s) = params.status.as_deref().filter(|s| !s.is_empty()) {
            body.insert("status".into(), Value::String(s.into()));
        }
        if let Some(s) = &params.search {
            body.insert("search".into(), s.body());
        }
        if let Some(p) = &params.page {
            let mut page = Map::new();
            if !p.url.is_empty() {
                page.insert("url".into(), Value::String(p.url.clone()));
            }
            if let Some(w) = &p.watch_for {
                page.insert(
                    "watch_for".into(),
                    if w.is_empty() {
                        Value::Null
                    } else {
                        Value::String(w.clone())
                    },
                );
            }
            if let Some(s) = &p.sensitivity {
                page.insert("sensitivity".into(), Value::String(s.clone()));
            }
            body.insert("page".into(), Value::Object(page));
        }
        if let Some(s) = &params.schedule {
            body.insert(
                "schedule".into(),
                s.as_ref().map(to_value).unwrap_or(Value::Null),
            );
        }
        if let Some(s) = &params.output_schema {
            body.insert("output_schema".into(), s.clone().unwrap_or(Value::Null));
        }
        if let Some(w) = &params.webhook {
            body.insert(
                "webhook".into(),
                w.as_ref().map(to_value).unwrap_or(Value::Null),
            );
        }
        if let Some(m) = &params.metadata {
            body.insert(
                "metadata".into(),
                m.as_ref().map(to_value).unwrap_or(Value::Null),
            );
        }
        let mut call = Call::new(reqwest::Method::PATCH, path, false);
        call.body = Some(Value::Object(body));
        self.send(call).await
    }

    /// Pauses a monitor: [`Monitors::update`] with status "paused".
    pub async fn pause(&self, monitor_id: &str) -> Result<Monitor> {
        self.update(
            monitor_id,
            &MonitorUpdateParams {
                status: Some("paused".into()),
                ..Default::default()
            },
        )
        .await
    }

    /// Resumes a paused or disabled monitor: [`Monitors::update`] with status
    /// "active".
    pub async fn resume(&self, monitor_id: &str) -> Result<Monitor> {
        self.update(
            monitor_id,
            &MonitorUpdateParams {
                status: Some("active".into()),
                ..Default::default()
            },
        )
        .await
    }

    /// Deletes a monitor and the results it found, for good, and returns it as
    /// it was.
    pub async fn delete(&self, monitor_id: &str) -> Result<Monitor> {
        let path = monitor_path(monitor_id, &[])?;
        self.send(Call::new(reqwest::Method::DELETE, path, true))
            .await
    }

    /// Starts a run now and returns it queued. Not retried on a 5xx.
    pub async fn trigger(&self, monitor_id: &str) -> Result<MonitorRun> {
        let path = monitor_path(monitor_id, &["trigger"])?;
        self.send(Call::new(reqwest::Method::POST, path, false))
            .await
    }

    /// One page of a monitor's runs, newest first.
    pub async fn runs(&self, monitor_id: &str, params: &MonitorPageParams) -> Result<RunList> {
        let mut call = Call::new(
            reqwest::Method::GET,
            monitor_path(monitor_id, &["runs"])?,
            true,
        );
        call.query = page_query(params.limit, &params.cursor);
        self.send(call).await
    }

    /// One run.
    pub async fn run(&self, monitor_id: &str, run_id: &str) -> Result<MonitorRun> {
        let run = segment("run id", run_id)?;
        let path = monitor_path(monitor_id, &["runs", &run])?;
        self.send(Call::new(reqwest::Method::GET, path, true)).await
    }

    /// The results a monitor accepted, newest first, one per story. Poll
    /// and stop at the first `id` already seen.
    pub async fn results(
        &self,
        monitor_id: &str,
        params: &MonitorResultsParams,
    ) -> Result<ResultList> {
        let mut call = Call::new(
            reqwest::Method::GET,
            monitor_path(monitor_id, &["results"])?,
            true,
        );
        call.query = page_query(params.limit, &params.cursor);
        if let Some(n) = params.min_importance {
            call.query.push(("min_importance".into(), n.to_string()));
        }
        self.send(call).await
    }

    /// A page monitor's history, newest first (its last 500 versions): every
    /// reading whose text changed, with the diff against the version before
    /// it from the same source. Empty for a search monitor.
    pub async fn versions(
        &self,
        monitor_id: &str,
        params: &MonitorVersionsParams,
    ) -> Result<VersionList> {
        let mut call = Call::new(
            reqwest::Method::GET,
            monitor_path(monitor_id, &["versions"])?,
            true,
        );
        call.query = page_query(params.limit, &params.cursor);
        self.send(call).await
    }

    /// The monitor's webhook events of the last 7 days, with attempts and the
    /// last error.
    pub async fn deliveries(
        &self,
        monitor_id: &str,
        params: &MonitorPageParams,
    ) -> Result<DeliveryList> {
        let mut call = Call::new(
            reqwest::Method::GET,
            monitor_path(monitor_id, &["deliveries"])?,
            true,
        );
        call.query = page_query(params.limit, &params.cursor);
        self.send(call).await
    }

    /// Counts of monitors by status and by kind of schedule.
    pub async fn stats(&self) -> Result<MonitorStats> {
        self.send(Call::new(
            reqwest::Method::GET,
            "monitors/stats".into(),
            true,
        ))
        .await
    }

    /// Pauses, resumes or deletes many monitors, by `ids` or by `filter`.
    /// `action` is "pause", "resume" or "delete". A dry run unless `dry_run`
    /// is `Some(false)`. Not retried on a 5xx.
    pub async fn bulk(&self, action: &str, params: &MonitorBulkParams) -> Result<BulkResult> {
        if !matches!(action, "pause" | "resume" | "delete") {
            return Err(Error::invalid(format!(
                "action must be pause, resume or delete, got {action:?}"
            )));
        }
        let ids = params.ids.as_ref().filter(|ids| !ids.is_empty());
        let filter = params.filter.as_ref().filter(|f| {
            f.status.as_deref().is_some_and(|s| !s.is_empty())
                || f.name.as_deref().is_some_and(|n| !n.is_empty())
                || f.metadata.as_ref().is_some_and(|m| !m.is_empty())
        });
        if ids.is_none() && filter.is_none() {
            return Err(Error::invalid("bulk needs ids or a filter"));
        }
        let mut body = Map::new();
        body.insert("action".into(), Value::String(action.into()));
        body.insert(
            "dry_run".into(),
            Value::Bool(params.dry_run.unwrap_or(true)),
        );
        if let Some(ids) = ids {
            body.insert("ids".into(), Value::from(ids.clone()));
        }
        if let Some(f) = filter {
            let mut selector = Map::new();
            if let Some(s) = f.status.as_deref().filter(|s| !s.is_empty()) {
                selector.insert("status".into(), Value::String(s.into()));
            }
            if let Some(n) = f.name.as_deref().filter(|n| !n.is_empty()) {
                selector.insert("name".into(), Value::String(n.into()));
            }
            if let Some(m) = f.metadata.as_ref().filter(|m| !m.is_empty()) {
                selector.insert("metadata".into(), to_value(m));
            }
            body.insert("filter".into(), Value::Object(selector));
        }
        if let Some(n) = params.limit {
            body.insert("limit".into(), Value::from(n));
        }
        let mut call = Call::new(reqwest::Method::POST, "monitors/bulk".into(), false);
        call.body = Some(Value::Object(body));
        self.send(call).await
    }
}

/// Walks every monitor, fetching pages as needed. From
/// [`Monitors::list_all`].
#[derive(Debug)]
pub struct MonitorPager<'a> {
    monitors: Monitors<'a>,
    params: MonitorListParams,
    buffer: VecDeque<Monitor>,
    done: bool,
}

impl MonitorPager<'_> {
    /// The next monitor, or `None` after the last.
    pub async fn next(&mut self) -> Result<Option<Monitor>> {
        while self.buffer.is_empty() {
            if self.done {
                return Ok(None);
            }
            let page = self.monitors.list(&self.params).await?;
            self.buffer.extend(page.data);
            if !page.has_more || page.next_cursor.as_deref().unwrap_or("").is_empty() {
                self.done = true;
            }
            self.params.cursor = page.next_cursor;
        }
        Ok(self.buffer.pop_front())
    }
}
