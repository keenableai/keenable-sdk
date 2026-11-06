package keenable

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const (
	// DefaultBaseURL is the Keenable API used when Options.BaseURL and
	// KEENABLE_API_URL are both unset.
	DefaultBaseURL = "https://api.keenable.ai"
	// DefaultContextMaxChars is the ToContext budget: about 3k tokens, enough
	// for a handful of results without crowding out the rest of the prompt.
	DefaultContextMaxChars = 12_000
	// DefaultTimeout is the deadline for one request, including the body.
	DefaultTimeout = 30 * time.Second

	defaultClientSource = "Keenable SDK"
)

// Options configures a [Client].
//
// The zero value, and a nil pointer passed to [New], reads KEENABLE_API_KEY
// and KEENABLE_API_URL and otherwise calls the keyless public API.
//
// APIKey and BaseURL are pointers so "unset" and "explicitly empty" differ.
// Nil reads the environment. A pointer to an empty APIKey forces the keyless
// tier even when KEENABLE_API_KEY is set. A pointer to an empty BaseURL is
// rejected. A Go literal cannot be addressed, so put the string in a variable:
//
//	key := "keen_..."
//	client, err := keenable.New(&keenable.Options{APIKey: &key})
type Options struct {
	APIKey *string
	// BaseURL overrides KEENABLE_API_URL. Must be https, except http to
	// localhost, 127.0.0.1, or ::1.
	BaseURL *string
	// Timeout is the deadline for headers and body. Zero means [DefaultTimeout]
	// when this SDK creates the HTTP client. When HTTPClient is set, zero adds
	// no extra deadline and that client's Timeout is left unchanged. A positive
	// Timeout always applies, through the request context, without mutating
	// HTTPClient. A caller context that ends sooner wins and is returned as
	// ctx.Err(). An SDK or HTTP-client deadline is a [ConnectionError].
	Timeout time.Duration
	// ClientSource is sent as X-Keenable-Title. Empty means "Keenable SDK".
	// Set it when you wrap this SDK and want your own traffic attribution.
	ClientSource string
	// HTTPClient replaces the owned client (proxies, custom transports).
	// Its Timeout and CheckRedirect are left alone, and [Client.Close] does
	// not close it. Cross-host redirects are still refused, so X-API-Key is
	// not sent to another host.
	HTTPClient *http.Client
}

// Client calls the Keenable web search API.
//
// Keyless by default: with no API key it uses the public endpoints, which are
// rate limited per hour. Pass an API key, or set KEENABLE_API_KEY, to lift
// that limit. Create a key at https://keenable.ai/console.
//
// Reuse one Client for the process. Call [Client.Close] when you are done if
// this SDK created the underlying [http.Client].
type Client struct {
	apiKey       string
	baseURL      string
	clientSource string
	// sdkTimeout is applied as a request context deadline. Zero means this SDK
	// adds none, which happens only when the caller supplied an HTTP client
	// and left Options.Timeout at zero.
	sdkTimeout time.Duration
	// clientTimeout is the Timeout of a caller-supplied http.Client. It is
	// zero when this SDK owns the client, or when the supplied client has no
	// deadline of its own.
	clientTimeout time.Duration
	http          *http.Client
	ownsClient    bool
}

