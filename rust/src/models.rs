//! What `search` and `fetch` return, and the citable block they render.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::context_clean::clean_context_text;
use crate::retry::civil_from_days;

/// The `to_context` budget: about 3k tokens, enough for a handful of results
/// without crowding out the rest of the prompt.
pub const DEFAULT_CONTEXT_MAX_CHARS: usize = 12_000;
/// The per-result cap `to_context` applies to page text. Snippets are often
/// whole pages (4,000 to 13,000 characters); uncapped, one or two eat the
/// budget meant for every source.
pub const DEFAULT_CONTEXT_MAX_SNIPPET_CHARS: usize = 2_000;

/// One page returned by [`Client::search`](crate::Client::search).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct SearchResult {
    /// The page title.
    pub title: String,
    /// The page URL.
    pub url: String,
    /// The page text Keenable extracted.
    pub snippet: String,
    /// The ISO 8601 publication time, when the page exposes one. A date the
    /// API sends as Unix seconds is given as ISO 8601 UTC, such as
    /// `2024-05-01T12:00:00Z`.
    pub published_at: Option<String>,
    /// When Keenable indexed the page, in the same form as `published_at`.
    pub acquired_at: Option<String>,
    /// The unmodified JSON object, so new API fields stay reachable.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

/// The result set for one [`Client::search`](crate::Client::search) call.
///
/// Iterate over [`SearchResponse::results`]. [`SearchResponse::cited`]
/// reports the subset [`SearchResponse::to_context`] numbered, so a source
/// list can match the model's `[1]`, `[2]`, `[3]` citations.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct SearchResponse {
    /// The query the API searched for.
    pub query: String,
    /// The search mode the API used.
    pub mode: Option<String>,
    /// The ranked pages.
    pub results: Vec<SearchResult>,
    /// The API's id for this request. Quote it when reporting a problem.
    pub request_id: Option<String>,
    /// What the request should change, such as a deprecated parameter it
    /// used; the request was still served. Empty when the API sent none.
    pub warnings: Vec<SearchWarning>,
    /// What the search cost and, with a key, the balance left after it.
    /// `None` when the API sent none, as on keyless calls.
    pub usage: Option<Usage>,
    /// The unmodified JSON body.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

/// Something in a search request to change, such as a deprecated parameter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[non_exhaustive]
pub struct SearchWarning {
    /// The kind of warning, such as `deprecated_parameter`.
    pub code: String,
    /// A JSON pointer to the request parameter, such as `/safety_mode`.
    pub path: String,
    /// What to change and by when.
    pub message: String,
}

/// What [`Client::fetch`](crate::Client::fetch) returns: `results[i]` is for
/// `urls[i]`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct FetchResponse {
    /// One page per URL asked for.
    pub results: Vec<Page>,
    /// The API's id for this request. Quote it when reporting a problem.
    pub request_id: Option<String>,
    /// The unmodified JSON body.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

/// Why one URL of a fetch failed, as the API sent it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct FetchError {
    /// The HTTP status this URL failed with.
    pub status: u16,
    /// The API's short error title.
    pub error: String,
    /// The API's machine-readable reason.
    pub code: Option<String>,
    /// The error's category.
    #[serde(rename = "type")]
    pub error_type: Option<String>,
    /// The API's message.
    pub message: Option<String>,
    /// One sentence on what to do next.
    pub fix: Option<String>,
    /// Whether trying this URL again can succeed.
    pub retryable: Option<bool>,
}

/// A link on a fetched page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct PageLink {
    /// Where the link goes.
    pub url: String,
    /// The link's text.
    pub text: Option<String>,
}

/// An image on a fetched page.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct PageImage {
    /// The image URL.
    pub url: String,
    /// The image's alt text.
    pub alt: Option<String>,
}

/// Why the answer for [`FetchOptions::schema`](crate::FetchOptions::schema)
/// could not be made.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct AnswerError {
    /// The machine-readable reason.
    pub code: String,
    /// What went wrong.
    pub message: String,
}

/// What reading one page cost.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Usage {
    /// The billed item.
    pub sku: String,
    /// How many were billed.
    pub amount: u64,
    /// The credits spent.
    pub credits: f64,
    /// `true` when paid credits were spent.
    pub paid: bool,
    /// The credits left after this page.
    pub credits_remaining: Option<f64>,
    /// What this page cost, in US dollars. `None` when the API did not send it.
    #[serde(default)]
    pub cost: Option<Money>,
    /// The organization's balance after this page, in US dollars. `None` when
    /// the API did not send it.
    #[serde(default)]
    pub balance: Option<Money>,
}

