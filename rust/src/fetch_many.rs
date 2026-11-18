//! `fetch_many`: several URLs in one POST /v1/fetch call, with an optional
//! answer across them.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Number, Value};

use crate::client::{Client, RequestOptions};
use crate::error::{Error, Result};
use crate::guard::reject_private_fetch_target;
use crate::models::{non_blank, safe_count};

/// What each page returns. Sent as the request's `content` group.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchContentOptions {
    /// Caps the characters of each page's text. `None` means the API's
    /// default of 50,000; `Some(0)` returns metadata only.
    pub max_chars: Option<u32>,
    /// What you are looking for on the pages, up to 1,000 characters. The
    /// API keeps the passages relevant to it. An empty objective is unset.
    pub objective: Option<String>,
    /// A JSON Schema to fill from each page; the result is
    /// [`FetchContent::answer`].
    pub schema: Option<Map<String, Value>>,
    /// Returns up to this many of each page's links.
    pub links: Option<u32>,
    /// Returns up to this many of each page's images.
    pub images: Option<u32>,
}

/// How fresh each page must be. Sent as the request's `retrieval` group.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchRetrievalOptions {
    /// Uses a stored copy no older than this many hours (0 to 720, fractions
    /// allowed), else fetches the page live. `Some(0.0)` always fetches live;
    /// `None` takes the stored copy whatever its age.
    pub max_age_hours: Option<f64>,
    /// Reads the stored copy as of this ISO 8601 time or duration, such as
    /// `"P0D"` for stored copies only. An empty value is unset.
    pub as_of: Option<String>,
}

/// An answer across the pages. Sent as the request's `output` group; an
/// empty group asks for a prose answer.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchOutputOptions {
    /// The question to answer from the pages. An empty prompt is unset.
    pub prompt: Option<String>,
    /// A JSON Schema the answer must match; the result is
    /// [`FetchOutput::structured`].
    pub schema: Option<Map<String, Value>>,
}

/// The optional arguments to [`Client::fetch_many_with`]. A group that is
/// `Some` is sent, even when empty; an unset field is not sent.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchManyOptions {
    /// What each page returns.
    pub content: Option<FetchContentOptions>,
    /// How fresh each page must be.
    pub retrieval: Option<FetchRetrievalOptions>,
    /// An answer across the pages.
    pub output: Option<FetchOutputOptions>,
    /// The whole call's time budget in milliseconds, up to 55,000. Pages not
    /// ready by then come back as errors.
    pub deadline_ms: Option<u32>,
    /// Groups the calls of one agent session. An empty value is unset.
    pub session_id: Option<String>,
    /// This call's timeout, retry budget and headers.
    pub request: RequestOptions,
}

/// A link found on a page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchLink {
    /// The link target.
    pub url: String,
    /// The link text, when it has any.
    pub text: Option<String>,
}

/// An image found on a page.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchImage {
    /// The image URL.
    pub url: String,
    /// The image's alt text, when it has any.
    pub alt: Option<String>,
}

/// What one page returned.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchContent {
    /// The page text as markdown. `None` when the page failed or
    /// `max_chars` was 0.
    pub text: Option<String>,
    /// The length of the full text before any cut.
    pub total_chars: Option<u64>,
    /// The values filled from [`FetchContentOptions::schema`].
    pub answer: Option<Map<String, Value>>,
    /// The page's links, when [`FetchContentOptions::links`] asked for them.
    pub links: Option<Vec<FetchLink>>,
    /// The page's images, when [`FetchContentOptions::images`] asked for them.
    pub images: Option<Vec<FetchImage>>,
}

/// Why one URL failed. The call itself succeeded.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchError {
    /// The error type, such as `target_error`.
    #[serde(rename = "type")]
    pub error_type: String,
    /// The error code, such as `page_not_found`.
    pub code: String,
    /// What went wrong.
    pub message: String,
    /// What to do about it, when the API says.
    pub fix: Option<String>,
    /// Whether the same URL may succeed on a retry.
    pub retryable: bool,
    /// The HTTP status the page's server returned, when there was one.
    pub upstream_status: Option<u16>,
    /// The error's `details` object.
    #[serde(skip)]
    pub details: Option<Map<String, Value>>,
}

