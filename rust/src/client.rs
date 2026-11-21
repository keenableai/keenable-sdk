//! The client: configuration, the two endpoints, retries and error mapping.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Map, Value};

use crate::error::{ApiError, ConnectionError, Error, RateLimitError, RateLimitInfo, Result};
use crate::guard::{reject_private_fetch_target, resolve_base_url};
use crate::models::{
    non_blank, page_from_json, safe_count, search_response_from_json, FetchResponse, SearchResponse,
};
use crate::retry::{retry_after_header, retry_delay, seconds};
use crate::{json, types, VERSION};

/// The Keenable API used when [`Options::base_url`] and `KEENABLE_API_URL`
/// are both unset.
pub const DEFAULT_BASE_URL: &str = "https://api.keenable.ai";
/// The deadline for one attempt, from sending the request to the end of the
/// body.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);
/// How many times a failed request is retried when [`Options::max_retries`]
/// is `None`.
pub const DEFAULT_MAX_RETRIES: u32 = 2;

const DEFAULT_CLIENT_SOURCE: &str = "Keenable SDK";
/// The longest per-attempt deadline: about 24.8 days, the longest a
/// JavaScript timer can wait. A longer timeout is treated as it, so every SDK
/// treats a huge timeout the same way.
const MAX_TIMEOUT: Duration = Duration::from_millis(2_147_483_647);

/// Configures a [`Client`].
///
/// `Options::default()` reads `KEENABLE_API_KEY` and `KEENABLE_API_URL` and
/// otherwise calls the keyless public API.
///
/// ```no_run
/// use std::time::Duration;
///
/// let client = keenable::Client::with_options(keenable::Options {
///     timeout: Some(Duration::from_secs(10)),
///     client_source: Some("My Agent".into()),
///     ..Default::default()
/// })?;
/// # Ok::<(), keenable::Error>(())
/// ```
#[derive(Default)]
pub struct Options {
    /// The API key. `None` reads `KEENABLE_API_KEY`; `Some("")` forces the
    /// keyless tier even when the variable is set.
    pub api_key: Option<String>,
    /// Overrides `KEENABLE_API_URL`. Must be https, except http to
    /// localhost, 127.0.0.1 or ::1.
    pub base_url: Option<String>,
    /// The deadline for each attempt, headers and body together. `None` means
    /// [`DEFAULT_TIMEOUT`]; zero is an invalid-request error.
    pub timeout: Option<Duration>,
    /// Sent as `X-Keenable-Title`. `None` means "Keenable SDK". Set it when
    /// you build an integration on this SDK, so Keenable attributes your
    /// traffic to your product.
    pub client_source: Option<String>,
    /// How many times to retry a failed request. `None` means
    /// [`DEFAULT_MAX_RETRIES`]; `Some(0)` turns retries off.
    ///
    /// Connection errors, timeouts, 408, 429 and 5xx are retried, unless the
    /// API says the error is not retryable. The wait is the API's Retry-After
    /// when it sent one, else exponential backoff from 0.5 s up to 8 s with
    /// jitter. A Retry-After longer than 60 s is not waited out: the error is
    /// returned at once.
    pub max_retries: Option<u32>,
    /// Headers sent with every request, for example for a proxy or gateway.
    /// `X-API-Key` is ignored here: it always comes from `api_key`.
    pub headers: HashMap<String, String>,
    /// Your own HTTP client settings, for a proxy or custom TLS. The SDK
    /// builds the client from it and turns redirects off, so the API key goes
    /// only to the configured host.
    pub http_client: Option<reqwest::ClientBuilder>,
}

/// Per-call transport settings. Each overrides the client's setting for this
/// call only.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RequestOptions {
    /// The deadline for each attempt of this call. `None` keeps the client's;
    /// zero is an invalid-request error.
    pub timeout: Option<Duration>,
    /// This call's retry budget. `None` keeps the client's; `Some(0)` turns
    /// retries off.
    pub max_retries: Option<u32>,
    /// Headers sent with this call, over [`Options::headers`]. `X-API-Key` is
    /// ignored. A name that is not an HTTP token, or a value with CR, LF or
    /// NUL, is an invalid-request error.
    pub headers: HashMap<String, String>,
}