/// One result of [`Client::fetch`](crate::Client::fetch): a page as markdown,
/// or [`Page::error`] when that URL failed.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct Page {
    /// The page URL.
    pub url: String,
    /// The page title.
    pub title: String,
    /// The main content as markdown, or the model's answer when a prompt was
    /// passed.
    pub content: String,
    /// The page's description, when it has one.
    pub description: Option<String>,
    /// The page's author, when it names one.
    pub author: Option<String>,
    /// When the page was published, as ISO 8601 UTC to the second, such as
    /// `2024-05-01T12:00:00Z`. `None` when unknown.
    pub published_at: Option<String>,
    /// `true` when the page was longer than `max_chars` and `content` was cut
    /// (cut content ends with "..."). `None` when the API did not say.
    pub truncated: Option<bool>,
    /// The length of the full extracted content in Unicode code points,
    /// before any cut. `None` when the API did not say.
    pub total_chars: Option<u64>,
    /// The page's preview image URL.
    pub image: Option<String>,
    /// The page's favicon URL.
    pub favicon: Option<String>,
    /// The page's links, when [`FetchOptions::links`](crate::FetchOptions::links) was set.
    pub links: Option<Vec<PageLink>>,
    /// The page's images.
    pub images: Option<Vec<PageImage>>,
    /// The answer for [`FetchOptions::schema`](crate::FetchOptions::schema).
    pub structured: Option<Map<String, Value>>,
    /// Why the answer for the schema could not be made.
    pub answer_error: Option<AnswerError>,
    /// `true` when an older stored copy was returned because a fresh read failed.
    pub stale: Option<bool>,
    /// What reading this page cost.
    pub usage: Option<Usage>,
    /// Set when this URL failed; the other fields are then empty.
    pub error: Option<FetchError>,
    /// The unmodified JSON object.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

/// Controls [`SearchResponse::to_context_with`] and
/// [`SearchResponse::cited_with`]. [`Page::to_context_with`] reads
/// `max_chars` only.
///
/// ```
/// let opts = keenable::ContextOptions {
///     max_results: Some(3),
///     include_dates: false,
///     ..Default::default()
/// };
/// # let _ = opts;
/// ```
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContextOptions {
    /// The character budget for the whole block. Zero means
    /// [`DEFAULT_CONTEXT_MAX_CHARS`].
    pub max_chars: usize,
    /// Keeps at most this many results before the budget is applied. `None`
    /// means no cap; `Some(0)` renders nothing.
    pub max_results: Option<usize>,
    /// Appends the publication date to each header.
    pub include_dates: bool,
    /// Caps each result's text at about this many characters (plus the "…"),
    /// cut at a word boundary, so one whole-page snippet cannot take the
    /// whole budget. `None` means no cap.
    pub max_snippet_chars: Option<usize>,
}

impl Default for ContextOptions {
    fn default() -> Self {
        ContextOptions {
            max_chars: DEFAULT_CONTEXT_MAX_CHARS,
            max_results: None,
            include_dates: true,
            max_snippet_chars: Some(DEFAULT_CONTEXT_MAX_SNIPPET_CHARS),
        }
    }
}

impl ContextOptions {
    fn budget(&self) -> usize {
        if self.max_chars == 0 {
            DEFAULT_CONTEXT_MAX_CHARS
        } else {
            self.max_chars
        }
    }
}

impl SearchResponse {
    /// The results [`SearchResponse::to_context`] renders, in citation order.
    ///
    /// Index 0 is the source the model cites as `[1]`. Listing `results`
    /// instead would number sources the model never saw once the budget
    /// trimmed them.
    pub fn cited(&self) -> Vec<&SearchResult> {
        self.cited_with(&ContextOptions::default())
    }

