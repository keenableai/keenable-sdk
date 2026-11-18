package keenable

import (
	"context"
	"encoding/json"
	"net/http"
)

// Ptr returns a pointer to v, for the options where zero is a value, such as
// FetchContentOptions.MaxChars (0 asks for metadata only) and
// FetchRetrievalOptions.MaxAgeHours (0 asks for a live read).
func Ptr[T any](v T) *T { return &v }

// FetchContentOptions is what each [Client.FetchMany] result carries. Unset fields
// are not sent.
type FetchContentOptions struct {
	// MaxChars is the most characters of text per page; nil is the API's
	// default of 50000, and Ptr(0) leaves the text out (metadata only).
	MaxChars *int
	// Objective is what you are after on the pages, up to 1,000 characters.
	// Each page's text becomes the passages about it; with Schema it also
	// steers the record. Needs an API key. Empty means unset.
	Objective string
	// Schema is a JSON Schema (type "object"): each result's Content.Answer
	// is a record matching it. Needs an API key.
	Schema map[string]any
	// Links is the most links per page to return, with their text (1 to
	// 1000). Zero means unset.
	Links int
	// Images is the most images per page to return, with their alt text (1
	// to 1000). Zero means unset.
	Images int
}

// FetchRetrievalOptions says where [Client.FetchMany] page content comes from. Give
// one of the two.
type FetchRetrievalOptions struct {
	// MaxAgeHours uses a stored copy only if it is younger than this many
	// hours, from 0 to 720 (fractions allowed: 0.25 is 15 minutes). Ptr(0.0)
	// always reads live. Nil uses a stored copy of any age when there is one.
	MaxAgeHours *float64
	// AsOf reads stored data as it stood at this instant, never live: an RFC
	// 3339 date or date-time, or a duration back from now. "P0D" is the
	// latest stored copy. Empty means unset.
	AsOf string
}

// FetchOutputOptions asks [Client.FetchMany] for one answer across all the pages.
// An empty FetchOutputOptions asks for a prose answer. Needs an API key.
type FetchOutputOptions struct {
	// Prompt is the question to answer across the pages, up to 2,000
	// characters. Empty means unset.
	Prompt string
	// Schema is a JSON Schema (type "object") for a typed answer in
	// FetchResponse.Output.Structured.
	Schema map[string]any
}

// FetchManyOptions are the options for [Client.FetchMany]. Each group is sent
// when it is not nil.
type FetchManyOptions struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	// Content is what each result carries. Nil: each page's text up to 50,000
	// characters.
	Content *FetchContentOptions
	// Retrieval is where content comes from. Nil: a stored copy of any age
	// when there is one, else a live read.
	Retrieval *FetchRetrievalOptions
	// Output asks for one answer across the pages, in FetchResponse.Output.
	Output *FetchOutputOptions
	// DeadlineMS is for the whole call, 1000 to 55000 (30000 without a key);
	// zero is the API's default of 15000. Pages not read by then fail with
	// fetch_timeout.
	DeadlineMS int
	// SessionID is your id for the agent session these calls belong to.
	SessionID string
}

// FetchLink is a link on a fetched page, with the words it was written as.
type FetchLink struct {
	URL  string  `json:"url"`
	Text *string `json:"text,omitempty"`
}

// FetchImage is an image on a fetched page, with its alt text.
type FetchImage struct {
	URL string  `json:"url"`
	Alt *string `json:"alt,omitempty"`
}

// FetchContent is what one page carries: only the parts asked for. A
// part asked for but unavailable is nil, with a content_unavailable notice.
type FetchContent struct {
	// Text is the page as markdown, cut to MaxChars; with Objective, the
	// passages about it.
	Text *string `json:"text,omitempty"`
	// TotalChars is the length of the whole page, so you can tell whether
	// Text was cut.
	TotalChars *int `json:"total_chars,omitempty"`
	// Answer is the record for FetchContentOptions.Schema, a map matching it.
	Answer map[string]any `json:"answer,omitempty"`
	Links  []FetchLink    `json:"links,omitempty"`
	Images []FetchImage   `json:"images,omitempty"`
}

