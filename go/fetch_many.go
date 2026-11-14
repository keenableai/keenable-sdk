package keenable

import (
	"context"
	"encoding/json"
	"net/http"
)

// FetchManyOptions are the options for [Client.FetchMany]. Zero values are
// unset.
type FetchManyOptions struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	// NoText leaves the page text out, for a call that only wants a summary,
	// highlights, links or images. Text is returned by default.
	NoText bool
	// MaxChars is the characters of text per page.
	MaxChars int
	// Offset is where in the page text to start, to read a long page in parts
	// (see FetchResult.NextOffset).
	Offset int
	// Summary is an instruction; each result's Summary is the model's answer
	// for its page. Needs an API key.
	Summary string
	// OutputSchema is a JSON Schema (type "object"); the summary is then an
	// object in that shape.
	OutputSchema map[string]any
	// Highlights returns the passages most relevant to HighlightsQuery.
	Highlights bool
	// HighlightsQuery is what the highlights should be about.
	HighlightsQuery string
	// HighlightsMaxChars is the characters of highlights per page.
	HighlightsMaxChars int
	// Links is how many links per page to return, with their text.
	Links int
	// Images is how many images per page to return, with their alt text.
	Images int
	// MaxAge is the oldest copy accepted, such as "1d"; "0s" always reads the
	// page live.
	MaxAge string
	// PageTimeout is how long to wait for each live read, such as "15s".
	PageTimeout string
	// SessionID is your id for the agent session these calls belong to.
	SessionID string
	// EndUserID is your opaque id for the person the agent serves (no
	// personal data).
	EndUserID string
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

// FetchResult is the entry for one URL given to [Client.FetchMany]:
// Results[i] is for urls[i]. Only what was asked for is filled; unknown
// metadata is nil. Error is set when something asked for is missing; when the
// page could not be read, it is the only field besides URL.
type FetchResult struct {
	URL   string  `json:"url"`
	Title *string `json:"title,omitempty"`
	// PublishedAt is when the page says it was written, as ISO 8601. An
	// estimate.
	PublishedAt *string `json:"published_at,omitempty"`
	Image       *string `json:"image,omitempty"`
	Favicon     *string `json:"favicon,omitempty"`
	// Text is the page as markdown, from Offset up to MaxChars.
	Text *string `json:"text,omitempty"`
	// NextOffset is set only when the page has more text: call again with
	// Offset set to it. Nil when the text reaches the end.
	NextOffset *int `json:"next_offset,omitempty"`
	// Summary is the model's answer: a string, or a map matching
	// OutputSchema. Nil when none was asked for.
	Summary    any          `json:"summary,omitempty"`
	Highlights []string     `json:"highlights"`
	Links      []FetchLink  `json:"links"`
	Images     []FetchImage `json:"images"`
	// Error says why something asked for is missing; nil when everything
	// worked.
	Error *FetchError    `json:"error,omitempty"`
	Raw   map[string]any `json:"-"`
}

// FetchError says why something asked for is missing for one URL. The call
// itself succeeded.
type FetchError struct {
	// Code says why, such as "page_not_found" or "target_timeout".
	Code    string `json:"code"`
	Message string `json:"message"`
	// Retryable is whether trying this URL again can help.
	Retryable bool `json:"retryable"`
	// HTTPStatus is what the site answered, such as 404, when it answered.
	HTTPStatus *int `json:"http_status,omitempty"`
}

// FetchWarning is something that did not fail the call, such as a duplicate
// URL.
type FetchWarning struct {
	Code    string `json:"code"`
	Path    string `json:"path"`
	Message string `json:"message"`
}

// FetchResponse is what [Client.FetchMany] returns: one entry per URL, in
// the order given.
type FetchResponse struct {
	Results  []FetchResult  `json:"results"`
	Warnings []FetchWarning `json:"warnings"`
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem.
	RequestID string         `json:"request_id,omitempty"`
	LatencyMS *int           `json:"latency_ms,omitempty"`
	SessionID *string        `json:"session_id,omitempty"`
	Raw       map[string]any `json:"-"`
}

// FetchMany reads up to 100 pages in one call with POST /v1/fetch.
//
// Pages are read in parallel. Results[i] is the entry for urls[i]. A page
// that fails has its Error set instead of returning an error, and is not
// billed; FetchMany returns an
// error only when the call fails as a whole. Internal hosts and private
// addresses are refused here, before a request is sent. Keyless calls take up
// to 20 URLs. opts may be nil.
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

