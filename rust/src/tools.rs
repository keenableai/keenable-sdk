//! OpenAI-compatible tool definitions and a runner for the calls a model
//! makes.

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::client::{Client, FetchOptions, RequestOptions};
use crate::error::{ApiError, Error, Result};
use crate::json;
use crate::models::{ContextOptions, FetchError, Page, DEFAULT_CONTEXT_MAX_CHARS};

/// An OpenAI-compatible function tool. Serialize [`tools`] straight into a
/// chat completion request that speaks that schema.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct ToolDefinition {
    /// Always "function".
    #[serde(rename = "type")]
    pub kind: String,
    /// The function the model may call.
    pub function: ToolFunction,
}

/// The function half of a [`ToolDefinition`].
#[derive(Debug, Clone, PartialEq, Serialize)]
#[non_exhaustive]
pub struct ToolFunction {
    /// `keenable_search` or `keenable_fetch`.
    pub name: String,
    /// What the tool does, for the model.
    pub description: String,
    /// The arguments, as JSON Schema.
    pub parameters: Value,
}

/// The name of the search tool.
pub const SEARCH_TOOL_NAME: &str = "keenable_search";
/// The name of the fetch tool.
pub const FETCH_TOOL_NAME: &str = "keenable_fetch";

/// The search filters a model may set, with their JSON type, description and
/// the values the schema offers (empty for any). They are both the tool
/// schema's properties and the allow-list `run_tool_call` reads.
const TOOL_FILTERS: [(&str, &str, &str, &[&str]); 6] = [
    (
        "site",
        "string",
        "Optional. Restrict results to one domain, e.g. 'arxiv.org'.",
        &[],
    ),
    (
        "exclude_domains",
        "array",
        "Optional. Never return results from these hosts or their subdomains, e.g. 'pinterest.com'. Hosts only, no paths or wildcards. Up to 1,000.",
        &[],
    ),
    (
        "published_after",
        "string",
        "Optional. Only pages published on or after this date (YYYY-MM-DD).",
        &[],
    ),
    (
        "objective",
        "string",
        "Optional. Use for multi-step or ambiguous searches; omit for simple lookups. In one to three plain sentences, say what the search is for, what the query leaves out (who, where, when, which sources count) and what earlier searches found. Don't restate the question or include personal or confidential details. At most 1,000 characters.",
        &[],
    ),
    (
        "disable_cards",
        "boolean",
        "Optional. true returns ordinary web pages in place of Keenable's cards (results Keenable writes for prices, exchange rates or company facts, whose URLs expire after one day). Default false.",
        &[],
    ),
    (
        "moderation",
        "string",
        "Filter unsafe results: 'moderate' or 'strict'. Leave it out for no moderation. Not supported for a URL query unless exclude_domains is set.",
        &["moderate", "strict"],
    ),
];

/// The `keenable_search` function definition.
pub fn search_tool() -> ToolDefinition {
    let mut props = Map::new();
    props.insert(
        "query".into(),
        json!({
            "type": "string",
            "description": "What to look for, described in natural language rather than keywords.",
        }),
    );
    for (name, kind, description, values) in TOOL_FILTERS {
        let mut prop = json!({"type": kind, "description": description});
        if kind == "array" {
            prop["items"] = json!({"type": "string"});
        }
        if !values.is_empty() {
            prop["enum"] = json!(values);
        }
        props.insert(name.into(), prop);
    }
    ToolDefinition {
        kind: "function".into(),
        function: ToolFunction {
            name: SEARCH_TOOL_NAME.into(),
            description: "Search the web for current information. Returns ranked pages with \
                their title, URL and extracted page text. Use this whenever the answer depends \
                on recent events or facts you are unsure about."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": props,
                "required": ["query"],
            }),
        },
    }
}

/// The `keenable_fetch` function definition. It requires `urls`.
pub fn fetch_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: ToolFunction {
            name: FETCH_TOOL_NAME.into(),
            description: "Fetch up to 20 web pages and return each one's main content as \
                markdown. Use after keenable_search when a search snippet is not enough. Add a \
                prompt to get back only the part you need from long pages."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "urls": {
                        "type": "array",
                        "items": {"type": "string"},
                        "minItems": 1,
                        "maxItems": 20,
                        "description": "The URLs of the pages to read, 1 to 20.",
                    },
                    "max_chars": {
                        "type": "integer",
                        "minimum": 1,
                        "description": "The most characters of content to return for each page.",
                    },
                    "prompt": {
                        "type": "string",
                        "description": "An instruction applied to every page; each page's content \
                            is then only the answer to it. Use it to get one detail from long pages.",
                    },
                    "max_age_hours": {
                        "type": "number",
                        "minimum": -1,
                        "maximum": 720,
                        "description": "How old Keenable's stored copy may be, in hours; an older \
                            copy is read again from the source. 0 reads every page live. -1 reads \
                            only the stored copy, never the live page; other negative values are \
                            refused.",
                    },
                },
                "required": ["urls"],
            }),
        },
    }
}

