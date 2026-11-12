package keenable

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand/v2"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"regexp"
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
	// DefaultContextMaxSnippetChars is the per-result cap ToContext applies
	// to page text. Snippets are often whole pages (4,000 to 13,000
	// characters); uncapped, one or two eat the budget meant for every source.
	DefaultContextMaxSnippetChars = 2_000
	// DefaultTimeout is the deadline for one request, including the body.
	DefaultTimeout = 30 * time.Second

	// DefaultMaxRetries is how many times a failed request is retried when
	// Options.MaxRetries is nil.
	DefaultMaxRetries = 2

	defaultClientSource = "Keenable SDK"

	// Retry timing, the same in the Python and TypeScript SDKs.
	initialRetryDelay = 500 * time.Millisecond
	maxRetryDelay     = 8 * time.Second
	// maxRetryAfterWait is the longest server-requested wait that is waited
	// out. A longer one, such as the keyless hourly cap, is returned at once.
	maxRetryAfterWait = 60 * time.Second
	// maxTimeout is the longest per-attempt deadline: about 24.8 days, the
	// longest a JavaScript timer can wait. A longer timeout is treated as it.
	maxTimeout = 2147483647 * time.Millisecond
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
	// MaxRetries is how many times to retry a failed request. Nil means
	// [DefaultMaxRetries]; a pointer to zero turns retries off.
	//
	// Connection errors, timeouts, 408, 429 and 5xx are retried, unless the
	// API says the error is not retryable (APIError.Retryable decides when
	// sent). The wait is the API's Retry-After when it sent one, else
	// exponential backoff from 0.5s up to 8s with jitter. A Retry-After
	// longer than 60s is not waited out: the error is returned at once. A
	// canceled ctx stops the wait.
	MaxRetries *int
	// Headers are sent with every request, e.g. for a proxy or gateway.
	// X-API-Key is ignored here: it always comes from APIKey.
	Headers map[string]string
	// HTTPClient replaces the owned client (proxies, custom transports).
	// Its Timeout and CheckRedirect are left alone, and [Client.Close] does
	// not close it. Redirects are still never followed, whatever its
	// CheckRedirect says, so X-API-Key goes only to the configured host.
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
	maxRetries    int
	// defaultHeaders is a copy of Options.Headers.
	defaultHeaders map[string]string
}

// RequestOptions are per-call transport settings. Each overrides the client's
// setting for this call only. They are embedded in [SearchOptions] and
// [FetchOptions].
type RequestOptions struct {
	// Timeout is the deadline for each attempt of this call. Nil keeps the
	// client's; a pointer to zero or less is an [InvalidRequestError]. A ctx
	// deadline also applies, to the whole call.
	//
	//	timeout := 5 * time.Second
	//	opts := &keenable.FetchOptions{RequestOptions: keenable.RequestOptions{Timeout: &timeout}}
	Timeout *time.Duration
	// MaxRetries is this call's retry budget. Nil keeps the client's; a
	// pointer to zero turns retries off.
	MaxRetries *int
	// Headers are sent with this call, over Options.Headers. X-API-Key is
	// ignored. A name that is not an HTTP token, or a value with CR, LF or
	// NUL, is an [InvalidRequestError].
	Headers map[string]string
}

// FetchOptions are the optional arguments to [Client.FetchWithOptions].
//
// The zero value of each field means unset, and an unset option is not sent.
type FetchOptions struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	// MaxChars caps the characters of content returned, a positive integer.
	// Zero means unset, and the API applies its default of 50000.
	// Page.Truncated and Page.TotalChars say whether the page was cut and
	// how long it was.
	MaxChars int
	// Live fetches the page from its source now instead of reading
	// Keenable's indexed copy. False is the API's default and is not sent.
	Live bool
	// Prompt is an extraction instruction, up to 2000 characters, such as
	// "list the pricing tiers". Page.Content is then only the model's
	// output for it, not the page. Empty means unset. A page too long for a
	// prompt fails with a 422 *APIError whose APICode is
	// "prompt_input_too_long": fetch it again without Prompt.
	Prompt string
}

