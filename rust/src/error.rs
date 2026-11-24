//! The errors this crate returns.

use std::fmt;
use std::time::Duration;

/// Stable codes an agent can switch on, returned by [`Error::sdk_code`]. They
/// are also the last parentheses of the error's text.
pub mod codes {
    /// The arguments were rejected locally. No request was sent.
    pub const INVALID_REQUEST: &str = "invalid_request";
    /// The API could not be reached, or the deadline elapsed.
    pub const CONNECTION: &str = "connection";
    /// Any non-2xx response without a more specific code.
    pub const API: &str = "api_error";
    /// The API key was rejected (HTTP 401 or 403).
    pub const AUTH: &str = "auth";
    /// The rate limit was exceeded (HTTP 429).
    pub const RATE_LIMIT: &str = "rate_limit";
    /// A webhook delivery failed [`verify_webhook`](crate::verify_webhook).
    pub const WEBHOOK_VERIFICATION: &str = "webhook_verification";
}

/// Error types the API sends as [`ApiError::error_type`], Stripe-style. Switch
/// on the type for coarse handling and on [`ApiError::code`] for the exact
/// reason. A newer API may send a type not listed here.
pub mod types {
    /// The request was malformed or a parameter was rejected.
    pub const INVALID_REQUEST_ERROR: &str = "invalid_request_error";
    /// The API key is missing or wrong.
    pub const AUTHENTICATION_ERROR: &str = "authentication_error";
    /// The key may not do this.
    pub const PERMISSION_ERROR: &str = "permission_error";
    /// Out of credits, or a payment is required.
    pub const BILLING_ERROR: &str = "billing_error";
    /// A rate limit was hit.
    pub const RATE_LIMIT_ERROR: &str = "rate_limit_error";
    /// The page being fetched failed, not Keenable.
    pub const TARGET_ERROR: &str = "target_error";
    /// Keenable failed.
    pub const API_ERROR: &str = "api_error";
}

/// Every error this crate returns.
///
/// Match on the variant to handle one case, or use the helpers to read what
/// every API error shares. The text ([`fmt::Display`]) is a sentence that
/// ends with the stable [`Error::sdk_code`] in parentheses.
#[derive(Debug, Clone)]
#[non_exhaustive]
pub enum Error {
    /// The arguments were rejected locally. No request was sent.
    InvalidRequest(InvalidRequestError),
    /// The API could not be reached, the deadline elapsed, or the API
    /// answered with a redirect, which is never followed.
    Connection(ConnectionError),
    /// HTTP 401 or 403: the API key was rejected.
    Auth(Box<ApiError>),
    /// HTTP 429: the rate limit was exceeded.
    RateLimit(Box<RateLimitError>),
    /// HTTP 402: the organization has no credits left, or the API asked for a
    /// per-request (x402) payment, which this SDK cannot make.
    InsufficientCredits(Box<ApiError>),
    /// Any other non-2xx response, or a 2xx body that is not a JSON object.
    Api(Box<ApiError>),
    /// A webhook delivery failed [`verify_webhook`](crate::verify_webhook).
    WebhookVerification(WebhookVerificationError),
}

impl Error {
    /// The SDK's stable code: one of the constants in [`codes`]. A 402 is
    /// [`codes::API`].
    pub fn sdk_code(&self) -> &'static str {
        match self {
            Error::InvalidRequest(_) => codes::INVALID_REQUEST,
            Error::Connection(_) => codes::CONNECTION,
            Error::Auth(_) => codes::AUTH,
            Error::RateLimit(_) => codes::RATE_LIMIT,
            Error::InsufficientCredits(_) | Error::Api(_) => codes::API,
            Error::WebhookVerification(_) => codes::WEBHOOK_VERIFICATION,
        }
    }

    /// The API error behind an `Auth`, `RateLimit`, `InsufficientCredits` or
    /// `Api` error, so code that handles every non-2xx response reads one type.
    pub fn api_error(&self) -> Option<&ApiError> {
        match self {
            Error::Auth(e) | Error::InsufficientCredits(e) | Error::Api(e) => Some(e),
            Error::RateLimit(e) => Some(&e.api),
            Error::InvalidRequest(_) | Error::Connection(_) | Error::WebhookVerification(_) => None,
        }
    }

    /// The HTTP status of an API error.
    pub fn status_code(&self) -> Option<u16> {
        self.api_error().map(|e| e.status_code)
    }

    /// Whether a deadline elapsed before the response arrived.
    pub fn is_timeout(&self) -> bool {
        matches!(self, Error::Connection(e) if e.is_timeout())
    }

    pub(crate) fn invalid(msg: impl Into<String>) -> Self {
        Error::InvalidRequest(InvalidRequestError { msg: msg.into() })
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidRequest(e) => e.fmt(f),
            Error::Connection(e) => e.fmt(f),
            Error::RateLimit(e) => e.api.write(f, codes::RATE_LIMIT),
            Error::Auth(e) => e.write(f, codes::AUTH),
            Error::InsufficientCredits(e) | Error::Api(e) => e.write(f, codes::API),
            Error::WebhookVerification(e) => e.fmt(f),
        }
    }
}

impl std::error::Error for Error {}

/// The arguments were rejected locally. No request was sent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidRequestError {
    pub(crate) msg: String,
}

impl fmt::Display for InvalidRequestError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.msg, codes::INVALID_REQUEST)
    }
}

impl std::error::Error for InvalidRequestError {}

/// A webhook delivery failed [`verify_webhook`](crate::verify_webhook): the
/// signature did not match, a header was missing, the timestamp was too far
/// from now, or the signed body was not a JSON object. Answer such a request
/// with a 400 and do not act on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookVerificationError {
    pub(crate) msg: String,
}