// New builds a client. A nil opts reads the environment and uses the defaults.
func New(opts *Options) (*Client, error) {
	if opts == nil {
		opts = &Options{}
	}
	base, err := resolveBaseURL(opts.BaseURL)
	if err != nil {
		return nil, err
	}
	source := opts.ClientSource
	if source == "" {
		source = defaultClientSource
	}
	c := &Client{
		apiKey:       resolveAPIKey(opts.APIKey),
		baseURL:      base,
		clientSource: source,
	}
	if opts.HTTPClient != nil {
		c.http = opts.HTTPClient
		c.clientTimeout = opts.HTTPClient.Timeout
		if opts.Timeout > 0 {
			c.sdkTimeout = opts.Timeout
		}
		return c, nil
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	c.sdkTimeout = timeout
	c.http = &http.Client{Timeout: timeout, CheckRedirect: ownedCheckRedirect}
	c.ownsClient = true
	return c, nil
}

// Close releases idle connections on the client this SDK created.
// It does nothing when Options.HTTPClient was provided.
func (c *Client) Close() {
	if c != nil && c.ownsClient && c.http != nil {
		c.http.CloseIdleConnections()
	}
}

// Keyless reports whether the public tier is in use.
// A nil client reports false.
func (c *Client) Keyless() bool { return c != nil && c.apiKey == "" }

// Search queries the web and returns ranked pages with extracted text.
//
// Describe the ideal page in natural language ("blog post comparing React and
// Vue performance") rather than keywords. The index is semantic.
// opts may be nil.
func (c *Client) Search(ctx context.Context, query string, opts *SearchOptions) (*SearchResponse, error) {
	if err := requireClient(c); err != nil {
		return nil, err
	}
	if err := requireContext(ctx); err != nil {
		return nil, err
	}
	if strings.TrimSpace(query) == "" {
		return nil, &InvalidRequestError{msg: "search() needs a non-empty query. Pass the question as the query argument."}
	}
	mode := "pro"
	if opts != nil && opts.Mode != "" {
		mode = opts.Mode
	}
	payload := map[string]any{
		"query": query,
		"mode":  mode,
	}
	applyFilters(payload, opts)
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, &InvalidRequestError{msg: "could not encode the search request. Retry with a string query."}
	}
	data, err := c.do(ctx, http.MethodPost, "search", body, "")
	if err != nil {
		return nil, err
	}
	return searchResponseFromJSON(data, query), nil
}

// Fetch returns one URL's main content as markdown.
//
// Use it after Search when a snippet is not enough. Internal hosts and private
// addresses are refused here, before a request is sent.
func (c *Client) Fetch(ctx context.Context, pageURL string) (*Page, error) {
	if err := requireClient(c); err != nil {
		return nil, err
	}
	if err := requireContext(ctx); err != nil {
		return nil, err
	}
	if err := rejectPrivateFetchTarget(pageURL); err != nil {
		return nil, err
	}
	data, err := c.do(ctx, http.MethodGet, "fetch", nil, pageURL)
	if err != nil {
		return nil, err
	}
	return pageFromJSON(data, pageURL), nil
}

func requireClient(c *Client) error {
	if c == nil || c.http == nil {
		return &InvalidRequestError{msg: "nil client: call keenable.New and use the client it returns"}
	}
	return nil
}

func requireContext(ctx context.Context) error {
	if ctx == nil {
		return &InvalidRequestError{msg: "nil context: pass context.Background() or a request context"}
	}
	return nil
}

