package keenable

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
// one, otherwise empty. AuthError and RateLimitError unwrap to APIError.
type APIError struct {
	StatusCode int
	Body       string
	// RequestID is the API's X-Request-Id, when the response sent one.
	RequestID string
	msg       string
	code      string
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
)