// params is the query string fetch sends after url, unset options left out.
func (o *FetchOptions) params() url.Values {
	q := url.Values{}
	if o == nil {
		return q
	}
	if o.MaxChars != 0 {
		q.Set("max_chars", strconv.Itoa(o.MaxChars))
	}
	// The API reads only "true" and "false", and an absent live is false.
	if o.Live {
		q.Set("live", "true")
	}
	if o.Prompt != "" {
		q.Set("prompt", o.Prompt)
	}
	return q
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
	maxRetries := DefaultMaxRetries
	if opts.MaxRetries != nil {
		if *opts.MaxRetries < 0 {
			return nil, &InvalidRequestError{msg: fmt.Sprintf("MaxRetries must be zero or more, got %d", *opts.MaxRetries)}
		}
		maxRetries = *opts.MaxRetries
	}
	if opts.Timeout < 0 {
		return nil, &InvalidRequestError{msg: fmt.Sprintf("Timeout must be zero or more, got %s", opts.Timeout)}
	}
	if err := checkHeaders(opts.Headers); err != nil {
		return nil, err
	}
	headers := make(map[string]string, len(opts.Headers))
	for k, v := range opts.Headers {
		headers[k] = v
	}
	c := &Client{
		apiKey:         resolveAPIKey(opts.APIKey),
		baseURL:        base,
		clientSource:   source,
		maxRetries:     maxRetries,
		defaultHeaders: headers,
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
	// No http.Client.Timeout: the per-attempt context deadline covers headers
	// and body, and a fixed client timeout would cut off a longer
	// RequestOptions.Timeout.
	c.http = &http.Client{CheckRedirect: refuseRedirect}
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
		return nil, &InvalidRequestError{msg: "could not encode the search request: " + err.Error() + ". Pass JSON-encodable arguments."}
	}
	var req *RequestOptions
	if opts != nil {
		req = &opts.RequestOptions
	}
	data, id, err := c.do(ctx, http.MethodPost, "search", body, nil, req)
	if err != nil {
		return nil, err
	}
	resp := searchResponseFromJSON(data, query)
	resp.RequestID = requestID(data, id)
	return resp, nil
}

// requestID prefers the body's request_id, then the X-Request-Id header.
func requestID(data map[string]any, header string) string {
	if id := stringField(data, "request_id"); id != "" {
		return id
	}
	return header
}

// Fetch returns one URL's main content as markdown.
//
// Use it after Search when a snippet is not enough. Internal hosts and private
// addresses are refused here, before a request is sent. Use
// [Client.FetchWithOptions] to cap the content, fetch the page live, pass an
// extraction prompt, or set a timeout, retries or headers for one call.
func (c *Client) Fetch(ctx context.Context, pageURL string) (*Page, error) {
	return c.FetchWithOptions(ctx, pageURL, nil)
}