func (c *Client) do(ctx context.Context, method, endpoint string, body []byte, fetchURL string) (map[string]any, error) {
	rawURL, err := c.endpointURL(endpoint, fetchURL)
	if err != nil {
		return nil, err
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	reqCtx := ctx
	if c.sdkTimeout > 0 {
		var stop context.CancelFunc
		reqCtx, stop = context.WithTimeout(ctx, c.sdkTimeout)
		defer stop()
	}
	req, err := http.NewRequestWithContext(reqCtx, method, rawURL, reader)
	if err != nil {
		return nil, &InvalidRequestError{msg: "could not build the request: " + err.Error() + ". Check Options.BaseURL or KEENABLE_API_URL."}
	}
	req.Header = c.headers(body != nil)

	resp, err := c.requestClient().Do(req)
	if err != nil {
		return nil, c.transportError(ctx, reqCtx, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, c.transportError(ctx, reqCtx, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, toAPIError(resp.StatusCode, raw, resp.Header, c.Keyless())
	}
	return decodeObject(resp.StatusCode, raw, resp.Header)
}

// requestClient applies the redirect guard. A caller-supplied client is cloned
// so its Timeout and CheckRedirect fields stay as the caller set them.
func (c *Client) requestClient() *http.Client {
	if c.ownsClient {
		return c.http
	}
	clone := *c.http
	user := c.http.CheckRedirect
	clone.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if err := refuseCrossHostRedirect(req, via); err != nil {
			return err
		}
		if user != nil {
			return user(req, via)
		}
		if len(via) >= 10 {
			return errors.New("stopped after 10 redirects")
		}
		return nil
	}
	return &clone
}

func ownedCheckRedirect(req *http.Request, via []*http.Request) error {
	if err := refuseCrossHostRedirect(req, via); err != nil {
		return err
	}
	if len(via) >= 10 {
		return errors.New("stopped after 10 redirects")
	}
	return nil
}

type crossHostRedirectError struct {
	to string
}

func (e *crossHostRedirectError) Error() string {
	return "refusing to follow a redirect to " + e.to
}

// refuseCrossHostRedirect drops X-API-Key and stops the redirect when the
// next hop is a different host or scheme. Go strips Authorization on those
// hops and leaves a custom header in place, which would send the API key away.
func refuseCrossHostRedirect(req *http.Request, via []*http.Request) error {
	if len(via) == 0 || req == nil || req.URL == nil || via[0].URL == nil {
		return nil
	}
	initial := via[0].URL
	if strings.EqualFold(initial.Scheme, req.URL.Scheme) && strings.EqualFold(initial.Host, req.URL.Host) {
		return nil
	}
	req.Header.Del("X-API-Key")
	return &crossHostRedirectError{to: req.URL.Host}
}

func (c *Client) transportError(caller, reqCtx context.Context, err error) error {
	if caller.Err() != nil {
		return caller.Err()
	}
	var redirected *crossHostRedirectError
	if errors.As(err, &redirected) {
		return &ConnectionError{msg: fmt.Sprintf(
			"the Keenable API redirected to %s. The redirect was not followed, so the API key was not sent. Check KEENABLE_API_URL.",
			redirected.to,
		)}
	}
	if reqCtx.Err() != nil {
		return &ConnectionError{msg: fmt.Sprintf(
			"the Keenable API did not respond within %s. Raise Options.Timeout.",
			c.sdkTimeout,
		)}
	}
	if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
		if !c.ownsClient {
			if c.clientTimeout > 0 {
				return &ConnectionError{msg: fmt.Sprintf(
					"the Keenable API did not respond within %s. Raise Timeout on the http.Client you passed to New.",
					c.clientTimeout,
				)}
			}
			return &ConnectionError{msg: "the Keenable API did not respond before the request deadline. Set Timeout on the http.Client you passed to New, or set Options.Timeout."}
		}
		return &ConnectionError{msg: fmt.Sprintf(
			"the Keenable API did not respond within %s. Raise Options.Timeout.",
			c.sdkTimeout,
		)}
	}
	return &ConnectionError{msg: fmt.Sprintf("could not reach the Keenable API: %v. Check KEENABLE_API_URL and retry.", err)}
}

func isTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

func (c *Client) headers(jsonBody bool) http.Header {
	h := make(http.Header)
	h.Set("Accept", "application/json")
	h.Set("User-Agent", "keenable-go/"+Version)
	// The public tier rejects requests without this header.
	h.Set("X-Keenable-Title", c.clientSource)
	if c.apiKey != "" {
		h.Set("X-API-Key", c.apiKey)
	}
	if jsonBody {
		h.Set("Content-Type", "application/json")
	}
	return h
}

func (c *Client) endpointURL(endpoint, fetchURL string) (string, error) {
	u, err := url.Parse(c.baseURL)
	if err != nil || u.Host == "" {
		return "", &InvalidRequestError{msg: fmt.Sprintf("baseURL %q is not a valid URL. Pass an https URL with a host.", c.baseURL)}
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/v1/" + endpoint
	if c.apiKey == "" {
		u.Path += "/public"
	}
	u.RawQuery = ""
	u.Fragment = ""
	if fetchURL != "" {
		q := url.Values{}
		q.Set("url", fetchURL)
		u.RawQuery = q.Encode()
	}
	return u.String(), nil
}

func resolveAPIKey(explicit *string) string {
	var key string
	if explicit != nil {
		key = *explicit
	} else {
		key = os.Getenv("KEENABLE_API_KEY")
	}
	return strings.TrimSpace(key)
}

func resolveBaseURL(explicit *string) (string, error) {
	var raw string
	if explicit != nil {
		raw = *explicit
	} else if v, ok := os.LookupEnv("KEENABLE_API_URL"); ok && strings.TrimSpace(v) != "" {
		raw = v
	} else {
		raw = DefaultBaseURL
	}
	raw = strings.TrimRight(strings.TrimSpace(raw), "/")
	if raw == "" {
		return "", &InvalidRequestError{msg: `baseURL must be an https:// URL with a host, got ""`}
	}
	u, err := url.Parse(raw)
	if err != nil || u.Hostname() == "" {
		return "", &InvalidRequestError{msg: fmt.Sprintf("baseURL must be an https:// URL with a host, got %q", raw)}
	}
	if u.RawQuery != "" || u.Fragment != "" {
		return "", &InvalidRequestError{msg: fmt.Sprintf(
			"baseURL must be an https:// URL with a host and no query or fragment, got %q",
			raw,
		)}
	}
	scheme := strings.ToLower(u.Scheme)
	host := normalizeHost(u.Hostname())
	if scheme == "https" || (scheme == "http" && isLocalHost(host)) {
		return raw, nil
	}
	return "", &InvalidRequestError{msg: fmt.Sprintf(
		"baseURL must use https (http is only allowed for localhost, 127.0.0.1, and ::1), got %q",
		raw,
	)}
}

func isLocalHost(host string) bool {
	switch host {
	case "localhost", "127.0.0.1", "::1":
		return true
	default:
		return false
	}
}

var blockedHosts = map[string]struct{}{
	"localhost":                {},
	"metadata.google.internal": {},
}

// rejectPrivateFetchTarget refuses obviously internal fetch targets before a
// request leaves the process. The API enforces this too. Stopping here keeps
// an internal hostname out of an outbound request.
func rejectPrivateFetchTarget(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return &InvalidRequestError{msg: fmt.Sprintf("fetch() needs an http(s) URL, got %q. Use an https URL on the public internet.", raw)}
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return &InvalidRequestError{msg: fmt.Sprintf("fetch() needs an http(s) URL, got %q. Use an https URL on the public internet.", raw)}
	}
	// A trailing dot resolves to the same host but does not match it as a
	// string, which is enough to walk past a blocklist.
	host := normalizeHost(u.Hostname())
	if host == "" {
		return &InvalidRequestError{msg: fmt.Sprintf("fetch() URL has no host: %q. Pass an https URL with a public host.", raw)}
	}
	if _, blocked := blockedHosts[host]; blocked {
		return &InvalidRequestError{msg: fmt.Sprintf("refusing to fetch internal host %q. Pass a public http(s) URL.", host)}
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return nil // A hostname. The API's SSRF guard is the backstop.
	}
	// ::ffff:127.0.0.1 and ::ffff:7f00:1 reach the same machine as 127.0.0.1.
	if isNonPublic(addr.Unmap()) {
		return &InvalidRequestError{msg: fmt.Sprintf("refusing to fetch private address %q. Pass a public http(s) URL.", host)}
	}
	return nil
}

func normalizeHost(host string) string {
	host = strings.ToLower(strings.TrimSpace(host))
	host = strings.TrimPrefix(host, "[")
	host = strings.TrimSuffix(host, "]")
	return strings.TrimRight(host, ".")
}

func isNonPublic(addr netip.Addr) bool {
	return addr.IsLoopback() ||
		addr.IsPrivate() ||
		addr.IsLinkLocalUnicast() ||
		addr.IsLinkLocalMulticast() ||
		addr.IsMulticast() ||
		addr.IsUnspecified() ||
		!addr.IsGlobalUnicast()
}

var statusLabels = map[int]string{
	401: "Keenable authentication failed (401)",
	403: "Keenable authentication failed (403)",
	402: "Keenable: insufficient credits (402)",
	429: "Keenable rate limit exceeded (429)",
}

// notAuthCodes are 403 codes about the page being fetched, not about the
// caller's credentials, so they are not reported as an AuthError.
var notAuthCodes = map[string]bool{"target_blocked": true}

// notYourLimitCodes are 429 codes for a limit that is not the caller's own
// (ours or the fetched site's), so a key would not lift it.
var notYourLimitCodes = map[string]bool{
	"target_rate_limited": true,
	"search_rate_limited": true,
	"fetch_rate_limited":  true,
}

func toAPIError(status int, raw []byte, header http.Header, keyless bool) error {
	detail := ""
	var body any
	var obj map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		detail = strings.TrimSpace(string(raw))
	} else if m, ok := body.(map[string]any); ok {
		obj = m
		detail = firstDetail(m, "message", "error", "detail")
	}
	api := parseErrorBody(obj, header)
	api.StatusCode = status
	api.Body = detail

	auth := (status == 401 || status == 403) && !notAuthCodes[api.APICode]
	label, ok := statusLabels[status]
	if !ok || ((status == 401 || status == 403) && !auth) {
		label = fmt.Sprintf("Keenable API error (%d)", status)
	}
	msg := label
	if detail != "" {
		msg = label + ": " + detail
	}
	// When the API sends a fix, it is the next step for every status: it is
	// specific to this failure and says whether a retry can help, which the
	// generic advice below cannot. Python and TypeScript append it the same way.
	switch {
	case api.Fix != "":
		msg += ". " + api.Fix
	case auth:
		msg += ". Check KEENABLE_API_KEY, or pass Options.APIKey."
	case status == 402:
		msg += ". Add credits at https://keenable.ai/console."
	case status == 429 && notYourLimitCodes[api.APICode]:
		// Not the caller's own limit, so a key would not lift it.
		msg += ". Wait for the rate limit window to reset, then retry."
	case status == 429 && keyless:
		msg += ". Set KEENABLE_API_KEY to lift the keyless hourly cap. Create a key at https://keenable.ai/console."
	case status == 429:
		msg += ". Wait for the rate limit window to reset, then retry."
	default:
		msg += ". Retry the request. If it keeps failing, confirm KEENABLE_API_URL."
	}
	if status == 429 {
		if reset := headerValue(header, "X-RateLimit-Reset"); reset != "" {
			msg += " Retry after " + reset + "."
		} else if api.RetryAfter > 0 {
			msg += " Retry after " + api.RetryAfter.String() + "."
		}
	}
	api.msg = msg
	return classifyStatus(api, auth, header)
}

