package keenable

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// MonitorsService is client.Monitors: Keenable Monitors, standing searches
// that report new pages as they appear. Monitors need an API key; without
// one every call returns an [AuthError] with APICode "missing_api_key" and
// sends nothing.
//
// Reads and deletes are retried like a search. Create sends an
// Idempotency-Key (yours, or a new one for each call), so retrying it cannot
// make a second monitor. Update, Trigger and Bulk are retried only on a 429,
// which the API sends before it does anything.
type MonitorsService struct {
	client *Client
}

// MonitorSearchParams is what a monitor watches for. Query is required on
// create; on update only the fields set are sent and merged.
type MonitorSearchParams struct {
	// Query is the topic in plain words, e.g. "new open-weights LLM releases".
	Query string
	// MaxResults is the pages a run returns at most, 1 to 100. Zero is unset
	// (the API's default is 10).
	MaxResults int
	// IncludeDomains keeps only pages on these sites. Nil is unset.
	IncludeDomains []string
	// ExcludeDomains drops pages on these sites. Nil is unset.
	ExcludeDomains []string
	// ContentText returns each page's text (first 6,000 characters). Nil is
	// unset.
	ContentText *bool
}

func (s *MonitorSearchParams) body() map[string]any {
	out := map[string]any{}
	if s.Query != "" {
		out["query"] = s.Query
	}
	if s.MaxResults != 0 {
		out["max_results"] = s.MaxResults
	}
	if s.IncludeDomains != nil {
		out["include_domains"] = s.IncludeDomains
	}
	if s.ExcludeDomains != nil {
		out["exclude_domains"] = s.ExcludeDomains
	}
	if s.ContentText != nil {
		out["content"] = map[string]any{"text": *s.ContentText}
	}
	return out
}

// MonitorScheduleParams is when runs happen.
type MonitorScheduleParams struct {
	// Type is "cron", "interval" or "once".
	Type string `json:"type"`
	// Value is, for cron, five fields (at most hourly); for interval, 1h to
	// 90d ("6h", "2w"); for once, a timestamp or a delay ("2h"), empty for
	// now.
	Value string `json:"value,omitempty"`
	// Timezone is an IANA name, for cron; UTC when empty.
	Timezone string `json:"timezone,omitempty"`
}

// MonitorWebhookParams is where a monitor's events go.
type MonitorWebhookParams struct {
	// URL is a public HTTPS address.
	URL string `json:"url,omitempty"`
	// Events defaults to the monitor.* and monitor.run.* events. Add
	// "monitor.hit" to get each new page as soon as it is found.
	Events []string `json:"events,omitempty"`
}

// MonitorCreateParams are the arguments to [MonitorsService.Create].
type MonitorCreateParams struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	// Search is required, with a Query.
	Search MonitorSearchParams
	// Name is up to 200 characters. Empty is unset.
	Name string
	// Schedule is when runs happen. Nil means only Trigger starts a run.
	Schedule *MonitorScheduleParams
	// OutputSchema is the JSON Schema of each run's output.structured.
	OutputSchema map[string]any
	// Webhook is where events go.
	Webhook *MonitorWebhookParams
	// Metadata is your own tags (at most 50), echoed in every webhook.
	Metadata map[string]string
	// IdempotencyKey makes a retry safe: the same key with the same body
	// returns the monitor the first call created, for 24 hours. Empty means a
	// new key for this call.
	IdempotencyKey string
}

// MonitorUpdateParams are the arguments to [MonitorsService.Update]. Only
// what is set is sent. Search and Webhook are merged into the stored ones.
type MonitorUpdateParams struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	// Name renames the monitor.
	Name *string
	// RemoveName removes the name (sends null). It wins over Name.
	RemoveName bool
	// Status is "active" or "paused"; active also re-enables a disabled
	// monitor. Empty is unset.
	Status string
	// Search is merged into the stored search.
	Search *MonitorSearchParams
	// Schedule replaces the schedule.
	Schedule *MonitorScheduleParams
	// RemoveSchedule removes the schedule (sends null).
	RemoveSchedule bool
	// OutputSchema replaces the output schema.
	OutputSchema map[string]any
	// RemoveOutputSchema removes the output schema (sends null).
	RemoveOutputSchema bool
	// Webhook is merged into the stored webhook.
	Webhook *MonitorWebhookParams
	// RemoveWebhook removes the webhook (sends null).
	RemoveWebhook bool
	// Metadata replaces the metadata.
	Metadata map[string]string
	// RemoveMetadata removes the metadata (sends null).
	RemoveMetadata bool
}