/// The optional arguments to [`Client::search_with`].
///
/// An empty string is unset and is not sent.
///
/// ```
/// let opts = keenable::SearchOptions {
///     site: Some("arxiv.org".into()),
///     max_results: Some(5),
///     ..Default::default()
/// };
/// # let _ = opts;
/// ```
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SearchOptions {
    /// The search mode: "pro" (the default) does deeper retrieval, and
    /// "realtime" gives the fastest response, for latency-sensitive agent
    /// loops. Sent as given.
    pub mode: Option<String>,
    /// Restricts results to one domain, for example "arxiv.org".
    pub site: Option<String>,
    /// Drops results from these hosts and their subdomains, up to 1,000.
    /// `Some(vec![])` is sent as `[]`.
    pub exclude_domains: Option<Vec<String>>,
    /// Keeps pages published on or after YYYY-MM-DD.
    pub published_after: Option<String>,
    /// Keeps pages published on or before YYYY-MM-DD.
    pub published_before: Option<String>,
    /// Keeps pages Keenable indexed on or after YYYY-MM-DD.
    pub acquired_after: Option<String>,
    /// Keeps pages indexed on or before YYYY-MM-DD.
    pub acquired_before: Option<String>,
    /// Caps the characters of page text per result, from 180 to 10000.
    pub snippet_max_length: Option<u32>,
    /// How many results to return, 1 to 50. The API default is 10.
    pub max_results: Option<u32>,
    /// Searches the index as it stood at this moment; pages newer than it are
    /// excluded. It sets no lower bound, so it is not a recency filter: use
    /// `published_after` for that. An ISO 8601 datetime, YYYY-MM-DD, or an
    /// offset back from now such as "7d".
    pub query_time: Option<String>,
    /// What the search is for, in two or three natural sentences: the facts a
    /// useful page must contain, the task context the query leaves out, the
    /// sources to prefer or exclude, and what is already known. Up to 1,000
    /// characters. The API validates and logs it; it does not change results
    /// or price yet.
    pub objective: Option<String>,
    /// Returns ordinary web pages in place of Keenable's cards, results
    /// Keenable writes for queries such as prices, exchange rates or company
    /// facts (their URLs expire after one day). `false`, the API default, is
    /// not sent.
    pub disable_cards: bool,
    /// This call's timeout, retry budget and headers.
    pub request: RequestOptions,
}

/// The optional arguments to [`Client::fetch_with`]. Only the options set are
/// sent, and the API checks their values.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FetchOptions {
    /// The most characters of content per page.
    pub max_chars: Option<u32>,
    /// Up to 2,000 characters; each page's `content` is then only an LLM's
    /// answer to it.
    pub objective: Option<String>,
    /// A JSON Schema; each page's answer is in `Page::structured`.
    pub schema: Option<Value>,
    /// The most links per page to return.
    pub links: Option<u32>,
    /// The most images per page to return.
    pub images: Option<u32>,
    /// Use a stored copy only if younger than this; 0 reads every page live.
    pub max_age_hours: Option<f64>,
    /// This call's timeout, retry budget and headers.
    pub request: RequestOptions,
}

/// Calls the Keenable web search API.
///
/// Keyless by default: with no API key it uses the public endpoints, which
/// are rate limited per hour. Pass an API key, or set `KEENABLE_API_KEY`, to
/// lift that limit. Create a key at <https://keenable.ai/console>.
///
/// Cloning is cheap and shares the connection pool, so build one client and
/// reuse it.
#[derive(Debug, Clone)]
pub struct Client {
    inner: Arc<Inner>,
}

struct Inner {
    api_key: String,
    base_url: String,
    client_source: String,
    timeout: Duration,
    max_retries: u32,
    headers: HashMap<String, String>,
    http: reqwest::Client,
}