func classifyStatus(api *APIError, auth bool, header http.Header) error {
	api.code = CodeAPI
	switch {
	case auth:
		api.code = CodeAuth
		return &AuthError{APIError: api}
	case api.StatusCode == 429:
		api.code = CodeRateLimit
		return &RateLimitError{
			APIError:  api,
			Limit:     headerInt(header, "X-RateLimit-Limit"),
			Remaining: headerInt(header, "X-RateLimit-Remaining"),
			Reset:     headerValue(header, "X-RateLimit-Reset"),
		}
	case api.StatusCode == 402:
		return &InsufficientCreditsError{APIError: api}
	default:
		return api
	}
}

// parseErrorBody reads the agent-ready fields of an error body. RetryAfter
// prefers the body's retry_after_seconds, then the Retry-After header, then
// the older retryAfter body field. RequestID prefers the body's request_id,
// then the X-Request-Id header.
func parseErrorBody(m map[string]any, header http.Header) *APIError {
	api := &APIError{
		Raw:           m,
		APICode:       stringField(m, "code"),
		Title:         stringField(m, "error"),
		Fix:           stringField(m, "fix"),
		DocsURL:       stringField(m, "docs_url"),
		RequestID:     stringField(m, "request_id"),
		Param:         stringField(m, "param"),
		BillingURL:    stringField(m, "billing_url"),
		AutoTopUpURL:  stringField(m, "auto_top_up_url"),
		PayPerRequest: stringField(m, "pay_per_request"),
	}
	if api.RequestID == "" {
		api.RequestID = headerValue(header, "X-Request-Id")
	}
	if b, ok := m["retryable"].(bool); ok {
		api.Retryable = &b
	}
	if d, ok := secondsField(m, "retry_after_seconds"); ok {
		api.RetryAfter = d
	} else if d, ok := retryAfterHeader(headerValue(header, "Retry-After")); ok {
		api.RetryAfter = d
	} else if d, ok := secondsField(m, "retryAfter"); ok {
		api.RetryAfter = d
	}
	if l, ok := m["limit"].(map[string]any); ok {
		info := &RateLimitInfo{
			Scope:    stringField(l, "scope"),
			Window:   stringField(l, "window"),
			ResetsAt: stringField(l, "resets_at"),
		}
		if n, ok := l["max"].(float64); ok && n == math.Trunc(n) && !math.IsInf(n, 0) {
			info.Max = int(n)
		}
		api.RateLimit = info
	}
	return api
}