// FetchError says why one URL failed. The call itself succeeded; the URL is
// not billed.
type FetchError struct {
	// Type is the broad case, "target_error" for a URL that failed.
	Type string `json:"type"`
	// Code is the exact case, such as "page_not_found" or "fetch_timeout".
	Code    string `json:"code"`
	Message string `json:"message"`
	// Fix is one sentence on what to do next, when the API has one.
	Fix *string `json:"fix,omitempty"`
	// Retryable is whether trying this URL again unchanged can help.
	Retryable bool `json:"retryable"`
	// UpstreamStatus is what the site answered, such as 404, when it
	// answered.
	UpstreamStatus *int           `json:"upstream_status,omitempty"`
	Details        map[string]any `json:"-"`
}

// FetchResult is the result for one URL given to [Client.FetchMany]:
// Results[i] answers urls[i]. Status is "ok" with the page, or "error" with
// Error set and no page.
type FetchResult struct {
	Index int `json:"index"`
	// RequestedURL is the URL exactly as sent.
	RequestedURL string `json:"requested_url"`
	// URL is the final address after redirects (the last one reached, on an
	// error).
	URL         string  `json:"url"`
	Status      string  `json:"status"`
	Title       *string `json:"title,omitempty"`
	PublishedAt *string `json:"published_at,omitempty"`
	// AcquiredAt is when Keenable read this copy of the page.
	AcquiredAt *string `json:"acquired_at,omitempty"`
	Image      *string `json:"image,omitempty"`
	Favicon    *string `json:"favicon,omitempty"`
	// RetrievedFrom is "index" (our stored copy), "live" or
	// "cache_fallback".
	RetrievedFrom *string        `json:"retrieved_from,omitempty"`
	Error         *FetchError    `json:"error,omitempty"`
	Content       FetchContent   `json:"content"`
	Raw           map[string]any `json:"-"`
}

// FetchNotice is a notice (for the model) or a warning (for the developer).
type FetchNotice struct {
	Code string `json:"code"`
	// Path is a JSON Pointer into the response (notices) or the request
	// (warnings).
	Path    *string        `json:"path,omitempty"`
	Message string         `json:"message"`
	Details map[string]any `json:"-"`
}

// Citation says where an answer field comes from: excerpts of
// Results[Index].
type Citation struct {
	Index    int      `json:"index"`
	Excerpts []string `json:"excerpts"`
	// Verified is true when every excerpt appears word for word in the page
	// text the API read. Checked by the server, not the model.
	Verified bool `json:"verified"`
}

// Grounding is the support for one field of the answer.
type Grounding struct {
	// Field is a JSON Pointer into Structured, or "/text".
	Field      string     `json:"field"`
	Citations  []Citation `json:"citations"`
	Reasoning  *string    `json:"reasoning,omitempty"`
	Confidence *string    `json:"confidence,omitempty"`
}

// FetchOutput is one answer across all the pages.
type FetchOutput struct {
	// Text is the answer in prose; with a schema, a short summary of it.
	Text string `json:"text"`
	// Structured matches FetchOutputOptions.Schema; nil without one.
	Structured map[string]any `json:"structured,omitempty"`
	// BasedOn is the indexes of the results the answer used.
	BasedOn   []int       `json:"based_on"`
	Grounding []Grounding `json:"grounding"`
}

// FetchSummary counts the URLs asked for, read and failed.
type FetchSummary struct {
	Requested int `json:"requested"`
	Succeeded int `json:"succeeded"`
	Failed    int `json:"failed"`
}

// FetchResponse is what [Client.FetchMany] returns: one result per URL, in
// the order given.
type FetchResponse struct {
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem.
	RequestID string `json:"request_id,omitempty"`
	// Status is "ok" (every URL read), "partial" or "failed".
	Status  *string      `json:"status,omitempty"`
	Summary FetchSummary `json:"summary"`
	// Resolved is each relative or date-only instant in the request, as the
	// exact time used, keyed by its JSON Pointer.
	Resolved map[string]string `json:"resolved"`
	Results  []FetchResult     `json:"results"`
	Output   *FetchOutput      `json:"output,omitempty"`
	// Notices are for the model: how the results were produced.
	Notices []FetchNotice `json:"notices"`
	// Warnings are for the developer: request hygiene; they never change
	// results.
	Warnings  []FetchNotice `json:"warnings"`
	SessionID *string       `json:"session_id,omitempty"`
	LatencyMS *int          `json:"latency_ms,omitempty"`
	// Usage is what the call cost, as the API sent it.
	Usage map[string]any `json:"-"`
	Raw   map[string]any `json:"-"`
}