/// One requested URL, in request order.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchResult {
    /// The URL's position in the request.
    pub index: u64,
    /// The URL as requested.
    pub requested_url: String,
    /// The URL after normalization and redirects.
    pub url: String,
    /// `ok` or `error`.
    pub status: String,
    /// The page title.
    pub title: Option<String>,
    /// When the page was published, as ISO 8601.
    pub published_at: Option<String>,
    /// When Keenable read the page, as ISO 8601.
    pub acquired_at: Option<String>,
    /// The page's main image.
    pub image: Option<String>,
    /// The site's icon.
    pub favicon: Option<String>,
    /// Where the content came from: `index`, `live` or `cache_fallback`.
    pub retrieved_from: Option<String>,
    /// Why this URL failed, when it did.
    pub error: Option<FetchError>,
    /// The page's content.
    pub content: FetchContent,
    /// The unmodified JSON object, so new API fields stay reachable.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

/// A note or warning about the request.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchNotice {
    /// A stable code, such as `value_normalized`.
    pub code: String,
    /// The JSON pointer it is about.
    pub path: Option<String>,
    /// What it means.
    pub message: String,
    /// The notice's `details` object.
    #[serde(skip)]
    pub details: Option<Map<String, Value>>,
}

/// A page passage an answer field rests on.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct Citation {
    /// The [`FetchResult::index`] of the page.
    pub index: u64,
    /// The quoted passages.
    pub excerpts: Vec<String>,
    /// Whether the API found the excerpts on the page.
    pub verified: bool,
}

/// The sources of one answer field.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct Grounding {
    /// The JSON pointer of the field in [`FetchOutput::structured`].
    pub field: String,
    /// The passages it rests on.
    pub citations: Vec<Citation>,
    /// How the value was derived, when the API says.
    pub reasoning: Option<String>,
    /// `low`, `medium` or `high`.
    pub confidence: Option<String>,
}

/// The answer across the pages.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchOutput {
    /// The answer as prose.
    pub text: String,
    /// The answer filled into [`FetchOutputOptions::schema`].
    pub structured: Option<Map<String, Value>>,
    /// The indexes of the pages the answer used.
    pub based_on: Vec<u64>,
    /// The sources of each structured field.
    pub grounding: Vec<Grounding>,
}

/// How many URLs succeeded and failed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct FetchSummary {
    /// The URLs requested.
    pub requested: u64,
    /// The URLs that returned content.
    pub succeeded: u64,
    /// The URLs that failed.
    pub failed: u64,
}

/// What [`Client::fetch_many`] returns.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchResponse {
    /// The API's id for this request. Quote it when reporting a problem.
    pub request_id: Option<String>,
    /// `ok`, `partial` or `error`.
    pub status: Option<String>,
    /// How many URLs succeeded and failed.
    pub summary: FetchSummary,
    /// The values the API chose for options, keyed by JSON pointer, such as
    /// `/retrieval/as_of`.
    pub resolved: BTreeMap<String, String>,
    /// One result per requested URL, in request order.
    pub results: Vec<FetchResult>,
    /// The answer across the pages, when `output` was sent.
    pub output: Option<FetchOutput>,
    /// Notes about the request.
    pub notices: Vec<FetchNotice>,
    /// Warnings about the request, such as a normalized value.
    pub warnings: Vec<FetchNotice>,
    /// The session id the call was grouped under.
    pub session_id: Option<String>,
    /// How long the API took, in milliseconds.
    pub latency_ms: Option<u64>,
    /// The cost of the call.
    #[serde(skip)]
    pub usage: Option<Map<String, Value>>,
    /// The unmodified JSON body.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

impl Client {
    /// Fetches several URLs in one call. Each URL gets its own result, so
    /// one failed page does not fail the call.
    ///
    /// Internal hosts and private addresses are refused here, before a
    /// request is sent.
    pub async fn fetch_many<S: AsRef<str>>(&self, urls: &[S]) -> Result<FetchResponse> {
        self.fetch_many_with(urls, &FetchManyOptions::default())
            .await
    }