/// `keenable_search` and `keenable_fetch`, in that order.
pub fn tools() -> Vec<ToolDefinition> {
    vec![search_tool(), fetch_tool()]
}

/// The arguments of a tool call: the JSON text a model sent, or an object
/// already parsed.
pub trait ToolArguments {
    /// The arguments as a JSON object, or an invalid-request error.
    fn into_arguments(self) -> Result<Map<String, Value>>;
}

fn not_an_object(text: &str) -> Error {
    Error::invalid(format!(
        "tool call arguments must be a JSON object, got {text:?}. Pass an object, not an array or a scalar."
    ))
}

impl ToolArguments for &str {
    fn into_arguments(self) -> Result<Map<String, Value>> {
        let text = if self.is_empty() { "{}" } else { self };
        match json::parse(text.as_bytes()) {
            Some(Value::Object(obj)) => Ok(obj),
            Some(_) => Err(not_an_object(text)),
            None => Err(Error::invalid(format!(
                "tool call arguments are not valid JSON: {text:?}. Pass a JSON object such as {{\"query\":\"...\"}}."
            ))),
        }
    }
}

impl ToolArguments for &String {
    fn into_arguments(self) -> Result<Map<String, Value>> {
        self.as_str().into_arguments()
    }
}

impl ToolArguments for String {
    fn into_arguments(self) -> Result<Map<String, Value>> {
        self.as_str().into_arguments()
    }
}

impl ToolArguments for Map<String, Value> {
    fn into_arguments(self) -> Result<Map<String, Value>> {
        Ok(self)
    }
}

impl ToolArguments for Value {
    fn into_arguments(self) -> Result<Map<String, Value>> {
        match self {
            Value::Object(obj) => Ok(obj),
            // null is not an object, as the JSON text "null" is not.
            other => Err(not_an_object(&other.to_string())),
        }
    }
}

impl ToolArguments for &Value {
    fn into_arguments(self) -> Result<Map<String, Value>> {
        self.clone().into_arguments()
    }
}

fn require_string<'a>(v: Option<&'a Value>, message: &str) -> Result<&'a str> {
    match v {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s),
        _ => Err(Error::invalid(message)),
    }
}

/// The search body filters a model's arguments set, from the tool-exposed
/// filters only. A list filter is sent as the model gave it, a lone string
/// wrapped, so the API judges a malformed one; null and "" are unset.
fn tool_filters(args: &Map<String, Value>) -> Result<Map<String, Value>> {
    let mut payload = Map::new();
    for (name, kind, _, values) in TOOL_FILTERS {
        let Some(v) = args.get(name) else { continue };
        if !values.is_empty() && !matches!(v, Value::Null | Value::String(_)) {
            let choices: Vec<String> = values.iter().map(|v| format!("\"{v}\"")).collect();
            return Err(Error::invalid(format!(
                "{name} must be {}. Pass a JSON string, or leave it out.",
                choices.join(" or ")
            )));
        }
        match (kind, v) {
            (_, Value::Null) => {}
            ("array", Value::String(s)) if s.is_empty() => {}
            ("array", Value::String(s)) => {
                payload.insert(name.into(), json!([s]));
            }
            ("array", other) => {
                payload.insert(name.into(), other.clone());
            }
            ("boolean", Value::Bool(true)) => {
                payload.insert(name.into(), Value::Bool(true));
            }
            ("boolean", Value::Bool(false)) => {}
            ("boolean", Value::String(s)) if s.is_empty() => {}
            ("boolean", _) => {
                return Err(Error::invalid(format!(
                    "{name} must be true or false. Pass a JSON boolean."
                )))
            }
            (_, Value::String(s)) if !s.is_empty() => {
                payload.insert(name.into(), Value::String(s.clone()));
            }
            _ => {}
        }
    }
    Ok(payload)
}

/// The `urls` a model sent: 1 to 20 non-blank strings.
fn tool_fetch_urls(args: &Map<String, Value>) -> Result<Vec<&str>> {
    const BAD: &str = "keenable_fetch needs 'urls': a list of 1 to 20 URLs.";
    let raw = args.get("urls");
    match raw {
        Some(Value::String(_)) => Ok(vec![require_string(raw, BAD)?]),
        Some(Value::Array(list)) if !list.is_empty() => {
            list.iter().map(|v| require_string(Some(v), BAD)).collect()
        }
        _ => Err(Error::invalid(BAD)),
    }
}

