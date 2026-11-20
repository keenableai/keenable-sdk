//! `fetch`: up to 10 URLs in one POST /v1/fetch call, one result per URL.

use serde::Serialize;
use serde_json::{Map, Number, Value};

use crate::client::{to_api_error, Client, RequestOptions};
use crate::error::{Error, Result};
use crate::guard::reject_private_fetch_target;
use crate::models::{non_blank, page_from_json, safe_count, Page};

const MAX_URLS: usize = 10;
const MAX_LINKS: u32 = 1000;
const MAX_IMAGES: u32 = 25;
const MAX_AGE_HOURS: f64 = 720.0;

/// The optional arguments to [`Client::fetch_with`]. Each applies to every
/// page, and an unset option is not sent.
///
/// ```
/// let opts = keenable::FetchOptions {
///     max_chars: Some(20_000),
///     max_age_hours: Some(24.0),
///     ..Default::default()
/// };
/// # let _ = opts;
/// ```
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchOptions {
    /// The most characters of content per page, at least 1. `None` means the
    /// API's default of 50000. [`Page::truncated`] and [`Page::total_chars`]
    /// say whether a page was cut.
    pub max_chars: Option<u32>,
    /// A JSON Schema whose root has `"type": "object"`. Each page's typed
    /// answer is in [`Page::structured`], or [`Page::answer_error`] says why
    /// it could not be made.
    pub schema: Option<Value>,
    /// The most links per page to return, 1 to 1000.
    pub links: Option<u32>,
    /// The most images per page to return, 0 to 25.
    pub images: Option<u32>,
    /// Uses a stored copy only if it is younger than this, 0 to 720 hours
    /// (fractions allowed); `Some(0.0)` reads every page live. `None` uses a
    /// stored copy of any age when there is one.
    pub max_age_hours: Option<f64>,
    /// This call's timeout, retry budget and headers.
    pub request: RequestOptions,
}

/// A link on a fetched page, with the words it was written as.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchLink {
    /// The link target.
    pub url: String,
    /// The link text, when it has any.
    pub text: Option<String>,
}

/// An image on a fetched page, with its alt text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchImage {
    /// The image URL.
    pub url: String,
    /// The image's alt text, when it has any.
    pub alt: Option<String>,
}

/// Why the typed answer for [`FetchOptions::schema`] could not be made. The
/// page is still read.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchAnswerError {
    /// The reason, such as `answer_failed`.
    pub code: String,
    /// What went wrong.
    pub message: String,
}

/// What reading one page cost.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchUsage {
    /// What was billed.
    pub sku: String,
    /// How many units were billed.
    pub amount: u64,
    /// The credits charged.
    pub credits: f64,
    /// `true` when paid credits were spent, `false` for free ones.
    pub paid: bool,
    /// The credits left after this page, when the API says.
    pub credits_remaining: Option<f64>,
}

/// The result for one URL: `page` when it was read, else `error`.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct FetchResult {
    /// The page's final address, or the URL that failed.
    pub url: String,
    /// The page, when it was read.
    pub page: Option<Page>,
    /// Why this URL failed: the error the call would return for that status.
    /// [`Client::fetch`] does not return it.
    pub error: Option<Error>,
}

/// What [`Client::fetch`] returns: `results[i]` is for `urls[i]`.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub struct FetchResponse {
    /// One result per URL, in order.
    pub results: Vec<FetchResult>,
    /// The API's id for this request. Quote it when reporting a problem.
    pub request_id: Option<String>,
}

impl Client {
    /// Reads up to 10 pages as markdown in one call.
    ///
    /// `results[i]` is for `urls[i]`: its page, or its error when that URL
    /// failed. A failed URL is not returned as an `Err`; the call fails only
    /// as a whole. Internal hosts and private addresses are refused here,
    /// before a request is sent.
    pub async fn fetch<S: AsRef<str>>(&self, urls: &[S]) -> Result<FetchResponse> {
        self.fetch_with(urls, &FetchOptions::default()).await
    }

    /// [`Client::fetch`] with content and freshness options and per-call
    /// settings.
    ///
    /// ```no_run
    /// # async fn run() -> Result<(), keenable::Error> {
    /// let client = keenable::Client::new()?;
    /// let response = client
    ///     .fetch_with(
    ///         &["https://e.com/pricing", "https://f.com/pricing"],
    ///         &keenable::FetchOptions { max_chars: Some(20_000), ..Default::default() },
    ///     )
    ///     .await?;
    /// for result in &response.results {
    ///     match (&result.page, &result.error) {
    ///         (Some(page), _) => println!("{}", page.title),
    ///         (_, Some(error)) => println!("{}: {error}", result.url),
    ///         _ => {}
    ///     }
    /// }
    /// # Ok(())
    /// # }
    /// ```
    pub async fn fetch_with<S: AsRef<str>>(
        &self,
        urls: &[S],
        opts: &FetchOptions,
    ) -> Result<FetchResponse> {
        let payload = fetch_payload(urls, opts)?;
        let body = serde_json::to_vec(&Value::Object(payload)).map_err(|e| {
            Error::invalid(format!(
                "could not encode the fetch request: {e}. Pass a JSON-encodable schema."
            ))
        })?;
        let (data, id) = self.send("fetch", body, &opts.request).await?;
        Ok(FetchResponse {
            results: self.fetch_results(data.get("results"), urls),
            request_id: non_blank(data.get("request_id")).or(id),
        })
    }