func stringField(m map[string]any, key string) string {
	s, ok := m[key].(string)
	if !ok || strings.TrimSpace(s) == "" {
		return ""
	}
	return s
}

// maxRetryAfter caps a hint so converting it to a Duration cannot overflow.
const maxRetryAfter = 365 * 24 * time.Hour

func secondsField(m map[string]any, key string) (time.Duration, bool) {
	n, ok := m[key].(float64)
	if !ok || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 {
		return 0, false
	}
	if n > maxRetryAfter.Seconds() {
		return maxRetryAfter, true
	}
	return time.Duration(n * float64(time.Second)), true
}

// retryAfterHeader parses a Retry-After header: delay-seconds or an HTTP date.
func retryAfterHeader(v string) (time.Duration, bool) {
	if v == "" {
		return 0, false
	}
	n, err := strconv.ParseUint(v, 10, 64)
	if err == nil {
		if n > uint64(maxRetryAfter/time.Second) {
			return maxRetryAfter, true
		}
		return time.Duration(n) * time.Second, true
	}
	if errors.Is(err, strconv.ErrRange) {
		// All digits, just too many for a uint64: still a delay, capped.
		return maxRetryAfter, true
	}
	when, err := http.ParseTime(v)
	if err != nil {
		return 0, false
	}
	d := time.Until(when)
	if d <= 0 {
		return 0, true
	}
	// Round up, as the other SDKs do, so waiting this long is never too early.
	return (d + time.Second - 1).Truncate(time.Second), true
}

