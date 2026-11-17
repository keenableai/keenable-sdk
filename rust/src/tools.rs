//! OpenAI-compatible tool definitions and a runner for the calls a model
//! makes.

use serde::Serialize;
use serde_json::{json, Map, Value};

use crate::client::{Client, RequestOptions};
use crate::error::{Error, Result};
use crate::json;

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

/// The search filters a model may set, with their JSON type. They are both
/// the tool schema's properties and the allow-list `run_tool_call` reads.
const TOOL_FILTERS: [(&str, &str, &str); 6] = [
    (
        "site",
        "string",
        "Optional. Deprecated, removed on 2027-02-15: use include_domains. Restrict results to one domain, e.g. 'arxiv.org'.",
    ),
    (
        "include_domains",
        "array",
        "Optional. Return results only from these hosts or their subdomains, e.g. 'arxiv.org'. Hosts only, no paths or wildcards. Up to 50.",
    ),
    (
        "exclude_domains",
        "array",
        "Optional. Never return results from these hosts or their subdomains, e.g. 'pinterest.com'. Hosts only, no paths or wildcards. Up to 1,000.",
    ),
    (
        "published_after",
        "string",
        "Optional. Only pages published on or after this date (YYYY-MM-DD).",
    ),
    (
        "objective",
        "string",
        "Optional. Two or three natural sentences, with no field labels and no line breaks, that cover: the exact facts, entities, numbers, dates or names a useful page must contain; task context the query does not state (who, where, when, eligibility, date window); which kinds of sources count or must be excluded; what is already established from earlier steps; and what is still unknown. Every sentence must be self-contained: name the entities, places, dates and figures explicitly, and never refer to 'the task', 'the clue', 'the question', 'above' or earlier results. Do not paste the conversation, and do not include personal, confidential or sensitive information. At most 1,000 characters.",
    ),
    (
        "disable_cards",
        "boolean",
        "Optional. true returns ordinary web pages in place of Keenable's cards (results Keenable writes for prices, exchange rates or company facts, whose URLs expire after one day). Default false.",
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
    for (name, kind, description) in TOOL_FILTERS {
        let mut prop = json!({"type": kind, "description": description});
        if kind == "array" {
            prop["items"] = json!({"type": "string"});
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

/// The `keenable_fetch` function definition.
pub fn fetch_tool() -> ToolDefinition {
    ToolDefinition {
        kind: "function".into(),
        function: ToolFunction {
            name: FETCH_TOOL_NAME.into(),
            description: "Fetch one web page and return its main content as markdown. Use after \
                keenable_search when a search snippet is not enough."
                .into(),
            parameters: json!({
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "The URL of the page to read."},
                },
                "required": ["url"],
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
    for (name, kind, _) in TOOL_FILTERS {
        let Some(v) = args.get(name) else { continue };
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

impl Client {
    /// Runs one tool call and returns the text for a `role: tool` message.
    ///
    /// `arguments` is the JSON text the model sent, or a parsed
    /// [`serde_json::Value`] or map. Anything that is not a JSON object is an
    /// invalid-request error. Both tools render the same numbered block, so a
    /// model can cite a fetched page the way it cites a search result.
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
                let url = require_string(
                    args.get("url"),
                    "keenable_fetch needs a 'url'. Pass a JSON object with an https URL.",
                )?;
                Ok(self.fetch(url).await?.to_context())
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