// FetchWithOptions is [Client.Fetch] with the options in [FetchOptions] and
// per-call settings. opts may be nil.
func (c *Client) FetchWithOptions(ctx context.Context, pageURL string, opts *FetchOptions) (*Page, error) {
	if err := requireClient(c); err != nil {
		return nil, err
	}
	if err := requireContext(ctx); err != nil {
		return nil, err
	}
	if err := rejectPrivateFetchTarget(pageURL); err != nil {
		return nil, err
	}
	var req *RequestOptions
	if opts != nil {
		req = &opts.RequestOptions
	}
	query := opts.params()
	query.Set("url", pageURL)
	data, id, err := c.do(ctx, http.MethodGet, "fetch", nil, query, req)
	if err != nil {
		return nil, err
	}
	page := pageFromJSON(data, pageURL)
	page.RequestID = requestID(data, id)
	return page, nil
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

// sleep waits d or until ctx ends. Tests replace it to skip the waits.
var sleep = func(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// backoff is the wait before retry number retry (0 for the first): 0.5s
// doubling up to 8s, shortened by up to 25% of jitter (jitter in [0, 1)) so
// clients that failed together do not retry together. Kept in step with the
// Python and TypeScript SDKs.
func backoff(retry int, jitter float64) time.Duration {
	d := maxRetryDelay
	if retry < 5 {
		d = min(initialRetryDelay<<retry, maxRetryDelay)
	}
	return time.Duration(float64(d) * (1 - 0.25*jitter))
}

// retryDelay is how long to wait before retrying after err, and false when it
// should not be retried. The API's Retryable decides when it sent one;
// otherwise 408, 429 and 5xx are retried, and so are network failures and
// timeouts. A Retry-After over a minute is not waited out.
func retryDelay(err error, retry int, jitter float64) (time.Duration, bool) {
	var api *APIError
	if errors.As(err, &api) {
		retryable := api.StatusCode == 408 || api.StatusCode == 429 || api.StatusCode >= 500
		if api.Retryable != nil {
			retryable = *api.Retryable
		}
		if !retryable {
			return 0, false
		}
		if api.retryAfterSet {
			if api.RetryAfter > maxRetryAfterWait {
				return 0, false
			}
			return api.RetryAfter, true
		}
		return backoff(retry, jitter), true
	}
	var conn *ConnectionError
	if errors.As(err, &conn) && !conn.redirect {
		return backoff(retry, jitter), true
	}
	return 0, false
}

func (c *Client) do(ctx context.Context, method, endpoint string, body []byte, query url.Values, opts *RequestOptions) (map[string]any, string, error) {
	rawURL, err := c.endpointURL(endpoint, query)
	if err != nil {
		return nil, "", err
	}
	timeout := c.sdkTimeout
	retries := c.maxRetries
	var extra map[string]string
	if opts != nil {
		if opts.Timeout != nil {
			if *opts.Timeout <= 0 {
				return nil, "", &InvalidRequestError{msg: fmt.Sprintf("RequestOptions.Timeout must be more than zero, got %s. Leave it nil to keep the client's.", *opts.Timeout)}
			}
			timeout = *opts.Timeout
		}
		if opts.MaxRetries != nil {
			if *opts.MaxRetries < 0 {
				return nil, "", &InvalidRequestError{msg: fmt.Sprintf("MaxRetries must be zero or more, got %d", *opts.MaxRetries)}
			}
			retries = *opts.MaxRetries
		}
		if err := checkHeaders(opts.Headers); err != nil {
			return nil, "", err
		}
		extra = opts.Headers
	}
	// The longest wait a JavaScript timer can hold, so every SDK treats a
	// huge timeout the same way.
	timeout = min(timeout, maxTimeout)
	header := c.headers(body != nil, extra)
	for retry := 0; ; retry++ {
		data, id, err := c.attempt(ctx, method, rawURL, body, header, timeout)
		if err == nil {
			return data, id, nil
		}
		if retry >= retries {
			return nil, "", err
		}
		wait, ok := retryDelay(err, retry, rand.Float64())
		if !ok {
			return nil, "", err
		}
		// A wait the caller's deadline cannot outlast would only end in
		// ctx.Err(); return the error that caused it instead, with its
		// RetryAfter, Fix and RequestID.
		if deadline, has := ctx.Deadline(); has && time.Until(deadline) <= wait {
			return nil, "", err
		}
		if serr := sleep(ctx, wait); serr != nil {
			return nil, "", serr
		}
	}
}

// attempt sends one request with its own deadline and decodes the reply.
func (c *Client) attempt(ctx context.Context, method, rawURL string, body []byte, header http.Header, timeout time.Duration) (map[string]any, string, error) {
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	reqCtx := ctx
	if timeout > 0 {
		var stop context.CancelFunc
		reqCtx, stop = context.WithTimeout(ctx, timeout)
		defer stop()
	}
	req, err := http.NewRequestWithContext(reqCtx, method, rawURL, reader)
	if err != nil {
		return nil, "", &InvalidRequestError{msg: "could not build the request: " + err.Error() + ". Check Options.BaseURL or KEENABLE_API_URL."}
	}
	req.Header = header.Clone()

	resp, err := c.requestClient().Do(req)
	if err != nil {
		return nil, "", c.transportError(ctx, reqCtx, err, timeout)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, "", c.transportError(ctx, reqCtx, err, timeout)
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		// No redirect is followed (refuseRedirect). Report it as Python and
		// TypeScript do, not as an API error that says to retry.
		where := ""
		if loc := headerValue(resp.Header, "Location"); loc != "" {
			where = " to " + loc
		}
		return nil, "", &ConnectionError{redirect: true, msg: fmt.Sprintf(
			"the Keenable API redirected%s. The redirect was not followed, so the API key was not sent. Check KEENABLE_API_URL.",
			where,
		)}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", toAPIError(resp.StatusCode, raw, resp.Header, c.Keyless())
	}
	data, err := decodeObject(resp.StatusCode, raw, resp.Header)
	return data, headerValue(resp.Header, "X-Request-Id"), err
}

// requestClient applies the redirect guard. A caller-supplied client is cloned
// so its Timeout and CheckRedirect fields stay as the caller set them.
func (c *Client) requestClient() *http.Client {
	if c.ownsClient {
		return c.http
	}
	clone := *c.http
	clone.CheckRedirect = refuseRedirect
	return &clone
}

// refuseRedirect stops every redirect, the same host included, before the
// next hop is sent: Go strips Authorization on a cross-host hop but keeps a
// custom header such as X-API-Key, and no hop is needed to reach the API. The
// 3xx is then returned as is and becomes the redirect ConnectionError, as in
// Python and TypeScript. A caller's own CheckRedirect is not consulted.
func refuseRedirect(*http.Request, []*http.Request) error {
	return http.ErrUseLastResponse
}

func (c *Client) transportError(caller, reqCtx context.Context, err error, timeout time.Duration) error {
	if caller.Err() != nil {
		return caller.Err()
	}
	if reqCtx.Err() != nil {
		return &ConnectionError{timeout: true, msg: fmt.Sprintf(
			"the Keenable API did not respond within %s. Raise Options.Timeout.",
			timeout,
		)}
	}
	if errors.Is(err, context.DeadlineExceeded) || isTimeout(err) {
		if !c.ownsClient {
			if c.clientTimeout > 0 {
				return &ConnectionError{timeout: true, msg: fmt.Sprintf(
					"the Keenable API did not respond within %s. Raise Timeout on the http.Client you passed to New.",
					c.clientTimeout,
				)}
			}
			return &ConnectionError{timeout: true, msg: "the Keenable API did not respond before the request deadline. Set Timeout on the http.Client you passed to New, or set Options.Timeout."}
		}
		return &ConnectionError{timeout: true, msg: fmt.Sprintf(
			"the Keenable API did not respond within %s. Raise Options.Timeout.",
			timeout,
		)}
	}
	return &ConnectionError{msg: fmt.Sprintf("could not reach the Keenable API: %v. Check KEENABLE_API_URL and retry.", err)}
}

func isTimeout(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// checkHeaders refuses a header the transport would refuse, before anything
// is sent: a name that is not an HTTP token, or a value with CR, LF or NUL.
// Sent anyway, it fails as a connection error that is retried for nothing.
func checkHeaders(h map[string]string) error {
	for name, value := range h {
		if name == "" || strings.IndexFunc(name, func(r rune) bool { return !isTokenRune(r) }) >= 0 {
			return &InvalidRequestError{msg: fmt.Sprintf("header name %q is not a valid HTTP header name. Use letters, digits and -.", name)}
		}
		if strings.ContainsAny(value, "\r\n\x00") {
			return &InvalidRequestError{msg: fmt.Sprintf("header %q has a CR, LF or NUL in its value. Remove it.", name)}
		}
	}
	return nil
}

// isTokenRune reports whether r may appear in an HTTP token (RFC 9110).
func isTokenRune(r rune) bool {
	switch {
	case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		return true
	}
	return strings.ContainsRune("!#$%&'*+-.^_`|~", r)
}

// headers are the SDK's own, then Options.Headers, then the call's. The API
// key always comes from the client, so a stray header cannot send a
// different key or turn a keyless call keyed.
func (c *Client) headers(jsonBody bool, extra map[string]string) http.Header {
	h := make(http.Header)
	h.Set("Accept", "application/json")
	h.Set("User-Agent", "keenable-go/"+Version)
	// The public tier rejects requests without this header.
	h.Set("X-Keenable-Title", c.clientSource)
	for _, src := range []map[string]string{c.defaultHeaders, extra} {
		for k, v := range src {
			if !strings.EqualFold(k, "X-API-Key") {
				h.Set(k, v)
			}
		}
	}
	if c.apiKey != "" {
		h.Set("X-API-Key", c.apiKey)
	}
	if jsonBody {
		h.Set("Content-Type", "application/json")
	}
	return h
}

func (c *Client) endpointURL(endpoint string, query url.Values) (string, error) {
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
	u.RawQuery = query.Encode()
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
// an internal hostname out of an outbound request. The rules are the same in
// every SDK: scripts/conformance/README.md.
func rejectPrivateFetchTarget(raw string) error {
	notHTTP := &InvalidRequestError{msg: fmt.Sprintf("fetch() needs an http(s) URL, got %q. Use an https URL on the public internet.", raw)}
	// Parsers disagree on what control characters and surrounding spaces
	// mean (WHATWG deletes a tab, Go refuses it), so none is accepted.
	if strings.ContainsFunc(raw, func(r rune) bool { return r < 0x20 || r == 0x7f }) || strings.Trim(raw, " ") != raw {
		return notHTTP
	}
	// Exactly "scheme://": a WHATWG parser reads https:host, https:/host and
	// https:///host all as https://host/, which Go reads as hostless.
	sep := strings.Index(raw, "://")
	if sep < 0 {
		return notHTTP
	}
	if scheme := raw[:sep]; !strings.EqualFold(scheme, "http") && !strings.EqualFold(scheme, "https") {
		return notHTTP
	}
	authority := raw[sep+3:]
	if end := strings.IndexAny(authority, "/?#"); end >= 0 {
		authority = authority[:end]
	}
	// A WHATWG parser reads a backslash as a slash and Go does not, so they
	// would disagree on the host.
	if strings.Contains(authority, `\`) {
		return &InvalidRequestError{msg: fmt.Sprintf("fetch() URL has a backslash in its host: %q. Pass an https URL with a public host.", raw)}
	}
	u, err := url.Parse(raw)
	if err != nil {
		return notHTTP
	}
	host := fetchHost(u.Hostname())
	if host == "" {
		return &InvalidRequestError{msg: fmt.Sprintf("fetch() URL has no host: %q. Pass an https URL with a public host.", raw)}
	}
	if _, blocked := blockedHosts[host]; blocked || strings.HasSuffix(host, ".localhost") {
		return &InvalidRequestError{msg: fmt.Sprintf("refusing to fetch internal host %q. Pass a public http(s) URL.", host)}
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		var ok bool
		if addr, ok = numericIPv4(host); !ok {
			return nil // A hostname. The API's SSRF guard is the backstop.
		}
	}
	if isNonPublic(addr) {
		return &InvalidRequestError{msg: fmt.Sprintf("refusing to fetch private address %q. Pass a public http(s) URL.", host)}
	}
	return nil
}

// fetchHost is the host a URL parser connects to: width-folded, without the
// characters IDNA mapping deletes, lowercased, without brackets, an IPv6
// zone or trailing dots. url.Parse has already percent-decoded it.
func fetchHost(host string) string {
	host = strings.Map(func(r rune) rune {
		switch r {
		case 0x00AD, 0x200B, 0x2060, 0xFEFF:
			return -1
		}
		return r
	}, host)
	host = normalizeHost(host)
	if i := strings.IndexByte(host, '%'); i >= 0 && strings.Contains(host, ":") {
		host = host[:i]
	}
	return strings.TrimRight(host, ".")
}

// numericIPv4 is the IPv4 address a host spelled as numbers names, as a URL
// parser reads it. 2130706433, 0x7f.1, 0177.0.0.1 and 127.1 all reach
// 127.0.0.1 in a browser or Node (and the TypeScript SDK refuses them), but
// netip only knows the dotted-decimal spelling. Each part is decimal, 0x hex
// or 0-prefixed octal; the last one fills the remaining bytes.
func numericIPv4(host string) (netip.Addr, bool) {
	parts := strings.Split(host, ".")
	if len(parts) > 4 {
		return netip.Addr{}, false
	}
	nums := make([]uint64, len(parts))
	for i, part := range parts {
		digits, base := part, 10
		switch {
		case len(part) >= 2 && (part[:2] == "0x" || part[:2] == "0X"):
			digits, base = part[2:], 16
		case len(part) > 1 && part[0] == '0':
			digits, base = part[1:], 8
		}
		if part == "" || strings.ContainsAny(digits, "+-_") {
			return netip.Addr{}, false
		}
		if digits == "" {
			continue // "0x" alone is zero.
		}
		n, err := strconv.ParseUint(digits, base, 32)
		if err != nil {
			return netip.Addr{}, false
		}
		nums[i] = n
	}
	last := len(nums) - 1
	for _, n := range nums[:last] {
		if n > 255 {
			return netip.Addr{}, false
		}
	}
	if nums[last] >= 1<<(8*(4-last)) {
		return netip.Addr{}, false
	}
	v := nums[last]
	for i, n := range nums[:last] {
		v += n << (8 * (3 - i))
	}
	return netip.AddrFrom4([4]byte{byte(v >> 24), byte(v >> 16), byte(v >> 8), byte(v)}), true
}

// foldWidth maps fullwidth ASCII and ideographic full stops to ASCII, as URL
// parsers do: "１２７。０。０。１" is 127.0.0.1 to a browser, Node and the
// TypeScript SDK.
func foldWidth(host string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 0xFF01 && r <= 0xFF5E:
			return r - 0xFEE0
		case r == 0x3002 || r == 0xFF61:
			return '.'
		}
		return r
	}, host)
}

func normalizeHost(host string) string {
	host = strings.ToLower(strings.TrimSpace(foldWidth(host)))
	host = strings.TrimPrefix(host, "[")
	host = strings.TrimSuffix(host, "]")
	return strings.TrimRight(host, ".")
}

// blockedIPv4 are the IPv4 ranges fetch() refuses: this network, private,
// carrier-grade NAT (where some clouds keep their metadata service),
// loopback, link-local, IETF assignments, documentation, benchmarking,
// multicast and reserved. The list is explicit, and the same in every SDK,
// because each standard library draws "private" differently.
var blockedIPv4 = prefixes(
	"0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8",
	"169.254.0.0/16", "172.16.0.0/12", "192.0.0.0/24", "192.0.2.0/24",
	"192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24",
	"224.0.0.0/4", "240.0.0.0/4",
)

// An IPv6 address must be global unicast (2000::/3) and outside these:
// IETF assignments (Teredo among them), documentation, 6to4 (which embeds an
// IPv4 address) and documentation again.
var (
	globalIPv6  = netip.MustParsePrefix("2000::/3")
	blockedIPv6 = prefixes("2001::/23", "2001:db8::/32", "2002::/16", "3fff::/20")
)

func prefixes(cidrs ...string) []netip.Prefix {
	out := make([]netip.Prefix, len(cidrs))
	for i, cidr := range cidrs {
		out[i] = netip.MustParsePrefix(cidr)
	}
	return out
}

func isNonPublic(addr netip.Addr) bool {
	// Prefix.Contains never matches an address with a zone.
	addr = addr.WithZone("")
	// ::ffff:127.0.0.1 and ::ffff:7f00:1 reach the same machine as 127.0.0.1.
	if addr.Is4In6() {
		addr = addr.Unmap()
	}
	if addr.Is4() {
		return inAny(blockedIPv4, addr)
	}
	return !globalIPv6.Contains(addr) || inAny(blockedIPv6, addr)
}

func inAny(ranges []netip.Prefix, addr netip.Addr) bool {
	for _, p := range ranges {
		if p.Contains(addr) {
			return true
		}
	}
	return false
}

var statusLabels = map[int]string{
	401: "Keenable authentication failed (401)",
	403: "Keenable authentication failed (403)",
	402: "Keenable: insufficient credits (402)",
	429: "Keenable rate limit exceeded (429)",
}

// targetCodes are codes about the page being fetched rather than about
// Keenable or the caller, besides every target_* code. Servers before error
// format v1 send no "type", so it is derived from these and the status.
var targetCodes = map[string]bool{"page_not_found": true, "content_not_extracted": true}

// codeTypes are codes whose catalog type the status does not imply.
var codeTypes = map[string]string{
	"device_code_denied":     TypePermissionError,
	"slow_down":              TypeRateLimitError,
	"dns_lookup_failed":      TypeAPIError,
	"search_failed_upstream": TypeAPIError,
}

// deriveType is the error type for a response that did not send one. It
// matches the API's catalog for every code it had when "type" was added.
func deriveType(status int, code string) string {
	switch {
	case strings.HasPrefix(code, "target_") || targetCodes[code]:
		return TypeTargetError
	case codeTypes[code] != "":
		return codeTypes[code]
	case status == 401:
		return TypeAuthenticationError
	case status == 403:
		return TypePermissionError
	case status == 402 || status == 451:
		return TypeBillingError
	case status == 429:
		return TypeRateLimitError
	case status >= 400 && status < 500:
		return TypeInvalidRequestError
	default:
		return TypeAPIError
	}
}

// notYourLimitCodes are 429 codes for a limit that is not the caller's own
// (ours or the fetched site's), so a key would not lift it.
var notYourLimitCodes = map[string]bool{
	"target_rate_limited": true,
	"search_rate_limited": true,
	"fetch_rate_limited":  true,
}

func toAPIError(status int, raw []byte, header http.Header, keyless bool) error {
	detail := ""
	var obj map[string]any
	if body, ok := decodeJSON(raw); !ok {
		// Not JSON: the text is the best detail there is.
		detail = strings.TrimSpace(string(raw))
	} else if m, ok := body.(map[string]any); ok {
		obj = m
		detail = firstDetail(m, "message", "error", "detail")
	}
	// JSON that is not an object ("oops", null, 42) gives no detail, as in
	// Python and TypeScript; the error maps by status alone.
	api := parseErrorBody(obj, header)
	api.StatusCode = status
	api.Body = detail
	if api.Type == "" {
		api.Type = deriveType(status, api.APICode)
	}
	if status == 400 && stringField(obj, "error") == "invalid_filter" {
		if api.Param == "" {
			api.Param = stringField(obj, "field")
		}
		api.Value = stringField(obj, "value")
		api.Reason = stringField(obj, "reason")
	}

	// A 401/403 about the page being fetched is not an authentication failure.
	auth := (status == 401 || status == 403) && api.Type != TypeTargetError
	label, ok := statusLabels[status]
	if !ok || ((status == 401 || status == 403) && !auth) {
		label = fmt.Sprintf("Keenable API error (%d)", status)
	}
	if status == 402 {
		// The API's text for a 402 points at billing pages and payment
		// offers, which the SDKs do not pass on; the next step is the SDK's.
		api.msg = paymentMessage(obj, api.APICode)
		return classifyStatus(api, auth, header)
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
		msg = sentence(msg, api.Fix)
	case auth:
		msg += ". Check KEENABLE_API_KEY, or pass Options.APIKey."
	case status == 429 && notYourLimitCodes[api.APICode]:
		// Not the caller's own limit, so a key would not lift it.
		msg += ". Wait for the rate limit window to reset, then retry."
	case status == 429 && keyless:
		msg += ". Set KEENABLE_API_KEY to lift the keyless hourly cap. Create a key at https://keenable.ai/console."
	case status == 429:
		msg += ". Wait for the rate limit window to reset, then retry."
	case status >= 400 && status < 500 && status != 408 && (api.Retryable == nil || !*api.Retryable):
		// The SDK does not retry these, so the advice must not say to either.
		msg += ". Check the request: sending it again unchanged fails the same way."
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

// paymentMessage is a 402's message, the same in every SDK. A pay-per-request
// (x402) response is one this SDK cannot pay, so it says to use a key; its
// offer (accepts, payTo, networks) is not passed on.
func paymentMessage(body map[string]any, code string) string {
	_, accepts := body["accepts"]
	_, x402 := body["x402Version"]
	if strings.HasPrefix(code, "payment_") || accepts || x402 {
		return "Keenable: payment required (402). This SDK does not pay per request: set KEENABLE_API_KEY to call the API with a key instead."
	}
	return "Keenable: insufficient credits (402). The organization is out of credits; retrying fails the same way until a human with console access adds more."
}

// sentence appends more as a new sentence, without doubling a final period.
func sentence(msg, more string) string {
	if strings.HasSuffix(msg, ".") {
		return msg + " " + more
	}
	return msg + ". " + more
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
		APICode:   stringField(m, "code"),
		Type:      stringField(m, "type"),
		Title:     stringField(m, "error"),
		Fix:       stringField(m, "fix"),
		RequestID: stringField(m, "request_id"),
		Param:     stringField(m, "param"),
	}
	if api.RequestID == "" {
		api.RequestID = headerValue(header, "X-Request-Id")
	}
	if b, ok := m["retryable"].(bool); ok {
		api.Retryable = &b
	}
	if d, ok := secondsField(m, "retry_after_seconds"); ok {
		api.RetryAfter = d
		api.retryAfterSet = true
	} else if d, ok := retryAfterHeader(headerValue(header, "Retry-After")); ok {
		api.RetryAfter = d
		api.retryAfterSet = true
	} else if d, ok := secondsField(m, "retryAfter"); ok {
		api.RetryAfter = d
		api.retryAfterSet = true
	}
	if l, ok := m["limit"].(map[string]any); ok {
		info := &RateLimitInfo{
			Scope:    stringField(l, "scope"),
			Window:   stringField(l, "window"),
			ResetsAt: stringField(l, "resets_at"),
		}
		// An integer a double holds exactly, as in Python and TypeScript.
		if n, ok := l["max"].(float64); ok && n == math.Trunc(n) && n >= 0 && n <= maxSafeInteger {
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

// maxSafeInteger is 2^53 - 1, the largest integer every SDK reads exactly.
const maxSafeInteger = 1<<53 - 1

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
	return retryAfterAt(v, time.Now())
}

// retryAfterAt is retryAfterHeader as of now. The rules are the same in every
// SDK (scripts/conformance/README.md): delay-seconds, or one of the three RFC
// 9110 HTTP-date forms in GMT; anything else is no value, so the next source
// of the delay is used.
func retryAfterAt(v string, now time.Time) (time.Duration, bool) {
	v = strings.TrimSpace(v)
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
	when, ok := parseHTTPDate(v)
	if !ok {
		return 0, false
	}
	d := when.Sub(now)
	if d <= 0 {
		return 0, true
	}
	// Cap before rounding: a date centuries ahead saturates Sub at the
	// largest Duration, and adding to that would wrap negative.
	if d >= maxRetryAfter {
		return maxRetryAfter, true
	}
	// Round up, as the other SDKs do, so waiting this long is never too early.
	return (d + time.Second - 1).Truncate(time.Second), true
}

// The three HTTP-date forms of RFC 9110 section 5.6.7. http.ParseTime also
// takes any zone abbreviation in the RFC 850 form, and a one-digit hour.
var (
	imfFixdate  = regexp.MustCompile(`^([A-Za-z]{3}), ([0-9]{2}) ([A-Za-z]{3}) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$`)
	rfc850Date  = regexp.MustCompile(`^([A-Za-z]+), ([0-9]{2})-([A-Za-z]{3})-([0-9]{2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$`)
	asctimeDate = regexp.MustCompile(`^([A-Za-z]{3}) ([A-Za-z]{3}) ( [0-9]|[0-9]{1,2}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) ([0-9]{4})$`)

	shortDays = []string{"mon", "tue", "wed", "thu", "fri", "sat", "sun"}
	longDays  = []string{"monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"}
	months    = []string{"jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"}
)

// parseHTTPDate reads an IMF-fixdate, RFC 850 or asctime date. Day and month
// names may be in any case; the weekday is not checked against the date.
func parseHTTPDate(v string) (time.Time, bool) {
	var weekday, day, month, year, hour, minute, second string
	var days []string
	if m := imfFixdate.FindStringSubmatch(v); m != nil {
		weekday, day, month, year, hour, minute, second, days = m[1], m[2], m[3], m[4], m[5], m[6], m[7], shortDays
	} else if m := rfc850Date.FindStringSubmatch(v); m != nil {
		weekday, day, month, year, hour, minute, second, days = m[1], m[2], m[3], m[4], m[5], m[6], m[7], longDays
	} else if m := asctimeDate.FindStringSubmatch(v); m != nil {
		weekday, month, day, hour, minute, second, year, days = m[1], m[2], m[3], m[4], m[5], m[6], m[7], shortDays
	} else {
		return time.Time{}, false
	}
	if indexFold(days, weekday) < 0 {
		return time.Time{}, false
	}
	mon := indexFold(months, month)
	if mon < 0 {
		return time.Time{}, false
	}
	y, _ := strconv.Atoi(year)
	if len(year) == 2 {
		// RFC 850's two-digit year, read as Go's time package and Python's
		// email.utils read it: 69 to 99 are 19xx, 00 to 68 are 20xx.
		if y >= 69 {
			y += 1900
		} else {
			y += 2000
		}
	}
	d, _ := strconv.Atoi(strings.TrimSpace(day))
	h, _ := strconv.Atoi(hour)
	mi, _ := strconv.Atoi(minute)
	sec, _ := strconv.Atoi(second)
	lastDay := time.Date(y, time.Month(mon+2), 0, 0, 0, 0, 0, time.UTC).Day()
	if d < 1 || d > lastDay || h > 23 || mi > 59 || sec > 59 {
		return time.Time{}, false
	}
	return time.Date(y, time.Month(mon+1), d, h, mi, sec, 0, time.UTC), true
}

func indexFold(names []string, name string) int {
	for i, n := range names {
		if strings.EqualFold(n, name) {
			return i
		}
	}
	return -1
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

// firstDetail is the first of keys whose value is a string with more than
// whitespace. Other types are skipped, not formatted into the message.
func firstDetail(m map[string]any, keys ...string) string {
	for _, key := range keys {
		if s := stringField(m, key); s != "" {
			return s
		}
	}
	return ""
}

// decodeJSON decodes a body as json.Unmarshal into an any would, except
// that a leading UTF-8 byte order mark is skipped and a number too large for
// a float64 (such as a retry_after_seconds of 1e400) is left out instead of
// failing the whole body. The other SDKs read such a number as non-finite and
// drop it, so the response keeps its other fields. Going through json.Number
// keeps this the same on every Go version. ok is false when the body is not
// JSON.
func decodeJSON(raw []byte) (any, bool) {
	raw = bytes.TrimPrefix(raw, []byte("\ufeff"))
	if nestedTooDeeply(raw) || !json.Valid(raw) {
		return nil, false
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var body any
	if err := dec.Decode(&body); err != nil {
		return nil, false
	}
	// A bare overflowing number (the whole body is 1e400) is still JSON; it
	// is just not an object, so it carries nothing.
	body, _ = plainNumbers(body)
	return body, true
}

// maxJSONDepth is the nesting past which a body is "not JSON" in all three SDKs
// (scripts/conformance), below encoding/json's own limit of 10000.
const maxJSONDepth = 512

// nestedTooDeeply reports whether a JSON-looking body nests arrays or objects
// deeper than maxJSONDepth. Only a body that starts like JSON is walked, and
// the walk stops at the first level past the limit.
func nestedTooDeeply(raw []byte) bool {
	trimmed := bytes.TrimLeft(raw, " \t\r\n")
	if len(trimmed) == 0 || (trimmed[0] != '[' && trimmed[0] != '{') {
		return false
	}
	depth := 0
	inString, escaped := false, false
	for _, c := range trimmed {
		switch {
		case inString:
			switch {
			case escaped:
				escaped = false
			case c == '\\':
				escaped = true
			case c == '"':
				inString = false
			}
		case c == '"':
			inString = true
		case c == '[' || c == '{':
			depth++
			if depth > maxJSONDepth {
				return true
			}
		case c == ']' || c == '}':
			depth--
		}
	}
	return false
}

// plainNumbers turns each json.Number into a float64, as json.Unmarshal does,
// and reports false for one that does not fit, so its caller can drop it.
func plainNumbers(v any) (any, bool) {
	switch t := v.(type) {
	case json.Number:
		f, err := strconv.ParseFloat(string(t), 64)
		if err != nil {
			return nil, false
		}
		return f, true
	case map[string]any:
		for k, e := range t {
			if p, ok := plainNumbers(e); ok {
				t[k] = p
			} else {
				delete(t, k)
			}
		}
	case []any:
		for i, e := range t {
			// An array keeps its length; an overflowing element becomes nil.
			t[i], _ = plainNumbers(e)
		}
	}
	return v, true
}

func decodeObject(status int, raw []byte, header http.Header) (map[string]any, error) {
	snippet := raw
	if len(snippet) > 200 {
		snippet = snippet[:200]
	}
	id := headerValue(header, "X-Request-Id")
	data, ok := decodeJSON(raw)
	if !ok {
		return nil, &APIError{
			StatusCode: status,
			RequestID:  id,
			code:       CodeAPI,
			msg:        fmt.Sprintf("Keenable API returned a non-JSON response: %q. Retry the request. If it keeps failing, confirm KEENABLE_API_URL.", string(snippet)),
		}
	}
	obj, isObject := data.(map[string]any)
	if !isObject {
		return nil, &APIError{
			StatusCode: status,
			RequestID:  id,
			code:       CodeAPI,
			msg:        fmt.Sprintf("Unexpected response from the Keenable API: %q. Retry the request. If it keeps failing, confirm KEENABLE_API_URL.", string(snippet)),
		}
	}
	return obj, nil
}