func headerValue(h http.Header, key string) string {
	if h == nil {
		return ""
	}
	return strings.TrimSpace(h.Get(key))
}

func headerInt(h http.Header, key string) int {
	n, err := strconv.Atoi(headerValue(h, key))
	if err != nil {
		return 0
	}
	return n
}

func firstDetail(m map[string]any, keys ...string) string {
	for _, key := range keys {
		v, ok := m[key]
		if !ok || v == nil {
			continue
		}
		var s string
		switch t := v.(type) {
		case string:
			s = t
		default:
			s = fmt.Sprint(t)
		}
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func decodeObject(status int, raw []byte, header http.Header) (map[string]any, error) {
	snippet := raw
	if len(snippet) > 200 {
		snippet = snippet[:200]
	}
	id := headerValue(header, "X-Request-Id")
	var data any
	if err := json.Unmarshal(raw, &data); err != nil {
		return nil, &APIError{
			StatusCode: status,
			RequestID:  id,
			code:       CodeAPI,
			msg:        fmt.Sprintf("Keenable API returned a non-JSON response: %q. Retry the request. If it keeps failing, confirm KEENABLE_API_URL.", string(snippet)),
		}
	}
	obj, ok := data.(map[string]any)
	if !ok {
		return nil, &APIError{
			StatusCode: status,
			RequestID:  id,
			code:       CodeAPI,
			msg:        fmt.Sprintf("Unexpected response from the Keenable API: %q. Retry the request. If it keeps failing, confirm KEENABLE_API_URL.", string(snippet)),
		}
	}
	return obj, nil
}