// fetchManyPayload is the JSON body POST /v1/fetch takes.
func fetchManyPayload(urls []string, o *FetchManyOptions) map[string]any {
	if o == nil {
		o = &FetchManyOptions{}
	}
	content := map[string]any{}
	if !o.NoText {
		limits := map[string]any{}
		if o.MaxChars != 0 {
			limits["max_chars"] = o.MaxChars
		}
		if o.Offset != 0 {
			limits["offset"] = o.Offset
		}
		if len(limits) > 0 {
			content["text"] = limits
		} else {
			content["text"] = true
		}
	}
	summary := map[string]any{}
	if o.Summary != "" {
		summary["instructions"] = o.Summary
	}
	if o.OutputSchema != nil {
		summary["output_schema"] = o.OutputSchema
	}
	if len(summary) > 0 {
		content["summary"] = summary
	}
	detail := map[string]any{}
	if o.HighlightsQuery != "" {
		detail["query"] = o.HighlightsQuery
	}
	if o.HighlightsMaxChars != 0 {
		detail["max_chars"] = o.HighlightsMaxChars
	}
	if len(detail) > 0 {
		content["highlights"] = detail
	} else if o.Highlights {
		content["highlights"] = true
	}
	if o.Links != 0 {
		content["links"] = o.Links
	}
	if o.Images != 0 {
		content["images"] = o.Images
	}
	payload := map[string]any{"urls": urls, "content": content}
	for key, value := range map[string]string{
		"max_age":     o.MaxAge,
		"timeout":     o.PageTimeout,
		"session_id":  o.SessionID,
		"end_user_id": o.EndUserID,
	} {
		if value != "" {
			payload[key] = value
		}
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

func fetchResultFromJSON(data map[string]any) FetchResult {
	r := FetchResult{
		URL:         asString(data["url"]),
		Title:       nonEmptyString(data["title"]),
		PublishedAt: nonEmptyString(data["published_at"]),
		Image:       nonEmptyString(data["image"]),
		Favicon:     nonEmptyString(data["favicon"]),
		Text:        nonEmptyString(data["text"]),
		NextOffset:  count(data["next_offset"]),
		Highlights:  []string{},
		Links:       []FetchLink{},
		Images:      []FetchImage{},
		Raw:         data,
	}
	if m, ok := data["summary"].(map[string]any); ok {
		r.Summary = m
	} else if s := nonEmptyString(data["summary"]); s != nil {
		r.Summary = *s
	}
	if list, ok := data["highlights"].([]any); ok {
		for _, item := range list {
			if s, ok := item.(string); ok {
				r.Highlights = append(r.Highlights, s)
			}
		}
	}
	for _, item := range objects(data["links"]) {
		r.Links = append(r.Links, FetchLink{URL: asString(item["url"]), Text: nonEmptyString(item["text"])})
	}
	for _, item := range objects(data["images"]) {
		r.Images = append(r.Images, FetchImage{URL: asString(item["url"]), Alt: nonEmptyString(item["alt"])})
	}
	if item, ok := data["error"].(map[string]any); ok {
		e := &FetchError{
			Code:      asString(item["code"]),
			Message:   asString(item["message"]),
			Retryable: item["retryable"] == true,
		}
		if f, ok := item["http_status"].(float64); ok && f == float64(int(f)) {
			n := int(f)
			e.HTTPStatus = &n
		}
		r.Error = e
	}
	return r
}

func fetchResponseFromJSON(data map[string]any) *FetchResponse {
	resp := &FetchResponse{
		Results:   []FetchResult{},
		Warnings:  []FetchWarning{},
		LatencyMS: count(data["latency_ms"]),
		SessionID: nonEmptyString(data["session_id"]),
		Raw:       data,
	}
	for _, item := range objects(data["results"]) {
		resp.Results = append(resp.Results, fetchResultFromJSON(item))
	}
	for _, item := range objects(data["warnings"]) {
		resp.Warnings = append(resp.Warnings, FetchWarning{
			Code:    asString(item["code"]),
			Path:    asString(item["path"]),
			Message: asString(item["message"]),
		})
	}
	return resp
}