    /// The reply's results: a failed URL's error object becomes the error
    /// that status would return, any other object a page.
    fn fetch_results<S: AsRef<str>>(&self, v: Option<&Value>, urls: &[S]) -> Vec<FetchResult> {
        let Some(Value::Array(items)) = v else {
            return Vec::new();
        };
        items
            .iter()
            .enumerate()
            .filter_map(|(i, item)| {
                let entry = item.as_object()?;
                let asked = urls.get(i).map_or("", |u| u.as_ref());
                Some(match entry.get("error") {
                    Some(Value::Object(failure)) => {
                        let status = safe_count(failure.get("status"))
                            .filter(|s| (400..=599).contains(s))
                            .map_or(500, |s| s as u16);
                        let raw = serde_json::to_vec(failure).unwrap_or_default();
                        FetchResult {
                            url: non_blank(entry.get("url")).unwrap_or_else(|| asked.to_string()),
                            page: None,
                            error: Some(to_api_error(
                                status,
                                &raw,
                                &reqwest::header::HeaderMap::new(),
                                self.is_keyless(),
                            )),
                        }
                    }
                    _ => {
                        let page = page_from_json(entry.clone(), asked);
                        FetchResult {
                            url: page.url.clone(),
                            page: Some(page),
                            error: None,
                        }
                    }
                })
            })
            .collect()
    }
}

/// Hours as JSON: a whole number as an integer, so 24 goes out as `24`.
fn hours(h: f64) -> Value {
    if h.fract() == 0.0 {
        return Value::from(h as u64);
    }
    Number::from_f64(h).map_or(Value::Null, Value::Number)
}

/// The JSON body POST /v1/fetch takes, after checking the URLs and holding
/// every option to the API's limits.
fn fetch_payload<S: AsRef<str>>(urls: &[S], o: &FetchOptions) -> Result<Map<String, Value>> {
    if urls.is_empty() || urls.len() > MAX_URLS {
        return Err(Error::invalid(format!(
            "fetch() needs 1 to {MAX_URLS} URLs, got {}.",
            urls.len()
        )));
    }
    for url in urls {
        reject_private_fetch_target(url.as_ref())?;
    }
    let mut payload = Map::new();
    payload.insert(
        "urls".into(),
        Value::from(urls.iter().map(|u| u.as_ref()).collect::<Vec<_>>()),
    );
    let mut content = Map::new();
    if let Some(n) = o.max_chars {
        if n < 1 {
            return Err(Error::invalid(
                "FetchOptions::max_chars must be at least 1. Leave it None for the API's default.",
            ));
        }
        content.insert("max_chars".into(), Value::from(n));
    }
    if let Some(schema) = &o.schema {
        if schema.get("type").and_then(Value::as_str) != Some("object") {
            return Err(Error::invalid(
                "FetchOptions::schema must be a JSON Schema whose root has \"type\": \"object\".",
            ));
        }
        content.insert("schema".into(), schema.clone());
    }
    if let Some(n) = o.links {
        if !(1..=MAX_LINKS).contains(&n) {
            return Err(Error::invalid(format!(
                "FetchOptions::links must be from 1 to {MAX_LINKS}, got {n}."
            )));
        }
        content.insert("links".into(), Value::from(n));
    }
    if let Some(n) = o.images {
        if n > MAX_IMAGES {
            return Err(Error::invalid(format!(
                "FetchOptions::images must be from 0 to {MAX_IMAGES}, got {n}."
            )));
        }
        content.insert("images".into(), Value::from(n));
    }
    if !content.is_empty() {
        payload.insert("content".into(), Value::Object(content));
    }
    if let Some(h) = o.max_age_hours {
        if !(0.0..=MAX_AGE_HOURS).contains(&h) {
            return Err(Error::invalid(format!(
                "FetchOptions::max_age_hours must be from 0 to {MAX_AGE_HOURS}, got {h}."
            )));
        }
        let mut retrieval = Map::new();
        retrieval.insert("max_age_hours".into(), hours(h));
        payload.insert("retrieval".into(), Value::Object(retrieval));
    }
    Ok(payload)
}

fn objects(v: Option<&Value>) -> impl Iterator<Item = &Map<String, Value>> {
    v.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_object)
}

fn string(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or_default().to_string()
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

pub(crate) fn fetch_links(v: Option<&Value>) -> Option<Vec<FetchLink>> {
    v?.as_array()?;
    Some(
        objects(v)
            .map(|item| FetchLink {
                url: string(item.get("url")),
                text: non_blank(item.get("text")),
            })
            .collect(),
    )
}

pub(crate) fn fetch_images(v: Option<&Value>) -> Option<Vec<FetchImage>> {
    v?.as_array()?;
    Some(
        objects(v)
            .map(|item| FetchImage {
                url: string(item.get("url")),
                alt: non_blank(item.get("alt")),
            })
            .collect(),
    )
}

pub(crate) fn fetch_answer_error(v: Option<&Value>) -> Option<FetchAnswerError> {
    let m = v?.as_object()?;
    Some(FetchAnswerError {
        code: string(m.get("code")),
        message: string(m.get("message")),
    })
}

pub(crate) fn fetch_usage(v: Option<&Value>) -> Option<FetchUsage> {
    let m = v?.as_object()?;
    Some(FetchUsage {
        sku: string(m.get("sku")),
        amount: safe_count(m.get("amount")).unwrap_or(0),
        credits: finite(m.get("credits")).unwrap_or(0.0),
        paid: m.get("paid") == Some(&Value::Bool(true)),
        credits_remaining: finite(m.get("credits_remaining")),
    })
}