    /// [`Client::fetch_many`] with content, freshness and answer options.
    ///
    /// ```no_run
    /// # async fn run() -> Result<(), keenable::Error> {
    /// use keenable::{FetchContentOptions, FetchManyOptions, FetchOutputOptions, FetchRetrievalOptions};
    /// let client = keenable::Client::new()?;
    /// let response = client
    ///     .fetch_many_with(
    ///         &["https://e.com/pricing", "https://f.com/pricing"],
    ///         &FetchManyOptions {
    ///             content: Some(FetchContentOptions { max_chars: Some(20_000), ..Default::default() }),
    ///             retrieval: Some(FetchRetrievalOptions { max_age_hours: Some(24.0), ..Default::default() }),
    ///             output: Some(FetchOutputOptions { prompt: Some("Which plan is cheapest?".into()), ..Default::default() }),
    ///             ..Default::default()
    ///         },
    ///     )
    ///     .await?;
    /// for result in &response.results {
    ///     println!("{} {}", result.url, result.status);
    /// }
    /// if let Some(output) = &response.output {
    ///     println!("{}", output.text);
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn fetch_many_with<S: AsRef<str>>(
        &self,
        urls: &[S],
        opts: &FetchManyOptions,
    ) -> Result<FetchResponse> {
        if urls.is_empty() {
            return Err(Error::invalid(
                "fetch_many() needs a non-empty list of URLs. Pass at least one URL.",
            ));
        }
        for url in urls {
            reject_private_fetch_target(url.as_ref())?;
        }
        let payload = fetch_many_payload(urls, opts)?;
        let body = serde_json::to_vec(&Value::Object(payload)).map_err(|e| {
            Error::invalid(format!(
                "could not encode the fetch request: {e}. Pass JSON-encodable arguments."
            ))
        })?;
        let (data, id) = self
            .send(
                reqwest::Method::POST,
                "fetch",
                Some(body),
                Vec::new(),
                &opts.request,
            )
            .await?;
        Ok(fetch_response_from_json(data, id))
    }
}

fn put_str(group: &mut Map<String, Value>, key: &str, v: &Option<String>) {
    if let Some(s) = v.as_deref().filter(|s| !s.is_empty()) {
        group.insert(key.to_string(), Value::String(s.to_string()));
    }
}

/// Hours as JSON: a whole number as an integer, so 24 goes out as `24`.
fn hours(h: f64) -> Result<Value> {
    if !h.is_finite() {
        return Err(Error::invalid(
            "FetchRetrievalOptions::max_age_hours must be a finite number. Pass 0 to 720.",
        ));
    }
    if h.fract() == 0.0 && (0.0..=crate::models::MAX_SAFE_INTEGER).contains(&h) {
        return Ok(Value::from(h as u64));
    }
    Ok(Number::from_f64(h)
        .map(Value::Number)
        .unwrap_or(Value::Null))
}

/// The JSON body POST /v1/fetch takes: each group that is `Some`, holding
/// the fields set.
fn fetch_many_payload<S: AsRef<str>>(
    urls: &[S],
    o: &FetchManyOptions,
) -> Result<Map<String, Value>> {
    let mut payload = Map::new();
    payload.insert(
        "urls".into(),
        Value::from(urls.iter().map(|u| u.as_ref()).collect::<Vec<_>>()),
    );
    if let Some(c) = &o.content {
        let mut g = Map::new();
        if let Some(n) = c.max_chars {
            g.insert("max_chars".into(), Value::from(n));
        }
        put_str(&mut g, "objective", &c.objective);
        if let Some(s) = &c.schema {
            g.insert("schema".into(), Value::Object(s.clone()));
        }
        if let Some(n) = c.links {
            g.insert("links".into(), Value::from(n));
        }
        if let Some(n) = c.images {
            g.insert("images".into(), Value::from(n));
        }
        payload.insert("content".into(), Value::Object(g));
    }
    if let Some(r) = &o.retrieval {
        let mut g = Map::new();
        if let Some(h) = r.max_age_hours {
            g.insert("max_age_hours".into(), hours(h)?);
        }
        put_str(&mut g, "as_of", &r.as_of);
        payload.insert("retrieval".into(), Value::Object(g));
    }
    if let Some(out) = &o.output {
        let mut g = Map::new();
        put_str(&mut g, "prompt", &out.prompt);
        if let Some(s) = &out.schema {
            g.insert("schema".into(), Value::Object(s.clone()));
        }
        payload.insert("output".into(), Value::Object(g));
    }
    if let Some(n) = o.deadline_ms {
        payload.insert("deadline_ms".into(), Value::from(n));
    }
    put_str(&mut payload, "session_id", &o.session_id);
    Ok(payload)
}

fn objects(v: Option<&Value>) -> impl Iterator<Item = &Map<String, Value>> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
}

/// A string as sent (even empty), or `None` for anything else.
fn str_or_none(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_string)
}

fn string(v: Option<&Value>) -> String {
    str_or_none(v).unwrap_or_default()
}

fn object(v: Option<&Value>) -> Option<Map<String, Value>> {
    v.and_then(Value::as_object).cloned()
}