// FetchMany reads up to 20 pages in one call with POST /v1/fetch.
//
// Pages are read in parallel. Results[i] answers urls[i]: its Status is "ok"
// with the page, or "error" with Error set. A failed URL is not billed and
// is not returned as an error; FetchMany returns an error only when the call
// fails as a whole. Internal hosts and private addresses are refused here,
// before a request is sent. Keyless calls take up to 20 URLs. opts may be
// nil.
func (c *Client) FetchMany(ctx context.Context, urls []string, opts *FetchManyOptions) (*FetchResponse, error) {
	if err := requireClient(c); err != nil {
		return nil, err
	}
	if err := requireContext(ctx); err != nil {
		return nil, err
	}
	if len(urls) == 0 {
		return nil, &InvalidRequestError{msg: "FetchMany() needs a non-empty list of URLs"}
	}
	for _, u := range urls {
		if err := rejectPrivateFetchTarget(u); err != nil {
			return nil, err
		}
	}
	body, err := json.Marshal(fetchManyPayload(urls, opts))
	if err != nil {
		return nil, &InvalidRequestError{msg: "could not encode the fetch request: " + err.Error() + ". Pass JSON-encodable arguments."}
	}
	var req *RequestOptions
	if opts != nil {
		req = &opts.RequestOptions
	}
	data, id, err := c.do(ctx, http.MethodPost, "fetch", body, nil, req)
	if err != nil {
		return nil, err
	}
	resp := fetchResponseFromJSON(data)
	resp.RequestID = requestID(data, id)
	return resp, nil
}

// fetchManyPayload is the JSON body POST /v1/fetch takes: each group that is
// not nil, holding the fields set. Zero is sent where it is a value
// (MaxChars, MaxAgeHours).
func fetchManyPayload(urls []string, o *FetchManyOptions) map[string]any {
	payload := map[string]any{"urls": urls}
	if o == nil {
		return payload
	}
	if c := o.Content; c != nil {
		content := map[string]any{}
		if c.MaxChars != nil {
			content["max_chars"] = *c.MaxChars
		}
		if c.Objective != "" {
			content["objective"] = c.Objective
		}
		if c.Schema != nil {
			content["schema"] = c.Schema
		}
		if c.Links != 0 {
			content["links"] = c.Links
		}
		if c.Images != 0 {
			content["images"] = c.Images
		}
		payload["content"] = content
	}
	if r := o.Retrieval; r != nil {
		retrieval := map[string]any{}
		if r.MaxAgeHours != nil {
			retrieval["max_age_hours"] = *r.MaxAgeHours
		}
		if r.AsOf != "" {
			retrieval["as_of"] = r.AsOf
		}
		payload["retrieval"] = retrieval
	}
	if out := o.Output; out != nil {
		output := map[string]any{}
		if out.Prompt != "" {
			output["prompt"] = out.Prompt
		}
		if out.Schema != nil {
			output["schema"] = out.Schema
		}
		payload["output"] = output
	}
	if o.DeadlineMS != 0 {
		payload["deadline_ms"] = o.DeadlineMS
	}
	if o.SessionID != "" {
		payload["session_id"] = o.SessionID
	}
	return payload
}