/// `max_chars`, `prompt` and `max_age_hours`; null and "" are unset.
fn tool_fetch_options(args: &Map<String, Value>) -> Result<FetchOptions> {
    let unset = |v: Option<&Value>| matches!(v, None | Some(Value::Null)) || v == Some(&json!(""));
    let mut opts = FetchOptions::default();
    match args.get("max_chars") {
        Some(Value::Number(n)) if n.as_u64().is_some_and(|n| n >= 1) => {
            let n = n.as_u64().unwrap_or_default();
            opts.max_chars = Some(u32::try_from(n).unwrap_or(u32::MAX));
        }
        v if unset(v) => {}
        _ => {
            return Err(Error::invalid(
                "max_chars must be a positive integer. Pass a JSON number.",
            ))
        }
    }
    match args.get("prompt") {
        Some(Value::String(s)) if !s.is_empty() => opts.prompt = Some(s.clone()),
        v if unset(v) => {}
        _ => return Err(Error::invalid("prompt must be a string.")),
    }
    match args.get("max_age_hours") {
        Some(Value::Number(n)) => opts.max_age_hours = n.as_f64(),
        v if unset(v) => {}
        _ => {
            return Err(Error::invalid(
                "max_age_hours must be a number of hours. Pass a JSON number.",
            ))
        }
    }
    Ok(opts)
}

fn page_error(e: FetchError) -> Error {
    let mut err = ApiError::plain(e.status, e.message.unwrap_or(e.error.clone()), None);
    err.code = e.code;
    err.error_type = e.error_type.unwrap_or_default();
    err.error = Some(e.error);
    err.fix = e.fix;
    err.retryable = e.retryable;
    Error::Api(Box::new(err))
}

/// Each page as a numbered, citable block and a failed URL as an error block;
/// an error only when no URL could be read.
fn pages_context(pages: Vec<Page>, max_chars: Option<u32>) -> Result<String> {
    if pages.is_empty() {
        return Err(Error::Api(Box::new(ApiError::plain(
            200,
            "the Keenable API returned no result for the URL".into(),
            None,
        ))));
    }
    if pages.iter().all(|p| p.error.is_some()) {
        let first = pages.into_iter().find_map(|p| p.error);
        return Err(page_error(first.expect("every page has an error")));
    }
    // The API already cut each page to max_chars; leave room for its header.
    // Without max_chars, the default budget is split across the pages.
    let opts = ContextOptions {
        max_chars: max_chars.map_or((DEFAULT_CONTEXT_MAX_CHARS / pages.len()).max(1_000), |n| {
            n as usize + 1_000
        }),
        ..ContextOptions::default()
    };
    let blocks: Vec<String> = pages
        .iter()
        .enumerate()
        .map(|(i, page)| match &page.error {
            Some(e) => {
                let message = e.message.as_deref().unwrap_or(&e.error);
                let message = if message.is_empty() {
                    "the page could not be read"
                } else {
                    message
                };
                format!("[{}] {} - failed: {message}", i + 1, page.url)
            }
            None => {
                let block = page.to_context_with(&opts);
                format!("[{}]{}", i + 1, block.strip_prefix("[1]").unwrap_or(&block))
            }
        })
        .collect();
    Ok(blocks.join("\n\n"))
}

impl Client {
    /// Runs one tool call and returns the text for a `role: tool` message.
    ///
    /// `arguments` is the JSON text the model sent, or a parsed
    /// [`serde_json::Value`] or map. Anything that is not a JSON object is an
    /// invalid-request error. Both tools render the same numbered block, so a
    /// model can cite a fetched page the way it cites a search result. A URL
    /// that failed while others were read becomes an error block; if none was
    /// read, its error is returned.
    pub async fn run_tool_call(&self, name: &str, arguments: impl ToolArguments) -> Result<String> {
        let args = arguments.into_arguments()?;
        match name {
            SEARCH_TOOL_NAME => {
                let query = require_string(
                    args.get("query"),
                    "keenable_search needs a 'query'. Pass a JSON object with a query string.",
                )?;
                let filters = tool_filters(&args)?;
                let resp = self
                    .search_payload(query, None, filters, &RequestOptions::default())
                    .await?;
                Ok(resp.to_context())
            }
            FETCH_TOOL_NAME => {
                let urls = tool_fetch_urls(&args)?;
                let opts = tool_fetch_options(&args)?;
                let resp = self.fetch_with(urls, &opts).await?;
                pages_context(resp.results, opts.max_chars)
            }
            other => Err(Error::invalid(format!(
                "unknown Keenable tool: {other:?}. Use keenable_search or keenable_fetch."
            ))),
        }
    }
}

/// Runs one tool call with `client`: the same as [`Client::run_tool_call`].
pub async fn run_tool_call(
    client: &Client,
    name: &str,
    arguments: impl ToolArguments,
) -> Result<String> {
    client.run_tool_call(name, arguments).await
}