/// How an API key shows in `Debug` output: never the key itself, so a
/// `{:?}` of a client or its options can't put it in a log.
fn redacted_key(key: Option<&str>) -> &'static str {
    match key {
        None => "<unset>",
        Some(k) if k.trim().is_empty() => "<empty>",
        Some(_) => "<redacted>",
    }
}

impl std::fmt::Debug for Options {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Options")
            .field("api_key", &redacted_key(self.api_key.as_deref()))
            .field("base_url", &self.base_url)
            .field("timeout", &self.timeout)
            .field("client_source", &self.client_source)
            .field("max_retries", &self.max_retries)
            .field("headers", &self.headers.keys().collect::<Vec<_>>())
            .field("http_client", &self.http_client.as_ref().map(|_| "<set>"))
            .finish()
    }
}

impl std::fmt::Debug for Inner {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("api_key", &redacted_key(Some(&self.api_key)))
            .field("base_url", &self.base_url)
            .field("client_source", &self.client_source)
            .field("timeout", &self.timeout)
            .field("max_retries", &self.max_retries)
            .field("headers", &self.headers.keys().collect::<Vec<_>>())
            .finish_non_exhaustive()
    }
}

impl Client {
    /// Builds a client from the environment and the defaults.
    pub fn new() -> Result<Client> {
        Client::with_options(Options::default())
    }