impl fmt::Display for WebhookVerificationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.msg, codes::WEBHOOK_VERIFICATION)
    }
}

impl std::error::Error for WebhookVerificationError {}

/// The API could not be reached, or the deadline for one attempt elapsed
/// before the whole body arrived.
#[derive(Debug, Clone)]
pub struct ConnectionError {
    pub(crate) msg: String,
    pub(crate) timeout: bool,
    pub(crate) redirect: bool,
}

impl ConnectionError {
    /// Whether the deadline ([`Options::timeout`](crate::Options::timeout) or
    /// [`RequestOptions::timeout`](crate::RequestOptions::timeout)) elapsed.
    pub fn is_timeout(&self) -> bool {
        self.timeout
    }

    /// Whether the API answered with a redirect. It is never followed, so the
    /// API key goes nowhere else, and it is not retried.
    pub fn is_redirect(&self) -> bool {
        self.redirect
    }
}

impl fmt::Display for ConnectionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({})", self.msg, codes::CONNECTION)
    }
}

impl std::error::Error for ConnectionError {}

/// A non-2xx response.
///
/// The API's error body adds fields an agent can act on. Each is `None` when
/// the API did not send it, which is the case for older responses. The text
/// ends with `(code: <code>) (request_id: <id>)` when the API sent them, then
/// the SDK's own `(<sdk code>)`.
///
/// The API's docs link, a 402's billing and top-up links and a
/// pay-per-request (x402) offer are not exposed, in a field or in the text.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct ApiError {
    /// The HTTP status.
    pub status_code: u16,
    /// The API's error message: the body's `message`, else `error`, else
    /// `detail`, or the trimmed text of a body that is not JSON.
    pub body: Option<String>,
    /// The API's stable, machine-readable reason, such as
    /// `rate_limit_per_second` or `target_blocked`. Branch on it, not on the
    /// message.
    pub code: Option<String>,
    /// The error's category, one of the constants in [`types`]. It is derived
    /// from the status and code when the API did not send it, so it is set
    /// on every error response. Empty for a 2xx body that is not an object.
    pub error_type: String,
    /// The API's short error title (the body's `error`), such as
    /// "Rate limit exceeded".
    pub error: Option<String>,
    /// One sentence on what to do next.
    pub fix: Option<String>,
    /// Whether sending the same request again can succeed. `None` when the
    /// API did not say.
    pub retryable: Option<bool>,
    /// How long to wait before retrying: the body's `retry_after_seconds`,
    /// else the `Retry-After` header, else the older `retryAfter` field.
    pub retry_after: Option<Duration>,
    /// The body's `request_id`, else the `X-Request-Id` header.
    pub request_id: Option<String>,
    /// The request parameter a 400 is about.
    pub param: Option<String>,
    /// What a 400 `invalid_filter` error rejected: usually the entry as sent,
    /// but a size cap reports the list's size ("2500 entries") or the first
    /// 64 characters of an over-long entry followed by "...".
    pub value: Option<String>,
    /// Why a 400 `invalid_filter` error rejected [`ApiError::value`].
    pub reason: Option<String>,
    /// The limit a 429 hit (the body's `limit`).
    pub limit: Option<RateLimitInfo>,
    pub(crate) msg: String,
}

impl ApiError {
    pub(crate) fn plain(status_code: u16, msg: String, request_id: Option<String>) -> Self {
        ApiError {
            status_code,
            body: None,
            code: None,
            error_type: String::new(),
            error: None,
            fix: None,
            retryable: None,
            retry_after: None,
            request_id,
            param: None,
            value: None,
            reason: None,
            limit: None,
            msg,
        }
    }

    /// The SDK's sentence for this error, without the trailing codes.
    pub fn message(&self) -> &str {
        &self.msg
    }

    fn write(&self, f: &mut fmt::Formatter<'_>, sdk_code: &str) -> fmt::Result {
        f.write_str(&self.msg)?;
        if let Some(code) = &self.code {
            write!(f, " (code: {code})")?;
        }
        if let Some(id) = &self.request_id {
            write!(f, " (request_id: {id})")?;
        }
        write!(f, " ({sdk_code})")
    }
}

/// The limit a 429 hit. A field the API left out is `None`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
#[non_exhaustive]
pub struct RateLimitInfo {
    /// Who the limit counts: "organization", "ip", "payer" or "agent".
    pub scope: Option<String>,
    /// The window length: "second" or "hour".
    pub window: Option<String>,
    /// The requests allowed per window.
    pub max: Option<u64>,
    /// An ISO 8601 time when the window opens again.
    pub resets_at: Option<String>,
    /// Which endpoint limit was hit ("search" or "fetch") when the
    /// organization has separate limits; `None` for the shared limit.
    pub endpoint: Option<String>,
}

/// HTTP 429: the rate limit was exceeded.
///
/// Keyless calls share a lower hourly cap. Set `KEENABLE_API_KEY` to lift it.
/// A key is never required to make a request.
#[derive(Debug, Clone, PartialEq)]
#[non_exhaustive]
pub struct RateLimitError {
    /// The fields every API error has.
    pub api: ApiError,
    /// The `X-RateLimit-Limit` header.
    pub header_limit: Option<u64>,
    /// The `X-RateLimit-Remaining` header.
    pub header_remaining: Option<u64>,
    /// The `X-RateLimit-Reset` header, so a retry knows when the window opens.
    pub header_reset: Option<String>,
}

impl std::ops::Deref for RateLimitError {
    type Target = ApiError;
    fn deref(&self) -> &ApiError {
        &self.api
    }
}

/// The result type of every fallible call in this crate.
pub type Result<T, E = Error> = std::result::Result<T, E>;