// MonitorListParams are the arguments to [MonitorsService.List]. Zero values
// are unset.
type MonitorListParams struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	// Status keeps monitors in this status: active, paused, disabled or
	// completed.
	Status string
	// Name keeps monitors whose name contains it.
	Name string
	// Metadata keeps monitors with these metadata values.
	Metadata map[string]string
	// Limit is monitors per page (the API's default is 50).
	Limit int
	// Cursor is the previous page's NextCursor.
	Cursor string
}

// MonitorPageParams page through runs or deliveries. Zero values are unset.
type MonitorPageParams struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	Limit  int
	Cursor string
}

// MonitorPagesParams page through a monitor's pages. Zero values are unset.
type MonitorPagesParams struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	Limit  int
	Cursor string
	// MinImportance keeps pages rated at least this important (1 to 5).
	MinImportance int
}

// BulkFilter picks the monitors [MonitorsService.Bulk] acts on.
type BulkFilter struct {
	Status   string            `json:"status,omitempty"`
	Name     string            `json:"name,omitempty"`
	Metadata map[string]string `json:"metadata,omitempty"`
}

// MonitorBulkParams are the arguments to [MonitorsService.Bulk]: IDs or a
// Filter.
type MonitorBulkParams struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	IDs    []string
	Filter *BulkFilter
	// Limit is at most this many monitors (default 50, up to 500). Zero is
	// unset.
	Limit int
	// DryRun only reports what would change. Nil means true: pass a pointer
	// to false to act.
	DryRun *bool
}

// MonitorSearch is what a monitor watches for.
type MonitorSearch struct {
	Query          string   `json:"query"`
	MaxResults     int      `json:"max_results"`
	IncludeDomains []string `json:"include_domains"`
	ExcludeDomains []string `json:"exclude_domains"`
	// ContentText says whether each page's text is returned.
	ContentText bool `json:"-"`
}

