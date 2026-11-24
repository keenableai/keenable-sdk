//! The official Rust SDK for the [Keenable](https://keenable.ai) web search
//! API.
//!
//! Search returns ranked pages with their text already extracted, so one call
//! gives a model something to reason over; fetch returns any URL as clean
//! markdown. Keyless by default: every call works with no account and no key.
//! An API key, from `KEENABLE_API_KEY` or [`Options::api_key`], raises your
//! rate limit.
//!
//! ```no_run
//! # async fn run() -> Result<(), keenable::Error> {
//! let client = keenable::Client::new()?;
//! let results = client.search("fastest inference providers 2026").await?;
//! println!("{}", results.to_context()); // numbered, citable block for a prompt
//! # Ok(())
//! # }
//! ```
//!
//! The client is async and runs on [Tokio](https://tokio.rs).
#![warn(missing_docs)]

mod client;
mod context_clean;
mod error;
mod guard;
mod json;
mod models;
mod monitors;
mod retry;
mod tools;
mod webhooks;

#[cfg(test)]
mod test_hooks;
#[cfg(test)]
mod tests;

pub use client::{
    Client, FetchOptions, Options, RequestOptions, SearchOptions, DEFAULT_BASE_URL,
    DEFAULT_MAX_RETRIES, DEFAULT_TIMEOUT,
};
pub use error::{
    codes, types, ApiError, ConnectionError, Error, InvalidRequestError, RateLimitError,
    RateLimitInfo, Result, WebhookVerificationError,
};
pub use models::{
    AnswerError, Billing, BillingAccount, BillingBalance, BillingPrice, BillingUsage,
    BillingUsageLine, ContextOptions, FetchError, FetchResponse, Money, Page, PageImage, PageLink,
    SearchResponse, SearchResult, SearchWarning, Usage, DEFAULT_CONTEXT_MAX_CHARS,
    DEFAULT_CONTEXT_MAX_SNIPPET_CHARS,
};
pub use monitors::{
    BulkFilter, BulkResult, DeliveryList, List, Monitor, MonitorBulkParams, MonitorCreateParams,
    MonitorDelivery, MonitorDiff, MonitorDisabledReason, MonitorList, MonitorListParams,
    MonitorPageParams, MonitorPageTarget, MonitorPager, MonitorResult, MonitorResultChange,
    MonitorResultsParams, MonitorRun, MonitorRunChanges, MonitorRunError, MonitorRunOutput,
    MonitorRunOutputError, MonitorSchedule, MonitorScheduleParams, MonitorSearch,
    MonitorSearchParams, MonitorStats, MonitorUpdateParams, MonitorVersion, MonitorVersionsParams,
    MonitorWebhook, MonitorWebhookParams, Monitors, ResultList, RunList, VersionList,
};
pub use tools::{
    fetch_tool, run_tool_call, search_tool, tools, ToolArguments, ToolDefinition, ToolFunction,
    FETCH_TOOL_NAME, SEARCH_TOOL_NAME,
};
pub use webhooks::{
    verify_webhook, verify_webhook_with, WebhookEvent, WebhookEventData, WebhookOptions,
    DEFAULT_WEBHOOK_TOLERANCE,
};

/// The SDK version, sent in the User-Agent. It is read from `Cargo.toml`, the
/// only copy.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// The `reqwest` this crate is built on, for [`Options::http_client`].
pub use reqwest;