    /// Builds a client from [`Options`].
    pub fn with_options(opts: Options) -> Result<Client> {
        let base_url = resolve_base_url(opts.base_url.as_deref())?;
        let timeout = match opts.timeout {
            None => DEFAULT_TIMEOUT,
            Some(t) if t.is_zero() => {
                return Err(Error::invalid(
                    "Options::timeout must be more than zero. Leave it None for the default of 30 seconds.",
                ))
            }
            Some(t) => t,
        };
        check_headers(&opts.headers)?;
        let api_key = opts
            .api_key
            .or_else(|| std::env::var("KEENABLE_API_KEY").ok())
            .unwrap_or_default()
            .trim()
            .to_string();
        let source = opts
            .client_source
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_CLIENT_SOURCE.to_string());
        // Every redirect is refused, the same host included, so X-API-Key
        // never goes anywhere but the configured host. The 3xx is returned as
        // is and becomes the redirect connection error.
        let http = opts
            .http_client
            .unwrap_or_default()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| {
                Error::invalid(format!(
                    "could not build the HTTP client: {e}. Check Options::http_client."
                ))
            })?;
        Ok(Client {
            inner: Arc::new(Inner {
                api_key,
                base_url,
                client_source: source,
                timeout,
                max_retries: opts.max_retries.unwrap_or(DEFAULT_MAX_RETRIES),
                headers: opts.headers,
                http,
            }),
        })
    }

    /// Keenable Monitors: standing searches that report new results as they
    /// appear. Monitors need an API key.
    pub fn monitors(&self) -> crate::monitors::Monitors<'_> {
        crate::monitors::Monitors::new(self)
    }

    pub(crate) fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    /// Whether the keyless public tier is in use.
    pub fn is_keyless(&self) -> bool {
        self.inner.api_key.is_empty()
    }

    /// Searches the web and returns ranked pages with their text extracted.
    ///
    /// Describe the ideal page in natural language ("blog post comparing
    /// React and Vue performance") rather than keywords.
    pub async fn search(&self, query: &str) -> Result<SearchResponse> {
        self.search_with(query, &SearchOptions::default()).await
    }

    /// [`Client::search`] with filters and per-call settings.
    pub async fn search_with(&self, query: &str, opts: &SearchOptions) -> Result<SearchResponse> {
        let mut payload = Map::new();
        let put = |payload: &mut Map<String, Value>, key: &str, v: &Option<String>| {
            if let Some(s) = v.as_deref().filter(|s| !s.is_empty()) {
                payload.insert(key.to_string(), Value::String(s.to_string()));
            }
        };
        put(&mut payload, "site", &opts.site);
        if let Some(hosts) = &opts.exclude_domains {
            payload.insert("exclude_domains".into(), Value::from(hosts.clone()));
        }
        put(&mut payload, "published_after", &opts.published_after);
        put(&mut payload, "published_before", &opts.published_before);
        put(&mut payload, "acquired_after", &opts.acquired_after);
        put(&mut payload, "acquired_before", &opts.acquired_before);
        if let Some(n) = opts.snippet_max_length {
            payload.insert("snippet_max_length".into(), Value::from(n));
        }
        if let Some(n) = opts.max_results {
            payload.insert("max_results".into(), Value::from(n));
        }
        put(&mut payload, "query_time", &opts.query_time);
        put(&mut payload, "objective", &opts.objective);
        if opts.disable_cards {
            payload.insert("disable_cards".into(), Value::Bool(true));
        }
        self.search_payload(query, opts.mode.as_deref(), payload, &opts.request)
            .await
    }

    /// Sends a search with `filters` already in wire form.
    pub(crate) async fn search_payload(
        &self,
        query: &str,
        mode: Option<&str>,
        mut payload: Map<String, Value>,
        request: &RequestOptions,
    ) -> Result<SearchResponse> {
        if query.trim().is_empty() {
            return Err(Error::invalid(
                "search() needs a non-empty query. Pass the question as the query argument.",
            ));
        }
        let mode = mode.filter(|m| !m.is_empty()).unwrap_or("pro");
        payload.insert("query".into(), Value::String(query.to_string()));
        payload.insert("mode".into(), Value::String(mode.to_string()));
        let body = serde_json::to_vec(&Value::Object(payload)).map_err(|e| {
            Error::invalid(format!(
                "could not encode the search request: {e}. Pass JSON-encodable arguments."
            ))
        })?;
        let (data, id) = self
            .send(
                reqwest::Method::POST,
                "search",
                Some(body),
                Vec::new(),
                request,
            )
            .await?;
        Ok(search_response_from_json(data, query, id))
    }

    /// Reads pages as markdown with `POST /v1/fetch`. `results[i]` is for
    /// `urls[i]`: a [`Page`](crate::Page), with `error` set when that URL
    /// failed. Internal hosts and private addresses are refused here, before
    /// a request is sent.
    pub async fn fetch<I>(&self, urls: I) -> Result<FetchResponse>
    where
        I: IntoIterator,
        I::Item: AsRef<str>,
    {
        self.fetch_with(urls, &FetchOptions::default()).await
    }

    /// [`Client::fetch`] with the options in [`FetchOptions`] and per-call
    /// settings.
    pub async fn fetch_with<I>(&self, urls: I, opts: &FetchOptions) -> Result<FetchResponse>
    where
        I: IntoIterator,
        I::Item: AsRef<str>,
    {
        let urls: Vec<String> = urls.into_iter().map(|u| u.as_ref().to_string()).collect();
        for url in &urls {
            reject_private_fetch_target(url)?;
        }
        let mut content = Map::new();
        let options = [
            ("max_chars", opts.max_chars.map(Value::from)),
            ("objective", opts.objective.clone().map(Value::from)),
            ("schema", opts.schema.clone()),
            ("links", opts.links.map(Value::from)),
            ("images", opts.images.map(Value::from)),
        ];
        for (name, value) in options {
            if let Some(value) = value {
                content.insert(name.into(), value);
            }
        }
        let mut payload = Map::new();
        payload.insert("urls".into(), Value::from(urls.clone()));
        if !content.is_empty() {
            payload.insert("content".into(), Value::Object(content));
        }
        if let Some(hours) = opts.max_age_hours {
            payload.insert(
                "retrieval".into(),
                serde_json::json!({ "max_age_hours": hours }),
            );
        }
        let body = serde_json::to_vec(&payload)
            .map_err(|e| Error::invalid(format!("could not encode the fetch request: {e}")))?;
        let (data, id) = self
            .send(
                reqwest::Method::POST,
                "fetch",
                Some(body),
                Vec::new(),
                &opts.request,
            )
            .await?;
        let results = match data.get("results") {
            Some(Value::Array(items)) => items
                .iter()
                .enumerate()
                .filter_map(|(i, item)| {
                    let asked = urls.get(i).map_or("", String::as_str);
                    Some(page_from_json(item.as_object()?.clone(), asked))
                })
                .collect(),
            _ => Vec::new(),
        };
        Ok(FetchResponse {
            results,
            request_id: non_blank(data.get("request_id")).or(id),
            raw: data,
        })
    }

    fn endpoint_url(&self, endpoint: &str, query: &[(String, String)]) -> String {
        let mut url = format!("{}/v1/{endpoint}", self.inner.base_url);
        if self.is_keyless() {
            url.push_str("/public");
        }
        if !query.is_empty() {
            let encoded = url::form_urlencoded::Serializer::new(String::new())
                .extend_pairs(query)
                .finish();
            url.push('?');
            url.push_str(&encoded);
        }
        url
    }

    /// The SDK's own headers, then the client's, then the call's. The API key
    /// always comes from the client, so a stray header cannot send a
    /// different key or turn a keyless call keyed.
    fn headers(&self, json_body: bool, extra: &HashMap<String, String>) -> Result<HeaderMap> {
        let mut h = HeaderMap::new();
        let mut set = |name: &str, value: &str| -> Result<()> {
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| Error::invalid(format!("header name {name:?} is not a valid HTTP header name. Use letters, digits and -.")))?;
            let value = HeaderValue::from_bytes(value.as_bytes()).map_err(|_| {
                Error::invalid(format!(
                    "header {name:?} has a character HTTP does not allow in its value. Remove it."
                ))
            })?;
            h.insert(name, value);
            Ok(())
        };
        set("Accept", "application/json")?;
        set("User-Agent", &format!("keenable-rust/{VERSION}"))?;
        // The public tier rejects requests without this header.
        set("X-Keenable-Title", &self.inner.client_source)?;
        for src in [&self.inner.headers, extra] {
            for (k, v) in src {
                if !k.eq_ignore_ascii_case("x-api-key") {
                    set(k, v)?;
                }
            }
        }
        if !self.inner.api_key.is_empty() {
            set("X-API-Key", &self.inner.api_key)?;
        }
        if json_body {
            set("Content-Type", "application/json")?;
        }
        Ok(h)
    }

    async fn send(
        &self,
        method: reqwest::Method,
        endpoint: &str,
        body: Option<Vec<u8>>,
        query: Vec<(String, String)>,
        opts: &RequestOptions,
    ) -> Result<(Map<String, Value>, Option<String>)> {
        let url = self.endpoint_url(endpoint, &query);
        self.send_url(method, url, body, &HashMap::new(), opts, true)
            .await
    }

    /// Makes the attempts of one call to `url`. `extra` headers go under the
    /// call's own. When `safe` is false (a call that may act twice), only a
    /// 429 is retried: the API sends it before doing anything.
    pub(crate) async fn send_url(
        &self,
        method: reqwest::Method,
        url: String,
        body: Option<Vec<u8>>,
        extra: &HashMap<String, String>,
        opts: &RequestOptions,
        safe: bool,
    ) -> Result<(Map<String, Value>, Option<String>)> {
        let timeout = match opts.timeout {
            None => self.inner.timeout,
            Some(t) if t.is_zero() => {
                return Err(Error::invalid(
                    "RequestOptions::timeout must be more than zero. Leave it None to keep the client's.",
                ))
            }
            Some(t) => t,
        }
        .min(MAX_TIMEOUT);
        let retries = opts.max_retries.unwrap_or(self.inner.max_retries);
        check_headers(&opts.headers)?;
        let mut call_headers: HashMap<String, String> = extra
            .iter()
            .filter(|(k, _)| !opts.headers.keys().any(|o| o.eq_ignore_ascii_case(k)))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        call_headers.extend(opts.headers.clone());
        let headers = self.headers(body.is_some(), &call_headers)?;
        let mut retry = 0;
        loop {
            let err = match self
                .attempt(method.clone(), &url, body.clone(), headers.clone(), timeout)
                .await
            {
                Ok(done) => return Ok(done),
                Err(err) => err,
            };
            let rate_limited = matches!(err, Error::RateLimit(_));
            if retry >= retries || !(safe || rate_limited) {
                return Err(err);
            }
            let Some(wait) = retry_delay(&err, retry, rand::random::<f64>()) else {
                return Err(err);
            };
            pause(wait).await;
            retry += 1;
        }
    }

    /// Sends one request with its own deadline, covering the body too, and
    /// decodes the reply.
    async fn attempt(
        &self,
        method: reqwest::Method,
        url: &str,
        body: Option<Vec<u8>>,
        headers: HeaderMap,
        timeout: Duration,
    ) -> Result<(Map<String, Value>, Option<String>)> {
        let mut req = self.inner.http.request(method, url).headers(headers);
        if let Some(body) = body {
            req = req.body(body);
        }
        let exchange = async {
            let resp = req.send().await?;
            let status = resp.status().as_u16();
            let headers = resp.headers().clone();
            let raw = resp.bytes().await?;
            Ok::<_, reqwest::Error>((status, headers, raw))
        };
        let (status, headers, raw) = match tokio::time::timeout(timeout, exchange).await {
            Err(_) => return Err(timeout_error(timeout)),
            Ok(Err(e)) if e.is_timeout() => return Err(timeout_error(timeout)),
            Ok(Err(e)) => {
                return Err(Error::Connection(ConnectionError {
                    msg: format!(
                        "could not reach the Keenable API: {}. Check KEENABLE_API_URL and retry.",
                        error_chain(&e)
                    ),
                    timeout: false,
                    redirect: false,
                }))
            }
            Ok(Ok(reply)) => reply,
        };
        if (300..400).contains(&status) {
            // No redirect is followed. Report it rather than an API error
            // that says to retry.
            let to = header_value(&headers, "Location")
                .map(|loc| format!(" to {loc}"))
                .unwrap_or_default();
            return Err(Error::Connection(ConnectionError {
                msg: format!(
                    "the Keenable API redirected{to}. The redirect was not followed, so the API key was not sent. Check KEENABLE_API_URL."
                ),
                timeout: false,
                redirect: true,
            }));
        }
        if !(200..300).contains(&status) {
            return Err(to_api_error(status, &raw, &headers, self.is_keyless()));
        }
        let id = header_value(&headers, "X-Request-Id");
        let snippet = || {
            let cut = &raw[..raw.len().min(200)];
            format!("{:?}", String::from_utf8_lossy(cut))
        };
        match json::parse(&raw) {
            Some(Value::Object(obj)) => Ok((obj, id)),
            Some(_) => Err(Error::Api(Box::new(ApiError::plain(
                status,
                format!(
                    "Unexpected response from the Keenable API: {}. Retry the request. If it keeps failing, confirm KEENABLE_API_URL.",
                    snippet()
                ),
                id,
            )))),
            None => Err(Error::Api(Box::new(ApiError::plain(
                status,
                format!(
                    "Keenable API returned a non-JSON response: {}. Retry the request. If it keeps failing, confirm KEENABLE_API_URL.",
                    snippet()
                ),
                id,
            )))),
        }
    }
}