fn fetch_error_from_json(v: Option<&Value>) -> Option<FetchError> {
    let item = v?.as_object()?;
    let details = object(item.get("details"));
    let upstream_status = details
        .as_ref()
        .and_then(|d| safe_count(d.get("upstream_status")))
        .and_then(|n| u16::try_from(n).ok());
    Some(FetchError {
        error_type: string(item.get("type")),
        code: string(item.get("code")),
        message: string(item.get("message")),
        fix: str_or_none(item.get("fix")),
        retryable: item.get("retryable") == Some(&Value::Bool(true)),
        upstream_status,
        details,
    })
}

fn fetch_result_from_json(data: &Map<String, Value>, position: usize) -> FetchResult {
    let empty = Map::new();
    let content = data
        .get("content")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let list = |key: &str| content.get(key).filter(|v| v.is_array());
    FetchResult {
        index: safe_count(data.get("index")).unwrap_or(position as u64),
        requested_url: string(data.get("requested_url")),
        url: string(data.get("url")),
        status: string(data.get("status")),
        title: non_blank(data.get("title")),
        published_at: non_blank(data.get("published_at")),
        acquired_at: non_blank(data.get("acquired_at")),
        image: non_blank(data.get("image")),
        favicon: non_blank(data.get("favicon")),
        retrieved_from: non_blank(data.get("retrieved_from")),
        error: fetch_error_from_json(data.get("error")),
        content: FetchContent {
            text: str_or_none(content.get("text")),
            total_chars: safe_count(content.get("total_chars")),
            answer: object(content.get("answer")),
            links: list("links").map(|v| {
                objects(Some(v))
                    .map(|item| FetchLink {
                        url: string(item.get("url")),
                        text: non_blank(item.get("text")),
                    })
                    .collect()
            }),
            images: list("images").map(|v| {
                objects(Some(v))
                    .map(|item| FetchImage {
                        url: string(item.get("url")),
                        alt: non_blank(item.get("alt")),
                    })
                    .collect()
            }),
        },
        raw: data.clone(),
    }
}

fn fetch_notices_from_json(v: Option<&Value>) -> Vec<FetchNotice> {
    objects(v)
        .map(|item| FetchNotice {
            code: string(item.get("code")),
            path: str_or_none(item.get("path")),
            message: string(item.get("message")),
            details: object(item.get("details")),
        })
        .collect()
}

fn fetch_output_from_json(v: Option<&Value>) -> Option<FetchOutput> {
    let data = v?.as_object()?;
    let based_on = data
        .get("based_on")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|n| safe_count(Some(n)))
        .collect();
    let grounding = objects(data.get("grounding"))
        .map(|item| Grounding {
            field: string(item.get("field")),
            citations: objects(item.get("citations"))
                .map(|cite| Citation {
                    index: safe_count(cite.get("index")).unwrap_or(0),
                    excerpts: cite
                        .get("excerpts")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect(),
                    verified: cite.get("verified") == Some(&Value::Bool(true)),
                })
                .collect(),
            reasoning: str_or_none(item.get("reasoning")),
            confidence: str_or_none(item.get("confidence")),
        })
        .collect();
    Some(FetchOutput {
        text: string(data.get("text")),
        structured: object(data.get("structured")),
        based_on,
        grounding,
    })
}

pub(crate) fn fetch_response_from_json(
    data: Map<String, Value>,
    header_request_id: Option<String>,
) -> FetchResponse {
    let summary = data.get("summary").and_then(Value::as_object);
    let count = |key: &str| summary.and_then(|s| safe_count(s.get(key))).unwrap_or(0);
    let resolved = data
        .get("resolved")
        .and_then(Value::as_object)
        .map(|m| {
            m.iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string())))
                .collect()
        })
        .unwrap_or_default();
    FetchResponse {
        request_id: non_blank(data.get("request_id")).or(header_request_id),
        status: str_or_none(data.get("status")),
        summary: FetchSummary {
            requested: count("requested"),
            succeeded: count("succeeded"),
            failed: count("failed"),
        },
        resolved,
        results: objects(data.get("results"))
            .enumerate()
            .map(|(position, item)| fetch_result_from_json(item, position))
            .collect(),
        output: fetch_output_from_json(data.get("output")),
        notices: fetch_notices_from_json(data.get("notices")),
        warnings: fetch_notices_from_json(data.get("warnings")),
        session_id: non_blank(data.get("session_id")),
        latency_ms: safe_count(data.get("latency_ms")),
        usage: object(data.get("usage")),
        raw: data,
    }
}