// UnmarshalJSON reads content.text into ContentText.
func (s *MonitorSearch) UnmarshalJSON(raw []byte) error {
	type plain MonitorSearch
	var wire struct {
		plain
		Content *struct {
			Text bool `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &wire); err != nil {
		return err
	}
	*s = MonitorSearch(wire.plain)
	s.ContentText = wire.Content != nil && wire.Content.Text
	return nil
}

// MonitorSchedule is when a monitor's runs happen.
type MonitorSchedule struct {
	Type     string  `json:"type"`
	Value    *string `json:"value"`
	Timezone *string `json:"timezone"`
}

// MonitorWebhook is where a monitor's events go.
type MonitorWebhook struct {
	URL    string   `json:"url"`
	Events []string `json:"events"`
	// Secret is the signing secret (whsec_...), only in the response to
	// Create. Keep it for [VerifyWebhook].
	Secret *string `json:"secret,omitempty"`
}

// Monitor is a monitor as the API returns it.
type Monitor struct {
	ID     string  `json:"id"`
	Object string  `json:"object"`
	Name   *string `json:"name"`
	// Status is active, paused, disabled or completed.
	Status       string            `json:"status"`
	Search       MonitorSearch     `json:"search"`
	Schedule     *MonitorSchedule  `json:"schedule"`
	OutputSchema map[string]any    `json:"output_schema"`
	Webhook      *MonitorWebhook   `json:"webhook"`
	Metadata     map[string]string `json:"metadata"`
	LastRunAt    *string           `json:"last_run_at"`
	NextRunAt    *string           `json:"next_run_at"`
	// UpcomingRuns are the next three run times, UTC.
	UpcomingRuns []string `json:"upcoming_runs"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
	// AgentRunID, Backfill and MemoryScope are not available yet: always nil.
	AgentRunID  any `json:"agent_run_id"`
	Backfill    any `json:"backfill"`
	MemoryScope any `json:"memory_scope"`
	// EstimatedCostUSD and CostThisMonthUSD are nil until monitors are priced.
	EstimatedCostUSD *float64 `json:"estimated_cost_usd"`
	CostThisMonthUSD *float64 `json:"cost_this_month_usd"`
	// RequestID is the X-Request-Id of the response.
	RequestID string `json:"-"`
	// Raw is the unmodified JSON object.
	Raw map[string]any `json:"-"`
}

// MonitorResultChange is how a page that came back changed since the version
// the monitor sent.
type MonitorResultChange struct {
	PreviousAt    *string `json:"previous_at"`
	PreviousTitle *string `json:"previous_title"`
	PreviousSent  *bool   `json:"previous_sent"`
	// Ratio is the share of the new text that was not in the old one, 0 to 1.
	Ratio   *float64 `json:"ratio"`
	Added   []string `json:"added"`
	Removed []string `json:"removed"`
}

// MonitorResult is a page a monitor found: in a run, a webhook event or
// [MonitorsService.Pages].
type MonitorResult struct {
	URL         string  `json:"url"`
	Title       *string `json:"title"`
	Author      *string `json:"author"`
	PublishedAt *string `json:"published_at"`
	AcquiredAt  *string `json:"acquired_at"`
	Image       *string `json:"image"`
	// Favicon and Highlights are always nil for now.
	Favicon    *string `json:"favicon"`
	Highlights any     `json:"highlights"`
	// MatchedAt is when the monitor accepted the page.
	MatchedAt *string `json:"matched_at"`
	// PublishedAtSource is declared, url, x or text: where the date comes from.
	PublishedAtSource *string `json:"published_at_source"`
	// Summary is one line on what the page reports.
	Summary *string `json:"summary"`
	// Importance is 1 to 5 for the monitor's topic; pages under 3 are not sent.
	Importance *int    `json:"importance"`
	Kind       *string `json:"kind"`
	// SourceType is original or rewrite.
	SourceType *string `json:"source_type"`
	// Score is uncalibrated relevance, only for ordering one monitor's pages.
	Score *float64 `json:"score"`
	// Text is the page's text, when the monitor's search asks for it.
	Text *string `json:"text,omitempty"`
	// Change is set on monitor.update: how the page changed.
	Change *MonitorResultChange `json:"change,omitempty"`
	// ID is set by Pages: identifies the match, and is the cursor of the
	// page of results it ends.
	ID *string `json:"id,omitempty"`
	// SameStory is set by Pages: how many more pages reported the same story
	// and were left out.
	SameStory *int `json:"same_story,omitempty"`
}

// MonitorRunError is why a run failed.
type MonitorRunError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// MonitorRunOutput is a run's digest, when the monitor has an output schema.
type MonitorRunOutput struct {
	Structured any     `json:"structured"`
	Text       *string `json:"text"`
	Grounding  []any   `json:"grounding"`
}

// MonitorRun is one run of a monitor.
type MonitorRun struct {
	ID        string `json:"id"`
	Object    string `json:"object"`
	MonitorID string `json:"monitor_id"`
	// Status is queued, running, completed, failed or cancelled.
	Status string `json:"status"`
	// Results are the new pages; empty when none; nil until the run completes.
	Results []MonitorResult   `json:"results"`
	Changes any               `json:"changes"`
	Output  *MonitorRunOutput `json:"output"`
	Error   *MonitorRunError  `json:"error"`
	// Usage is nil until monitors are priced.
	Usage     any            `json:"usage"`
	CreatedAt *string        `json:"created_at"`
	StartedAt *string        `json:"started_at"`
	EndedAt   *string        `json:"ended_at"`
	RequestID string         `json:"-"`
	Raw       map[string]any `json:"-"`
}

// MonitorDelivery is one webhook event and its delivery attempts.
type MonitorDelivery struct {
	ID            string  `json:"id"`
	Type          string  `json:"type"`
	URL           string  `json:"url"`
	CreatedAt     string  `json:"created_at"`
	Attempts      int     `json:"attempts"`
	DeliveredAt   *string `json:"delivered_at"`
	LastError     *string `json:"last_error"`
	NextAttemptAt *string `json:"next_attempt_at"`
}

// MonitorStats counts monitors by status and by kind of schedule (cron,
// interval, once, manual).
type MonitorStats struct {
	Total      int            `json:"total"`
	ByStatus   map[string]int `json:"by_status"`
	BySchedule map[string]int `json:"by_schedule"`
	RequestID  string         `json:"-"`
	Raw        map[string]any `json:"-"`
}

// BulkResult is what Bulk changed, or would change on a dry run.
type BulkResult struct {
	Action   string   `json:"action"`
	Affected int      `json:"affected"`
	IDs      []string `json:"ids"`
	DryRun   bool     `json:"dry_run"`
	// HasMore says more monitors matched than Limit.
	HasMore bool `json:"has_more"`
	// NotFound are the ids sent that are not monitors of this key.
	NotFound  []string       `json:"not_found"`
	RequestID string         `json:"-"`
	Raw       map[string]any `json:"-"`
}

// List is one page of a list; NextCursor fetches the next.
type List[T any] struct {
	Data       []T            `json:"data"`
	HasMore    bool           `json:"has_more"`
	NextCursor string         `json:"next_cursor"`
	RequestID  string         `json:"-"`
	Raw        map[string]any `json:"-"`
}

// MonitorList is a page of monitors.
type MonitorList = List[Monitor]

// RunList is a page of runs.
type RunList = List[MonitorRun]

// PageList is a page of a monitor's pages.
type PageList = List[MonitorResult]

// DeliveryList is a page of webhook deliveries.
type DeliveryList = List[MonitorDelivery]

type monitorCall struct {
	method  string
	path    string
	query   url.Values
	body    any
	headers map[string]string
	safe    bool
	opts    *RequestOptions
}

func (m *MonitorsService) call(ctx context.Context, call monitorCall, out any) (map[string]any, string, error) {
	if m == nil || m.client == nil {
		return nil, "", &InvalidRequestError{msg: "nil client: call keenable.New and use client.Monitors"}
	}
	c := m.client
	if err := requireClient(c); err != nil {
		return nil, "", err
	}
	if err := requireContext(ctx); err != nil {
		return nil, "", err
	}
	if c.apiKey == "" {
		retryable := false
		return nil, "", &AuthError{APIError: &APIError{
			StatusCode: 401,
			APICode:    "missing_api_key",
			Type:       TypeAuthenticationError,
			Retryable:  &retryable,
			code:       CodeAuth,
			msg:        "Keenable authentication failed (401): Monitors need an API key. Set Options.APIKey or KEENABLE_API_KEY; create one at https://keenable.ai/console.",
		}}
	}
	u, err := url.Parse(c.baseURL)
	if err != nil || u.Host == "" {
		return nil, "", &InvalidRequestError{msg: fmt.Sprintf("baseURL %q is not a valid URL. Pass an https URL with a host.", c.baseURL)}
	}
	u.RawPath = strings.TrimRight(u.EscapedPath(), "/") + "/v1/" + call.path
	u.Path, _ = url.PathUnescape(u.RawPath)
	u.RawQuery = call.query.Encode()
	u.Fragment = ""
	var body []byte
	if call.body != nil {
		body, err = json.Marshal(call.body)
		if err != nil {
			return nil, "", &InvalidRequestError{msg: "could not encode the request: " + err.Error() + ". Pass JSON-encodable arguments."}
		}
	}
	data, id, err := c.send(ctx, call.method, u.String(), body, call.opts, call.headers, call.safe)
	if err != nil {
		return nil, "", err
	}
	raw, _ := json.Marshal(data)
	if err := json.Unmarshal(raw, out); err != nil {
		return nil, "", &APIError{StatusCode: 200, RequestID: id, code: CodeAPI, msg: "Unexpected response from the Keenable API: " + err.Error() + ". Retry the request. If it keeps failing, confirm KEENABLE_API_URL."}
	}
	return data, requestID(data, id), nil
}

func segment(name, value string) (string, error) {
	if strings.TrimSpace(value) == "" {
		return "", &InvalidRequestError{msg: name + " must be a non-empty string"}
	}
	if value == "." || value == ".." {
		return "", &InvalidRequestError{msg: fmt.Sprintf("%s must not be %q: it would change the request's path", name, value)}
	}
	return url.PathEscape(value), nil
}

func pageQuery(limit int, cursor string) url.Values {
	q := url.Values{}
	if limit != 0 {
		q.Set("limit", strconv.Itoa(limit))
	}
	if cursor != "" {
		q.Set("cursor", cursor)
	}
	return q
}

func newIdempotencyKey() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (m *MonitorsService) monitor(ctx context.Context, call monitorCall) (*Monitor, error) {
	var out Monitor
	data, id, err := m.call(ctx, call, &out)
	if err != nil {
		return nil, err
	}
	out.RequestID, out.Raw = id, data
	return &out, nil
}

func (m *MonitorsService) run(ctx context.Context, call monitorCall) (*MonitorRun, error) {
	var out MonitorRun
	data, id, err := m.call(ctx, call, &out)
	if err != nil {
		return nil, err
	}
	out.RequestID, out.Raw = id, data
	return &out, nil
}

func listCall[T any](ctx context.Context, m *MonitorsService, call monitorCall) (*List[T], error) {
	var out List[T]
	data, id, err := m.call(ctx, call, &out)
	if err != nil {
		return nil, err
	}
	out.RequestID, out.Raw = id, data
	return &out, nil
}

func monitorPath(id string, rest ...string) (string, error) {
	seg, err := segment("monitor id", id)
	if err != nil {
		return "", err
	}
	return strings.Join(append([]string{"monitors", seg}, rest...), "/"), nil
}

// Create makes a monitor. It takes a few seconds: the monitor is calibrated
// against the last week of the web. Webhook.Secret is set in this response
// only.
func (m *MonitorsService) Create(ctx context.Context, params *MonitorCreateParams) (*Monitor, error) {
	if params == nil || strings.TrimSpace(params.Search.Query) == "" {
		return nil, &InvalidRequestError{msg: "Create needs Search.Query, the topic in plain words"}
	}
	body := map[string]any{"search": params.Search.body()}
	if params.Name != "" {
		body["name"] = params.Name
	}
	if params.Schedule != nil {
		body["schedule"] = params.Schedule
	}
	if params.OutputSchema != nil {
		body["output_schema"] = params.OutputSchema
	}
	if params.Webhook != nil {
		body["webhook"] = params.Webhook
	}
	if params.Metadata != nil {
		body["metadata"] = params.Metadata
	}
	key := params.IdempotencyKey
	if key == "" {
		key = newIdempotencyKey()
	}
	return m.monitor(ctx, monitorCall{
		method: http.MethodPost, path: "monitors", body: body,
		headers: map[string]string{"Idempotency-Key": key}, safe: true, opts: &params.RequestOptions,
	})
}

// List returns one page of monitors, newest first. params may be nil.
func (m *MonitorsService) List(ctx context.Context, params *MonitorListParams) (*MonitorList, error) {
	if params == nil {
		params = &MonitorListParams{}
	}
	q := pageQuery(params.Limit, params.Cursor)
	if params.Status != "" {
		q.Set("status", params.Status)
	}
	if params.Name != "" {
		q.Set("name", params.Name)
	}
	for k, v := range params.Metadata {
		q.Set("metadata["+k+"]", v)
	}
	return listCall[Monitor](ctx, m, monitorCall{method: http.MethodGet, path: "monitors", query: q, safe: true, opts: &params.RequestOptions})
}

// MonitorIterator walks every monitor, fetching pages as needed.
//
//	it := client.Monitors.ListAll(ctx, nil)
//	for it.Next() {
//		fmt.Println(it.Monitor().ID)
//	}
//	if err := it.Err(); err != nil { ... }
type MonitorIterator struct {
	ctx     context.Context
	service *MonitorsService
	params  MonitorListParams
	page    []Monitor
	index   int
	current *Monitor
	done    bool
	err     error
}

// ListAll returns an iterator over every monitor, newest first. params may be
// nil; its Cursor is where to start.
func (m *MonitorsService) ListAll(ctx context.Context, params *MonitorListParams) *MonitorIterator {
	it := &MonitorIterator{ctx: ctx, service: m}
	if params != nil {
		it.params = *params
	}
	return it
}

// Next advances to the next monitor and reports whether there is one.
func (it *MonitorIterator) Next() bool {
	for it.index >= len(it.page) {
		if it.done || it.err != nil {
			return false
		}
		list, err := it.service.List(it.ctx, &it.params)
		if err != nil {
			it.err = err
			return false
		}
		it.page, it.index = list.Data, 0
		if !list.HasMore || list.NextCursor == "" {
			it.done = true
		}
		it.params.Cursor = list.NextCursor
	}
	it.current = &it.page[it.index]
	it.index++
	return true
}

// Monitor is the monitor Next moved to.
func (it *MonitorIterator) Monitor() *Monitor { return it.current }

// Err is the error that stopped the iteration, if any.
func (it *MonitorIterator) Err() error { return it.err }

// Get returns one monitor. opts may be nil.
func (m *MonitorsService) Get(ctx context.Context, monitorID string, opts *RequestOptions) (*Monitor, error) {
	path, err := monitorPath(monitorID)
	if err != nil {
		return nil, err
	}
	return m.monitor(ctx, monitorCall{method: http.MethodGet, path: path, safe: true, opts: opts})
}

// Update changes a monitor; only what params sets is sent. Not retried on a
// 5xx.
func (m *MonitorsService) Update(ctx context.Context, monitorID string, params *MonitorUpdateParams) (*Monitor, error) {
	path, err := monitorPath(monitorID)
	if err != nil {
		return nil, err
	}
	if params == nil {
		params = &MonitorUpdateParams{}
	}
	body := map[string]any{}
	switch {
	case params.RemoveName:
		body["name"] = nil
	case params.Name != nil:
		body["name"] = *params.Name
	}
	if params.Status != "" {
		body["status"] = params.Status
	}
	if params.Search != nil {
		body["search"] = params.Search.body()
	}
	switch {
	case params.RemoveSchedule:
		body["schedule"] = nil
	case params.Schedule != nil:
		body["schedule"] = params.Schedule
	}
	switch {
	case params.RemoveOutputSchema:
		body["output_schema"] = nil
	case params.OutputSchema != nil:
		body["output_schema"] = params.OutputSchema
	}
	switch {
	case params.RemoveWebhook:
		body["webhook"] = nil
	case params.Webhook != nil:
		body["webhook"] = params.Webhook
	}
	switch {
	case params.RemoveMetadata:
		body["metadata"] = nil
	case params.Metadata != nil:
		body["metadata"] = params.Metadata
	}
	return m.monitor(ctx, monitorCall{method: http.MethodPatch, path: path, body: body, safe: false, opts: &params.RequestOptions})
}

func requestOrEmpty(opts *RequestOptions) RequestOptions {
	if opts == nil {
		return RequestOptions{}
	}
	return *opts
}

// Pause pauses a monitor: Update with Status "paused".
func (m *MonitorsService) Pause(ctx context.Context, monitorID string, opts *RequestOptions) (*Monitor, error) {
	return m.Update(ctx, monitorID, &MonitorUpdateParams{RequestOptions: requestOrEmpty(opts), Status: "paused"})
}

// Resume resumes a paused or disabled monitor: Update with Status "active".
func (m *MonitorsService) Resume(ctx context.Context, monitorID string, opts *RequestOptions) (*Monitor, error) {
	return m.Update(ctx, monitorID, &MonitorUpdateParams{RequestOptions: requestOrEmpty(opts), Status: "active"})
}

// Delete deletes a monitor and the pages it found, for good, and returns it
// as it was.
func (m *MonitorsService) Delete(ctx context.Context, monitorID string, opts *RequestOptions) (*Monitor, error) {
	path, err := monitorPath(monitorID)
	if err != nil {
		return nil, err
	}
	return m.monitor(ctx, monitorCall{method: http.MethodDelete, path: path, safe: true, opts: opts})
}

// Trigger starts a run now and returns it queued. Not retried on a 5xx.
func (m *MonitorsService) Trigger(ctx context.Context, monitorID string, opts *RequestOptions) (*MonitorRun, error) {
	path, err := monitorPath(monitorID, "trigger")
	if err != nil {
		return nil, err
	}
	return m.run(ctx, monitorCall{method: http.MethodPost, path: path, safe: false, opts: opts})
}

// Runs returns one page of a monitor's runs, newest first. params may be nil.
func (m *MonitorsService) Runs(ctx context.Context, monitorID string, params *MonitorPageParams) (*RunList, error) {
	path, err := monitorPath(monitorID, "runs")
	if err != nil {
		return nil, err
	}
	if params == nil {
		params = &MonitorPageParams{}
	}
	return listCall[MonitorRun](ctx, m, monitorCall{method: http.MethodGet, path: path, query: pageQuery(params.Limit, params.Cursor), safe: true, opts: &params.RequestOptions})
}

// Run returns one run.
func (m *MonitorsService) Run(ctx context.Context, monitorID, runID string, opts *RequestOptions) (*MonitorRun, error) {
	run, err := segment("run id", runID)
	if err != nil {
		return nil, err
	}
	path, err := monitorPath(monitorID, "runs", run)
	if err != nil {
		return nil, err
	}
	return m.run(ctx, monitorCall{method: http.MethodGet, path: path, safe: true, opts: opts})
}

// Pages returns the pages a monitor accepted, newest first, one per story.
// Poll and stop at the first ID already seen. params may be nil.
func (m *MonitorsService) Pages(ctx context.Context, monitorID string, params *MonitorPagesParams) (*PageList, error) {
	path, err := monitorPath(monitorID, "hits")
	if err != nil {
		return nil, err
	}
	if params == nil {
		params = &MonitorPagesParams{}
	}
	q := pageQuery(params.Limit, params.Cursor)
	if params.MinImportance != 0 {
		q.Set("min_importance", strconv.Itoa(params.MinImportance))
	}
	return listCall[MonitorResult](ctx, m, monitorCall{method: http.MethodGet, path: path, query: q, safe: true, opts: &params.RequestOptions})
}

// Deliveries returns the monitor's webhook events of the last 7 days, with
// attempts and the last error. params may be nil.
func (m *MonitorsService) Deliveries(ctx context.Context, monitorID string, params *MonitorPageParams) (*DeliveryList, error) {
	path, err := monitorPath(monitorID, "deliveries")
	if err != nil {
		return nil, err
	}
	if params == nil {
		params = &MonitorPageParams{}
	}
	return listCall[MonitorDelivery](ctx, m, monitorCall{method: http.MethodGet, path: path, query: pageQuery(params.Limit, params.Cursor), safe: true, opts: &params.RequestOptions})
}

// Stats counts monitors by status and by kind of schedule.
func (m *MonitorsService) Stats(ctx context.Context, opts *RequestOptions) (*MonitorStats, error) {
	var out MonitorStats
	data, id, err := m.call(ctx, monitorCall{method: http.MethodGet, path: "monitors/stats", safe: true, opts: opts}, &out)
	if err != nil {
		return nil, err
	}
	out.RequestID, out.Raw = id, data
	return &out, nil
}

// Bulk pauses, resumes or deletes many monitors, by IDs or by Filter. action
// is "pause", "resume" or "delete". It is a dry run unless DryRun points to
// false. Not retried on a 5xx.
func (m *MonitorsService) Bulk(ctx context.Context, action string, params *MonitorBulkParams) (*BulkResult, error) {
	if action != "pause" && action != "resume" && action != "delete" {
		return nil, &InvalidRequestError{msg: fmt.Sprintf("action must be pause, resume or delete, got %q", action)}
	}
	if params == nil {
		params = &MonitorBulkParams{}
	}
	hasFilter := params.Filter != nil && (params.Filter.Status != "" || params.Filter.Name != "" || len(params.Filter.Metadata) > 0)
	if len(params.IDs) == 0 && !hasFilter {
		return nil, &InvalidRequestError{msg: "Bulk needs IDs or a Filter"}
	}
	dryRun := true
	if params.DryRun != nil {
		dryRun = *params.DryRun
	}
	body := map[string]any{"action": action, "dry_run": dryRun}
	if len(params.IDs) > 0 {
		body["ids"] = params.IDs
	}
	if hasFilter {
		body["filter"] = params.Filter
	}
	if params.Limit != 0 {
		body["limit"] = params.Limit
	}
	var out BulkResult
	data, id, err := m.call(ctx, monitorCall{method: http.MethodPost, path: "monitors/bulk", body: body, safe: false, opts: &params.RequestOptions}, &out)
	if err != nil {
		return nil, err
	}
	out.RequestID, out.Raw = id, data
	return &out, nil
}