fn timeout_error(timeout: Duration) -> Error {
    Error::Connection(ConnectionError {
        msg: format!(
            "the Keenable API did not respond within {timeout:?}. Raise Options::timeout."
        ),
        timeout: true,
        redirect: false,
    })
}

/// A reqwest error with its causes, which carry the useful part ("connection
/// refused").
fn error_chain(e: &reqwest::Error) -> String {
    let mut text = e.to_string();
    let mut source = std::error::Error::source(e);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

/// Waits before a retry. Tests record the wait instead.
async fn pause(wait: Duration) {
    #[cfg(test)]
    if crate::test_hooks::record_wait(wait) {
        return;
    }
    tokio::time::sleep(wait).await;
}

/// Refuses a header the transport would refuse, before anything is sent: a
/// name that is not an HTTP token, or a value with CR, LF or NUL. Sent
/// anyway, it would fail as a connection error that is retried for nothing.
fn check_headers(h: &HashMap<String, String>) -> Result<()> {
    for (name, value) in h {
        let token = |c: char| c.is_ascii_alphanumeric() || "!#$%&'*+-.^_`|~".contains(c);
        if name.is_empty() || !name.chars().all(token) {
            return Err(Error::invalid(format!(
                "header name {name:?} is not a valid HTTP header name. Use letters, digits and -."
            )));
        }
        if value.contains(['\r', '\n', '\0']) {
            return Err(Error::invalid(format!(
                "header {name:?} has a CR, LF or NUL in its value. Remove it."
            )));
        }
    }
    Ok(())
}

fn header_value(h: &HeaderMap, key: &str) -> Option<String> {
    let v = h.get(key)?;
    let text = String::from_utf8_lossy(v.as_bytes()).trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn header_u64(h: &HeaderMap, key: &str) -> Option<u64> {
    header_value(h, key)?.parse().ok()
}

/// Codes about the page being fetched rather than about Keenable or the
/// caller, besides every `target_*` code. Servers before error format v1 send
/// no `type`, so it is derived from these and the status.
fn derive_type(status: u16, code: Option<&str>) -> &'static str {
    let code = code.unwrap_or("");
    if code.starts_with("target_") || code == "page_not_found" || code == "content_not_extracted" {
        return types::TARGET_ERROR;
    }
    match status {
        401 => types::AUTHENTICATION_ERROR,
        403 => types::PERMISSION_ERROR,
        402 | 451 => types::BILLING_ERROR,
        429 => types::RATE_LIMIT_ERROR,
        400..=499 => types::INVALID_REQUEST_ERROR,
        _ => types::API_ERROR,
    }
}

/// 429 codes for a limit that is not the caller's own (ours or the fetched
/// site's), so a key would not lift it.
fn not_your_limit(code: Option<&str>) -> bool {
    matches!(
        code,
        Some("target_rate_limited" | "search_rate_limited" | "fetch_rate_limited")
    )
}

/// Appends `more` as a new sentence, without doubling a final period.
fn sentence(msg: &str, more: &str) -> String {
    if msg.ends_with('.') {
        format!("{msg} {more}")
    } else {
        format!("{msg}. {more}")
    }
}

/// A 402's message, the same in every SDK. A pay-per-request (x402) response
/// is one this SDK cannot pay, so it says to use a key; its offer (accepts,
/// payTo, networks) is not passed on.
fn payment_message(body: &Map<String, Value>, code: Option<&str>) -> String {
    if code.is_some_and(|c| c.starts_with("payment_"))
        || body.contains_key("accepts")
        || body.contains_key("x402Version")
    {
        "Keenable: payment required (402). This SDK does not pay per request: set KEENABLE_API_KEY to call the API with a key instead.".into()
    } else {
        "Keenable: insufficient credits (402). The organization is out of credits; retrying fails the same way until a human with console access adds more.".into()
    }
}

pub(crate) fn to_api_error(status: u16, raw: &[u8], headers: &HeaderMap, keyless: bool) -> Error {
    let (obj, detail) = match json::parse(raw) {
        // Not JSON: the text is the best detail there is.
        None => {
            let text = String::from_utf8_lossy(raw).trim().to_string();
            (Map::new(), (!text.is_empty()).then_some(text))
        }
        Some(Value::Object(m)) => {
            let detail = ["message", "error", "detail"]
                .iter()
                .find_map(|k| non_blank(m.get(*k)));
            (m, detail)
        }
        // JSON that is not an object gives no detail and no fields.
        Some(_) => (Map::new(), None),
    };
    build_api_error(status, &obj, detail, headers, keyless)
}

fn build_api_error(
    status: u16,
    obj: &Map<String, Value>,
    detail: Option<String>,
    headers: &HeaderMap,
    keyless: bool,
) -> Error {
    let field = |k: &str| non_blank(obj.get(k));
    let code = field("code");
    let mut api = ApiError::plain(status, String::new(), None);
    api.body = detail.clone();
    api.error_type =
        field("type").unwrap_or_else(|| derive_type(status, code.as_deref()).to_string());
    api.error = field("error");
    api.fix = field("fix");
    api.request_id = field("request_id").or_else(|| header_value(headers, "X-Request-Id"));
    api.param = field("param");
    api.retryable = obj.get("retryable").and_then(Value::as_bool);
    let secs = |k: &str| obj.get(k).and_then(Value::as_f64).and_then(seconds);
    api.retry_after = secs("retry_after_seconds")
        .or_else(|| header_value(headers, "Retry-After").and_then(|v| retry_after_header(&v)))
        .or_else(|| secs("retryAfter"));
    if let Some(Value::Object(l)) = obj.get("limit") {
        api.limit = Some(RateLimitInfo {
            scope: non_blank(l.get("scope")),
            window: non_blank(l.get("window")),
            max: safe_count(l.get("max")),
            resets_at: non_blank(l.get("resets_at")),
        });
    }
    if status == 400 && field("error").as_deref() == Some("invalid_filter") {
        if api.param.is_none() {
            api.param = field("field");
        }
        api.value = field("value");
        api.reason = field("reason");
    }
    api.code = code;

    // A 401/403 about the page being fetched is not an authentication failure.
    let auth = (status == 401 || status == 403) && api.error_type != types::TARGET_ERROR;
    if status == 402 {
        // The API's text for a 402 points at billing pages and payment
        // offers, which the SDKs do not pass on; the next step is the SDK's.
        api.msg = payment_message(obj, api.code.as_deref());
        return Error::InsufficientCredits(Box::new(api));
    }
    let label = match status {
        401 | 403 if auth => format!("Keenable authentication failed ({status})"),
        429 => "Keenable rate limit exceeded (429)".to_string(),
        _ => format!("Keenable API error ({status})"),
    };
    let mut msg = match &detail {
        Some(d) => format!("{label}: {d}"),
        None => label,
    };
    // When the API sends a fix, it is the next step for every status: it is
    // specific to this failure and says whether a retry can help.
    if let Some(fix) = &api.fix {
        msg = sentence(&msg, fix);
    } else if auth {
        msg.push_str(". Check KEENABLE_API_KEY, or pass Options::api_key.");
    } else if status == 429 && not_your_limit(api.code.as_deref()) {
        msg.push_str(". Wait for the rate limit window to reset, then retry.");
    } else if status == 429 && keyless {
        msg.push_str(". Set KEENABLE_API_KEY to lift the keyless hourly cap. Create a key at https://keenable.ai/console.");
    } else if status == 429 {
        msg.push_str(". Wait for the rate limit window to reset, then retry.");
    } else if (400..500).contains(&status) && status != 408 && api.retryable != Some(true) {
        // The SDK does not retry these, so the advice must not say to either.
        msg.push_str(". Check the request: sending it again unchanged fails the same way.");
    } else {
        msg.push_str(". Retry the request. If it keeps failing, confirm KEENABLE_API_URL.");
    }
    if status == 429 {
        if let Some(reset) = header_value(headers, "X-RateLimit-Reset") {
            msg.push_str(&format!(" Retry after {reset}."));
        } else if let Some(wait) = api.retry_after.filter(|w| !w.is_zero()) {
            msg.push_str(&format!(" Retry after {wait:?}."));
        }
    }
    api.msg = msg;
    if auth {
        return Error::Auth(Box::new(api));
    }
    if status == 429 {
        return Error::RateLimit(Box::new(RateLimitError {
            api,
            header_limit: header_u64(headers, "X-RateLimit-Limit"),
            header_remaining: header_u64(headers, "X-RateLimit-Remaining"),
            header_reset: header_value(headers, "X-RateLimit-Reset"),
        }));
    }
    Error::Api(Box::new(api))
}