    /// [`SearchResponse::cited`] with your own [`ContextOptions`].
    pub fn cited_with(&self, opts: &ContextOptions) -> Vec<&SearchResult> {
        let budget = opts.budget();
        let selected = match opts.max_results {
            Some(n) => &self.results[..n.min(self.results.len())],
            None => &self.results[..],
        };
        let mut kept = Vec::with_capacity(selected.len());
        let mut used = 0;
        for (i, result) in selected.iter().enumerate() {
            let header = source_header(
                i + 1,
                &result.title,
                &result.url,
                result.published_at.as_deref(),
                opts.include_dates,
            );
            let body = result_body(result, opts.max_snippet_chars);
            let mut cost = header.chars().count();
            if !body.is_empty() {
                cost += 1 + body.chars().count();
            }
            if !kept.is_empty() {
                cost += 2; // the blank line between sources
            }
            // The first result is kept even when it alone exceeds the budget.
            // Later results are dropped whole, so a citation number is never
            // skipped.
            if !kept.is_empty() && used + cost > budget {
                break;
            }
            kept.push(result);
            used += cost;
        }
        kept
    }

    /// Renders the results as a numbered block for a prompt.
    ///
    /// Each result is a `[n] title (url)` header followed by its page text.
    /// Page text is cleaned first (image markup dropped, relative links
    /// resolved against the result URL, tables flattened), then each is cut
    /// to `max_snippet_chars` at a word boundary and ends in "…". Results are
    /// then added whole until `max_chars` is reached. The first result is
    /// always kept, even if it alone exceeds the budget. `snippet` itself is
    /// left untouched.
    pub fn to_context(&self) -> String {
        self.to_context_with(&ContextOptions::default())
    }

