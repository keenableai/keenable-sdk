package keenable

// Stable codes an agent can switch on. They are also the last parentheses
// of Error().
const (
	CodeInvalidRequest = "invalid_request"
	CodeConnection     = "connection"
	CodeAPI            = "api_error"
	CodeAuth           = "auth"
	CodeRateLimit      = "rate_limit"
	CodeValidation     = "validation"
	CodeCredits        = "credits"
	CodeForbidden      = "forbidden"
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
// one, otherwise empty. Every typed API error below unwraps to APIError.
type APIError struct {
	StatusCode int
	Body       string
	// RequestID is the API's X-Request-Id, when the response sent one.
	RequestID string
	// APIErrorCode is the API's short error label, e.g. "Invalid parameter".
	// Code() is the SDK's stable code; this is the server's own string.
	APIErrorCode string
	// Details is any structured "details" the API attached, unmodified.
	Details any
	// Hint is the one-line next step. Error() ends with it, followed only by
	// the stable code in parentheses. It is exposed separately so a harness
	// can drop it before showing the error to a model.
	Hint string
	msg  string
	code string
}

func (e *APIError) Error() string {
	if e == nil {
		return ""
	}
	// Same layout as the Python and TypeScript SDKs, plus the stable code:
	// "<what failed> (request_id: <id>). <next step> (<code>)".
	msg := e.msg
	if e.RequestID != "" {
		msg += " (request_id: " + e.RequestID + ")"
	}
	if e.Hint != "" {
		msg += ". " + e.Hint
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

// ValidationError means the API rejected the request (HTTP 400 or 422). Body
// says what was rejected, usually naming the parameter. Retrying unchanged
// fails the same way.
type ValidationError struct {
	*APIError
}

func (e *ValidationError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.APIError
}

// CreditsError means the account has no credits left (HTTP 402). Retrying
// does not help until credits are added.
type CreditsError struct {
	*APIError
}

func (e *CreditsError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.APIError
}

// AuthError means the API key is missing or was rejected (HTTP 401).
//
// ForbiddenError (403) unwraps to AuthError, so errors.As into *AuthError
// keeps matching both.
type AuthError struct {
	*APIError
}

func (e *AuthError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.APIError
}

// ForbiddenError means the request is not allowed for this caller (HTTP 403):
// typically a mode or feature that needs an API key, or a plan that includes it.
type ForbiddenError struct {
	*AuthError
}

func (e *ForbiddenError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.AuthError
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

var (
	_ Error = (*InvalidRequestError)(nil)
	_ Error = (*ConnectionError)(nil)
	_ Error = (*APIError)(nil)
	_ Error = (*AuthError)(nil)
	_ Error = (*RateLimitError)(nil)
	_ Error = (*ValidationError)(nil)
	_ Error = (*CreditsError)(nil)
	_ Error = (*ForbiddenError)(nil)
)
