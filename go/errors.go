package keenable

import "time"

// Stable codes an agent can switch on. They are also the last parentheses
// of Error().
const (
	CodeInvalidRequest = "invalid_request"
	CodeConnection     = "connection"
	CodeAPI            = "api_error"
	CodeAuth           = "auth"
	CodeRateLimit      = "rate_limit"
)

// Error is implemented by every error this package returns.
//
// errors.As into Error catches the whole set, the way except KeenableError
// does in the other SDKs. errors.As into a concrete type catches one case.
// Code is stable. The human sentence is Error().
type Error interface {
	error
	keenableError()
	Code() string
}

// InvalidRequestError means the arguments were rejected locally.
// No request was sent.
type InvalidRequestError struct {
	msg string
}

func (e *InvalidRequestError) Error() string {
	if e == nil {
		return ""
	}
	return e.msg + " (" + CodeInvalidRequest + ")"
}
func (e *InvalidRequestError) Code() string   { return CodeInvalidRequest }
func (e *InvalidRequestError) keenableError() {}

// ConnectionError means the API could not be reached, or the client deadline
// elapsed before the body arrived. A canceled caller context is returned as
// that context's own error, not as a ConnectionError.
type ConnectionError struct {
	msg string
}

func (e *ConnectionError) Error() string {
	if e == nil {
		return ""
	}
	return e.msg + " (" + CodeConnection + ")"
}
func (e *ConnectionError) Code() string   { return CodeConnection }
func (e *ConnectionError) keenableError() {}

// APIError is a non-2xx response.
//
// StatusCode is the HTTP status. Body is the API's error message when it sent
// one, otherwise empty. AuthError, TargetError, RateLimitError and
// InsufficientCreditsError unwrap to APIError.
//
// The API's error body adds fields an agent can act on. Each is the zero value
// (nil for pointers) when the API did not send it, which is the case for
// older responses.
type APIError struct {
	StatusCode int
	Body       string
	// RequestID is the body's request_id, or else the X-Request-Id header.
	RequestID string
	// APICode is the API's stable, machine-readable reason, such as
	// "rate_limit_per_second" or "target_blocked". Branch on it, not on the
	// message. Code() stays the SDK's own coarser code.
	APICode string
	// Title is the API's short error title (the body's "error"), such as
	// "Rate limit exceeded".
	Title string
	// Fix is one sentence on what to do next.
	Fix string
	// DocsURL is the docs page for this error.
	DocsURL string
	// Retryable says whether sending the same request again can succeed.
	// Nil when the API did not say.
	Retryable *bool
	// RetryAfter is how long to wait before retrying: the body's
	// retry_after_seconds, or else the Retry-After header. Zero when neither
	// was sent.
	RetryAfter time.Duration
	// Param is the request parameter a 400 is about.
	Param string
	// RateLimit is the limit a 429 hit (the body's "limit").
	RateLimit *RateLimitInfo
	// BillingURL, AutoTopUpURL and PayPerRequest are set on a 402: where a
	// human can buy credits, how to turn on auto top-up, and the
	// pay-per-request alternative when the API offers it.
	BillingURL    string
	AutoTopUpURL  string
	PayPerRequest string
	// Raw is the whole decoded JSON body, for fields not listed here. Nil
	// when the body was not a JSON object.
	Raw  map[string]any
	msg  string
	code string
}

// RateLimitInfo is the limit a 429 hit. A field the API left out is zero.
type RateLimitInfo struct {
	// Scope is who the limit counts: "organization", "ip", "payer" or "agent".
	Scope string
	// Window is the window length: "second" or "hour".
	Window string
	// Max is the requests allowed per window.
	Max int
	// ResetsAt is an ISO 8601 time when the window opens again.
	ResetsAt string
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	msg := e.msg
	if e.RequestID != "" {
		msg += " (request_id: " + e.RequestID + ")"
	}
	return msg + " (" + e.Code() + ")"
}
func (e *APIError) Code() string {
	if e == nil {
		return ""
	}
	if e.code == "" {
		return CodeAPI
	}
	return e.code
}
func (e *APIError) keenableError() {}

// AuthError means the API key was rejected (HTTP 401 or 403).
type AuthError struct {
	*APIError
}

func (e *AuthError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.APIError
}

// TargetError means the page being fetched failed, not your request or your
// API key. It is returned when the site refused the fetcher (a 403 such as
// "target_blocked", or today's "Upstream forbidden"), could not be reached,
// timed out, or returned no usable page: APICode starts with "target_", or is
// "page_not_found" or "content_not_extracted". A 429 from the site stays a
// RateLimitError with APICode "target_rate_limited".
//
// Check Retryable before retrying: a blocked or missing page returns the same
// error every time, so fetch another source instead.
//
// Code() stays CodeAPI ("api_error"), as for any other APIError, so existing
// switches on Code() keep matching. Detect a target failure with
// errors.As(err, &targetErr).
type TargetError struct {
	*APIError
}

func (e *TargetError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.APIError
}

// RateLimitError means the rate limit was exceeded (HTTP 429).
//
// Keyless calls share a lower hourly cap. Set KEENABLE_API_KEY to lift it.
// A key is never required to make a request.
// Reset is the API's X-RateLimit-Reset value when it sent one, so a retry
// knows when the window opens.
type RateLimitError struct {
	*APIError
	Limit     int
	Remaining int
	Reset     string
}

func (e *RateLimitError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.APIError
}

// InsufficientCreditsError means the organization has no credits left
// (HTTP 402). Retrying returns the same error until credits are added.
// BillingURL is where a human can buy credits. Code() stays CodeAPI, as it
// was before this type existed.
type InsufficientCreditsError struct {
	*APIError
}

func (e *InsufficientCreditsError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.APIError
}

// CreditsError is InsufficientCreditsError under the name the docs use.
type CreditsError = InsufficientCreditsError

var (
	_ Error = (*InvalidRequestError)(nil)
	_ Error = (*ConnectionError)(nil)
	_ Error = (*APIError)(nil)
	_ Error = (*AuthError)(nil)
	_ Error = (*TargetError)(nil)
	_ Error = (*RateLimitError)(nil)
	_ Error = (*InsufficientCreditsError)(nil)
)