    /// [`SearchResponse::to_context`] with your own [`ContextOptions`].
    pub fn to_context_with(&self, opts: &ContextOptions) -> String {
        self.cited_with(opts)
            .iter()
            .enumerate()
            .map(|(i, result)| {
                context_block(
                    &source_header(
                        i + 1,
                        &result.title,
                        &result.url,
                        result.published_at.as_deref(),
                        opts.include_dates,
                    ),
                    &result_body(result, opts.max_snippet_chars),
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }
}

impl<'a> IntoIterator for &'a SearchResponse {
    type Item = &'a SearchResult;
    type IntoIter = std::slice::Iter<'a, SearchResult>;
    fn into_iter(self) -> Self::IntoIter {
        self.results.iter()
    }
}

impl Page {
    /// Renders the page as a citable block, the same shape as a search
    /// result.
    ///
    /// A page is one document, so an oversized page is cut at the budget
    /// instead of dropped. The publication date is included when the page has
    /// one. Content has image markup dropped and relative links resolved
    /// before the cut; `content` itself is left untouched.
    pub fn to_context(&self) -> String {
        self.to_context_with(&ContextOptions::default())
    }

    /// [`Page::to_context`] with your own budget: only `max_chars` is read.
    pub fn to_context_with(&self, opts: &ContextOptions) -> String {
        let header = source_header(
            1,
            &self.title,
            &self.url,
            self.published_at.as_deref(),
            true,
        );
        let budget = opts.budget() as isize - header.chars().count() as isize - 1;
        if budget <= 0 {
            return header;
        }
        let content = clean_context_text(&self.content, &self.url);
        let cut: String = content.chars().take(budget as usize).collect();
        context_block(&header, cut.trim_end())
    }
}

fn source_header(
    index: usize,
    title: &str,
    url: &str,
    published: Option<&str>,
    include_dates: bool,
) -> String {
    let mut header = format!("[{index}] {title} ({url})");
    if let (true, Some(date)) = (include_dates, published) {
        header.push_str(" - published ");
        header.push_str(date);
    }
    header
}

fn context_block(header: &str, body: &str) -> String {
    if body.is_empty() {
        header.to_string()
    } else {
        format!("{header}\n{body}")
    }
}

fn result_body(result: &SearchResult, max_snippet: Option<usize>) -> String {
    let collapsed = clean_context_text(&result.snippet, &result.url)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    cap_snippet(collapsed, max_snippet)
}

/// Cuts text to `limit` characters at the last space at or before `limit` (a
/// hard cut when there is none), trims it and appends "…". Text at or under
/// the limit, or no limit, leaves it as is. The text is collapsed, so a plain
/// space is the only whitespace in it.
fn cap_snippet(text: String, limit: Option<usize>) -> String {
    let Some(limit) = limit.filter(|&n| n >= 1) else {
        return text;
    };
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= limit {
        return text;
    }
    let cut = (1..=limit)
        .rev()
        .find(|&j| chars[j] == ' ')
        .unwrap_or(limit);
    let kept: String = chars[..cut].iter().collect();
    format!("{}…", kept.trim_end())
}

// ---- Reading API bodies -------------------------------------------------

/// The last Unix second with a four-digit year, 9999-12-31T23:59:59Z.
const MAX_UNIX_SECONDS: f64 = 253_402_300_799.0;
/// 2^53 - 1, the largest integer every SDK reads exactly.
pub(crate) const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// A string with more than whitespace, or `None`.
pub(crate) fn non_blank(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.clone()),
        _ => None,
    }
}

fn as_string(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// A date as the API sends it, as one ISO 8601 string: a non-blank string as
/// sent, or Unix seconds as ISO 8601 UTC to the second (a fraction dropped).
/// A number below 1, past the year 9999 or not finite is `None`, as is
/// anything else.
fn timestamp(v: Option<&Value>) -> Option<String> {
    match v {
        Some(Value::String(_)) => non_blank(v),
        Some(Value::Number(n)) => {
            let seconds = n.as_f64()?.floor();
            if !(1.0..=MAX_UNIX_SECONDS).contains(&seconds) {
                return None;
            }
            let seconds = seconds as i64;
            let (y, m, d) = civil_from_days(seconds.div_euclid(86_400));
            let rem = seconds.rem_euclid(86_400);
            Some(format!(
                "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
                rem / 3600,
                rem % 3600 / 60,
                rem % 60
            ))
        }
        _ => None,
    }
}

/// A whole number from 0 to 2^53 - 1, or `None`.
pub(crate) fn safe_count(v: Option<&Value>) -> Option<u64> {
    let f = v?.as_f64()?;
    if f.fract() != 0.0 || !(0.0..=MAX_SAFE_INTEGER).contains(&f) {
        return None;
    }
    Some(f as u64)
}

pub(crate) fn search_response_from_json(
    data: Map<String, Value>,
    query: &str,
    header_request_id: Option<String>,
) -> SearchResponse {
    let results = match data.get("results") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_object())
            .map(|obj| SearchResult {
                title: as_string(obj.get("title")),
                url: as_string(obj.get("url")),
                snippet: as_string(obj.get("snippet")),
                published_at: timestamp(obj.get("published_at")),
                acquired_at: timestamp(obj.get("acquired_at")),
                raw: obj.clone(),
            })
            .collect(),
        _ => Vec::new(),
    };
    let warnings = match data.get("warnings") {
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| item.as_object())
            .map(|obj| SearchWarning {
                code: as_string(obj.get("code")),
                path: as_string(obj.get("path")),
                message: as_string(obj.get("message")),
            })
            .collect(),
        _ => Vec::new(),
    };
    SearchResponse {
        query: non_blank(data.get("query")).unwrap_or_else(|| query.to_string()),
        mode: non_blank(data.get("mode")),
        results,
        request_id: non_blank(data.get("request_id")).or(header_request_id),
        warnings,
        usage: usage_from_json(data.get("usage")),
        raw: data,
    }
}

/// Reads a usage object field by field, so one malformed field (such as a
/// `cost` whose amount is a string) does not lose the others.
pub(crate) fn usage_from_json(v: Option<&Value>) -> Option<Usage> {
    let u = v?.as_object()?;
    let money_field = |name: &str| {
        u.get(name)
            .filter(|m| m.is_object())
            .map(|m| money(Some(m)))
    };
    Some(Usage {
        sku: as_string(u.get("sku")),
        amount: safe_count(u.get("amount")).unwrap_or(0),
        credits: as_amount(u.get("credits")),
        paid: u.get("paid").and_then(Value::as_bool).unwrap_or(false),
        credits_remaining: u
            .get("credits_remaining")
            .and_then(Value::as_f64)
            .filter(|f| f.is_finite()),
        cost: money_field("cost"),
        balance: money_field("balance"),
    })
}