// objects is the objects in a JSON list; empty for anything that is not a list.
func objects(v any) []map[string]any {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// stringOrNil is a string as sent (even empty), or nil for anything else.
func stringOrNil(v any) *string {
	if s, ok := v.(string); ok {
		return &s
	}
	return nil
}

// objectOrNil is a JSON object, or nil for anything else.
func objectOrNil(v any) map[string]any {
	m, _ := v.(map[string]any)
	return m
}

func intOrZero(v any) int {
	if n := count(v); n != nil {
		return *n
	}
	return 0
}

func fetchErrorFromJSON(v any) *FetchError {
	item, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	details := objectOrNil(item["details"])
	e := &FetchError{
		Type:      asString(item["type"]),
		Code:      asString(item["code"]),
		Message:   asString(item["message"]),
		Fix:       stringOrNil(item["fix"]),
		Retryable: item["retryable"] == true,
		Details:   details,
	}
	if f, ok := details["upstream_status"].(float64); ok && f == float64(int(f)) {
		n := int(f)
		e.UpstreamStatus = &n
	}
	return e
}

func fetchResultFromJSON(data map[string]any, position int) FetchResult {
	r := FetchResult{
		Index:         position,
		RequestedURL:  asString(data["requested_url"]),
		URL:           asString(data["url"]),
		Status:        asString(data["status"]),
		Title:         nonEmptyString(data["title"]),
		PublishedAt:   nonEmptyString(data["published_at"]),
		AcquiredAt:    nonEmptyString(data["acquired_at"]),
		Image:         nonEmptyString(data["image"]),
		Favicon:       nonEmptyString(data["favicon"]),
		RetrievedFrom: nonEmptyString(data["retrieved_from"]),
		Error:         fetchErrorFromJSON(data["error"]),
		Raw:           data,
	}
	if n := count(data["index"]); n != nil {
		r.Index = *n
	}
	content := objectOrNil(data["content"])
	r.Content = FetchContent{
		Text:       stringOrNil(content["text"]),
		TotalChars: count(content["total_chars"]),
		Answer:     objectOrNil(content["answer"]),
	}
	if _, ok := content["links"].([]any); ok {
		r.Content.Links = []FetchLink{}
		for _, item := range objects(content["links"]) {
			r.Content.Links = append(r.Content.Links, FetchLink{URL: asString(item["url"]), Text: nonEmptyString(item["text"])})
		}
	}
	if _, ok := content["images"].([]any); ok {
		r.Content.Images = []FetchImage{}
		for _, item := range objects(content["images"]) {
			r.Content.Images = append(r.Content.Images, FetchImage{URL: asString(item["url"]), Alt: nonEmptyString(item["alt"])})
		}
	}
	return r
}

func fetchNoticesFromJSON(v any) []FetchNotice {
	out := []FetchNotice{}
	for _, item := range objects(v) {
		out = append(out, FetchNotice{
			Code:    asString(item["code"]),
			Path:    stringOrNil(item["path"]),
			Message: asString(item["message"]),
			Details: objectOrNil(item["details"]),
		})
	}
	return out
}

func fetchOutputFromJSON(v any) *FetchOutput {
	data, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	a := &FetchOutput{
		Text:       asString(data["text"]),
		Structured: objectOrNil(data["structured"]),
		BasedOn:    []int{},
		Grounding:  []Grounding{},
	}
	if list, ok := data["based_on"].([]any); ok {
		for _, item := range list {
			if n := count(item); n != nil {
				a.BasedOn = append(a.BasedOn, *n)
			}
		}
	}
	for _, item := range objects(data["grounding"]) {
		g := Grounding{
			Field:      asString(item["field"]),
			Citations:  []Citation{},
			Reasoning:  stringOrNil(item["reasoning"]),
			Confidence: stringOrNil(item["confidence"]),
		}
		for _, cite := range objects(item["citations"]) {
			c := Citation{Index: intOrZero(cite["index"]), Excerpts: []string{}, Verified: cite["verified"] == true}
			if list, ok := cite["excerpts"].([]any); ok {
				for _, e := range list {
					if s, ok := e.(string); ok {
						c.Excerpts = append(c.Excerpts, s)
					}
				}
			}
			g.Citations = append(g.Citations, c)
		}
		a.Grounding = append(a.Grounding, g)
	}
	return a
}

func fetchResponseFromJSON(data map[string]any) *FetchResponse {
	summary := objectOrNil(data["summary"])
	resp := &FetchResponse{
		Status: stringOrNil(data["status"]),
		Summary: FetchSummary{
			Requested: intOrZero(summary["requested"]),
			Succeeded: intOrZero(summary["succeeded"]),
			Failed:    intOrZero(summary["failed"]),
		},
		Resolved:  map[string]string{},
		Results:   []FetchResult{},
		Output:    fetchOutputFromJSON(data["output"]),
		Notices:   fetchNoticesFromJSON(data["notices"]),
		Warnings:  fetchNoticesFromJSON(data["warnings"]),
		SessionID: nonEmptyString(data["session_id"]),
		LatencyMS: count(data["latency_ms"]),
		Usage:     objectOrNil(data["usage"]),
		Raw:       data,
	}
	for key, value := range objectOrNil(data["resolved"]) {
		if s, ok := value.(string); ok {
			resp.Resolved[key] = s
		}
	}
	for position, item := range objects(data["results"]) {
		resp.Results = append(resp.Results, fetchResultFromJSON(item, position))
	}
	return resp
}