pub(crate) fn page_from_json(data: Map<String, Value>, fallback_url: &str) -> Page {
    fn typed<T: serde::de::DeserializeOwned>(v: Option<&Value>) -> Option<T> {
        serde_json::from_value(v?.clone()).ok()
    }
    Page {
        url: non_blank(data.get("url")).unwrap_or_else(|| fallback_url.to_string()),
        title: as_string(data.get("title")),
        content: as_string(data.get("content")),
        description: non_blank(data.get("description")),
        author: non_blank(data.get("author")),
        published_at: timestamp(data.get("published_at")),
        truncated: data.get("truncated").and_then(Value::as_bool),
        total_chars: safe_count(data.get("total_chars")),
        image: non_blank(data.get("image")),
        favicon: non_blank(data.get("favicon")),
        links: typed(data.get("links")),
        images: typed(data.get("images")),
        structured: data.get("structured").and_then(Value::as_object).cloned(),
        answer_error: typed(data.get("answer_error")),
        stale: data.get("stale").and_then(Value::as_bool),
        usage: usage_from_json(data.get("usage")),
        error: data
            .get("error")
            .and_then(Value::as_object)
            .map(fetch_error),
        raw: data,
    }
}

/// A per-URL error from whatever fields it has, so a failed URL never reads
/// as a successful page.
fn fetch_error(e: &Map<String, Value>) -> FetchError {
    FetchError {
        status: e
            .get("status")
            .and_then(Value::as_u64)
            .and_then(|s| u16::try_from(s).ok())
            .unwrap_or(0),
        error: as_string(e.get("error")),
        code: non_blank(e.get("code")),
        error_type: non_blank(e.get("type")),
        message: non_blank(e.get("message")),
        fix: non_blank(e.get("fix")),
        retryable: e.get("retryable").and_then(Value::as_bool),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn result(title: &str, url: &str, snippet: &str) -> SearchResult {
        SearchResult {
            title: title.into(),
            url: url.into(),
            snippet: snippet.into(),
            published_at: None,
            acquired_at: None,
            raw: Map::new(),
        }
    }

    fn response(results: Vec<SearchResult>) -> SearchResponse {
        SearchResponse {
            query: "q".into(),
            mode: None,
            results,
            request_id: None,
            warnings: Vec::new(),
            usage: None,
            raw: Map::new(),
        }
    }

    #[test]
    fn numbers_each_source() {
        let mut first = result("A", "https://a.com/", "alpha  text");
        first.published_at = Some("2024-01-01".into());
        let r = response(vec![first, result("B", "https://b.com/", "")]);
        assert_eq!(
            r.to_context(),
            "[1] A (https://a.com/) - published 2024-01-01\nalpha text\n\n[2] B (https://b.com/)"
        );
        let no_dates = ContextOptions {
            include_dates: false,
            ..Default::default()
        };
        assert!(r
            .to_context_with(&no_dates)
            .starts_with("[1] A (https://a.com/)\n"));
    }

    #[test]
    fn drops_whole_results_past_the_budget() {
        let r = response(vec![
            result("A", "https://a.com/", &"x".repeat(50)),
            result("B", "https://b.com/", &"y".repeat(50)),
        ]);
        let opts = ContextOptions {
            max_chars: 60,
            ..Default::default()
        };
        assert_eq!(r.cited_with(&opts).len(), 1);
        assert!(!r.to_context_with(&opts).contains("[2]"));
        let none = ContextOptions {
            max_results: Some(0),
            ..Default::default()
        };
        assert_eq!(r.to_context_with(&none), "");
    }

    #[test]
    fn caps_each_snippet_at_a_word() {
        let r = response(vec![result("A", "https://a.com/", "one two three four")]);
        let opts = ContextOptions {
            max_snippet_chars: Some(9),
            ..Default::default()
        };
        assert_eq!(r.to_context_with(&opts), "[1] A (https://a.com/)\none two…");
    }

    #[test]
    fn reads_the_cost_and_balance_in_usage() {
        let data = json!({
            "url": "https://example.com", "title": "Example Domain", "content": "# Example Domain",
            "usage": {
                "sku": "fetch", "amount": 1, "credits": 1.0, "paid": true, "credits_remaining": 11998.0,
                "cost": {"amount": 0.004, "amount_decimal": "0.004", "currency": "usd"},
                "balance": {"amount": 47.992, "amount_decimal": "47.992", "currency": "usd"}
            }
        });
        let page = page_from_json(data.as_object().unwrap().clone(), "https://example.com");
        let usage = page.usage.expect("usage");
        assert_eq!(
            usage.cost,
            Some(Money {
                amount: 0.004,
                amount_decimal: "0.004".into(),
                currency: "usd".into()
            })
        );
        assert_eq!(
            usage.balance,
            Some(Money {
                amount: 47.992,
                amount_decimal: "47.992".into(),
                currency: "usd".into()
            })
        );

        let older = json!({"url": "https://example.com", "usage": {"sku": "fetch", "amount": 1, "credits": 1.0, "paid": false}});
        let usage = page_from_json(older.as_object().unwrap().clone(), "https://example.com")
            .usage
            .expect("usage");
        assert_eq!((usage.cost, usage.balance), (None, None));
    }

    #[test]
    fn reads_a_whole_usage_amount_in_float_form() {
        let amount = |v: Value| {
            usage_from_json(Some(&json!({ "amount": v })))
                .expect("usage")
                .amount
        };
        assert_eq!(amount(json!(1.0)), 1);
        assert_eq!(amount(json!(3)), 3);
        assert_eq!(
            amount(json!(9_007_199_254_740_991.0)),
            9_007_199_254_740_991
        );
        assert_eq!(amount(json!(1.5)), 0);
        assert_eq!(amount(json!(-1.0)), 0);
        assert_eq!(amount(json!(-1)), 0);
        assert_eq!(amount(json!(1e300)), 0);
        assert_eq!(amount(json!("1")), 0);
    }

    #[test]
    fn keeps_usage_when_a_money_field_is_malformed() {
        let data = json!({
            "url": "https://example.com",
            "usage": {
                "sku": "fetch", "amount": 1, "credits": 1.0, "paid": true,
                "cost": {"amount": "0.004", "currency": "usd"},
                "balance": {"amount": 47.992}
            }
        });
        let usage = page_from_json(data.as_object().unwrap().clone(), "https://example.com")
            .usage
            .expect("usage survives a malformed money field");
        assert_eq!(
            (usage.sku.as_str(), usage.amount, usage.paid),
            ("fetch", 1, true)
        );
        assert_eq!(
            usage.cost,
            Some(Money {
                amount: 0.0,
                amount_decimal: "0".into(),
                currency: "usd".into()
            })
        );
        assert_eq!(
            usage.balance,
            Some(Money {
                amount: 47.992,
                amount_decimal: "47.992".into(),
                currency: String::new()
            })
        );
    }

    #[test]
    fn cuts_a_page_at_the_budget() {
        let page = page_from_json(
            json!({"title": "T", "content": "abcdefghij  "})
                .as_object()
                .unwrap()
                .clone(),
            "https://e.com/",
        );
        let opts = ContextOptions {
            max_chars: 30,
            ..Default::default()
        };
        assert_eq!(
            page.to_context_with(&opts),
            "[1] T (https://e.com/)\nabcdefg"
        );
    }

    #[test]
    fn reads_unix_seconds_as_iso() {
        assert_eq!(
            timestamp(Some(&json!(1714564800.9))),
            Some("2024-05-01T12:00:00Z".into())
        );
        assert_eq!(timestamp(Some(&json!(0.5))), None);
        assert_eq!(timestamp(Some(&json!(253402300800_u64))), None);
        assert_eq!(timestamp(Some(&json!(true))), None);
    }
}

// ---- Billing ----------------------------------------------------------------

/// An amount of money, as the API sent it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[non_exhaustive]
pub struct Money {
    /// The amount in the currency's major unit (US dollars), such as
    /// `0.004`, with up to nine decimal places. Negative for an account in
    /// debt. `0.0` when the API sent no finite number. For display: add
    /// amounts with `amount_decimal`.
    pub amount: f64,
    /// The same amount as an exact decimal string, such as `"0.004"`: up to
    /// nine decimal places, no trailing zeros, no exponent, `-` when negative,
    /// `"0"` for zero. Add amounts exactly with a decimal type (or as `i128`
    /// nano-dollars), never by summing `amount`. From an older server that
    /// sends none, `amount` written this way.
    pub amount_decimal: String,
    /// The lowercase ISO 4217 code, such as `"usd"`.
    pub currency: String,
}

/// The price of one SKU, from [`Client::billing`](crate::Client::billing).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct BillingPrice {
    /// What is billed, such as `search.pro` or `fetch.live`.
    pub sku: String,
    /// What one unit is: `search`, `result` or `page`.
    pub unit: String,
    /// The price of one unit.
    pub unit_price: Money,
    /// The public list price of one unit. Only with an API key.
    pub list_unit_price: Option<Money>,
    /// `list` when `unit_price` is the list price, `contract` when the
    /// organization has its own. Only with an API key.
    pub source: Option<String>,
}

/// What the organization can still spend.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct BillingBalance {
    /// The unused free allowance for this month plus the purchased balance.
    pub available: Money,
}

/// The organization's balance.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct BillingAccount {
    /// What the organization can still spend.
    pub balance: BillingBalance,
    /// The console page where a person can add funds.
    pub billing_url: String,
    /// When this was read (ISO 8601).
    pub as_of: String,
}

/// What [`Client::billing`](crate::Client::billing) returns: prices, and the
/// account with an API key.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct Billing {
    /// The public list prices without an API key. With one, your
    /// organization's prices; a SKU without a price on your plan is left out.
    pub prices: Vec<BillingPrice>,
    /// The balance. `None` without an API key.
    pub account: Option<BillingAccount>,
    /// The API's id for this request. Quote it when reporting a problem.
    pub request_id: Option<String>,
    /// The unmodified JSON body.
    #[serde(skip)]
    pub raw: Map<String, Value>,
}

fn object_or_empty(v: Option<&Value>) -> Map<String, Value> {
    v.and_then(Value::as_object).cloned().unwrap_or_default()
}

fn objects(v: Option<&Value>) -> Vec<&Map<String, Value>> {
    match v {
        Some(Value::Array(items)) => items.iter().filter_map(Value::as_object).collect(),
        _ => Vec::new(),
    }
}

fn as_amount(v: Option<&Value>) -> f64 {
    v.and_then(Value::as_f64)
        .filter(|f| f.is_finite())
        .unwrap_or(0.0)
}

/// `^-?[0-9]+(\.[0-9]{1,9})?$`: what the API sends as `amount_decimal`.
fn is_decimal(s: &str) -> bool {
    let unsigned = s.strip_prefix('-').unwrap_or(s);
    let (whole, fraction) = match unsigned.split_once('.') {
        Some((whole, fraction)) => (whole, Some(fraction)),
        None => (unsigned, None),
    };
    let digits = |part: &str| part.bytes().all(|b| b.is_ascii_digit());
    !whole.is_empty()
        && digits(whole)
        && match fraction {
            Some(f) => (1..=9).contains(&f.len()) && digits(f),
            None => true,
        }
}

/// The API's exact decimal string when it is one, else `amount` as one: at
/// most nine decimal places, trailing zeros trimmed, `"0"` for zero (an older
/// server sends no `amount_decimal`).
fn amount_decimal(v: Option<&Value>, amount: f64) -> String {
    if let Some(s) = v.and_then(Value::as_str).filter(|s| is_decimal(s)) {
        return s.to_string();
    }
    let fixed = format!("{amount:.9}");
    let text = fixed.trim_end_matches('0').trim_end_matches('.');
    if text == "-0" { "0" } else { text }.to_string()
}

fn money(v: Option<&Value>) -> Money {
    let m = object_or_empty(v);
    let amount = as_amount(m.get("amount"));
    Money {
        amount,
        amount_decimal: amount_decimal(m.get("amount_decimal"), amount),
        currency: as_string(m.get("currency")),
    }
}

pub(crate) fn billing_from_json(
    data: Map<String, Value>,
    header_request_id: Option<String>,
) -> Billing {
    let prices = objects(data.get("prices"))
        .into_iter()
        .map(|p| BillingPrice {
            sku: as_string(p.get("sku")),
            unit: as_string(p.get("unit")),
            unit_price: money(p.get("unit_price")),
            list_unit_price: p
                .get("list_unit_price")
                .filter(|v| v.is_object())
                .map(|v| money(Some(v))),
            source: non_blank(p.get("source")),
        })
        .collect();
    let account = data.get("account").and_then(Value::as_object).map(|a| {
        let balance = object_or_empty(a.get("balance"));
        BillingAccount {
            balance: BillingBalance {
                available: money(balance.get("available")),
            },
            billing_url: as_string(a.get("billing_url")),
            as_of: as_string(a.get("as_of")),
        }
    });
    Billing {
        prices,
        account,
        request_id: non_blank(data.get("request_id")).or(header_request_id),
        raw: data,
    }
}
