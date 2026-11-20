package keenable

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
)

const (
	fetchMaxURLs     = 10
	fetchMaxLinks    = 1000
	fetchMaxImages   = 25
	fetchMaxAgeHours = 720
)

// Ptr returns a pointer to v, for the options where zero is a value:
// FetchOptions.Images (0 asks for no images) and FetchOptions.MaxAgeHours (0
// asks for a live read).
func Ptr[T any](v T) *T { return &v }

// FetchOptions are the optional arguments to [Client.Fetch]. Each applies to
// every page, and an unset option is not sent.
type FetchOptions struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	// MaxChars is the most characters of content per page. Zero means unset,
	// and the API applies its default of 50000. Page.Truncated and
	// Page.TotalChars say whether a page was cut.
	MaxChars int
	// Schema is a JSON Schema whose root has "type": "object". Each page's
	// typed answer is in Page.Structured, or Page.AnswerError says why it
	// could not be made. Nil means unset.
	Schema map[string]any
	// Links is the most links per page to return, 1 to 1000. Zero means unset.
	Links int
	// Images is the most images per page to return, 0 to 25. Nil means unset.
	Images *int
	// MaxAgeHours uses a stored copy only if it is younger than this, 0 to
	// 720 hours (fractions allowed); Ptr(0.0) reads every page live. Nil uses
	// a stored copy of any age when there is one.
	MaxAgeHours *float64
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

// FetchAnswerError says why the typed answer for FetchOptions.Schema could not
// be made. The page is still read.
type FetchAnswerError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// FetchUsage is what reading one page cost.
type FetchUsage struct {
	SKU     string  `json:"sku"`
	Amount  int     `json:"amount"`
	Credits float64 `json:"credits"`
	// Paid is true when paid credits were spent, false for free ones.
	Paid             bool     `json:"paid"`
	CreditsRemaining *float64 `json:"credits_remaining,omitempty"`
}

// FetchResult is the result for one URL: Page when it was read, else Error.
type FetchResult struct {
	URL  string
	Page *Page
	// Error is why this URL failed: the error Fetch would return for that
	// status (an *APIError, *AuthError, *RateLimitError or
	// *InsufficientCreditsError). Fetch does not return it.
	Error error
}

// FetchResponse is what [Client.Fetch] returns: Results[i] is for urls[i].
type FetchResponse struct {
	Results []FetchResult
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem. Empty when the API sent none.
	RequestID string
}

// Fetch reads up to 10 pages as markdown in one call.
//
// Results[i] is for urls[i]: its Page, or its Error when that URL failed. A
// failed URL is not returned as an error; Fetch returns an error only when
// the call fails as a whole. Internal hosts and private addresses are refused
// here, before a request is sent. opts may be nil.
func (c *Client) Fetch(ctx context.Context, urls []string, opts *FetchOptions) (*FetchResponse, error) {
	if err := requireClient(c); err != nil {
		return nil, err
	}
	if err := requireContext(ctx); err != nil {
		return nil, err
	}
	payload, err := fetchPayload(urls, opts)
	if err != nil {
		return nil, err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, &InvalidRequestError{msg: "could not encode the fetch request: " + err.Error() + ". Pass a JSON-encodable Schema."}
	}
	var req *RequestOptions
	if opts != nil {
		req = &opts.RequestOptions
	}
	data, id, err := c.do(ctx, "fetch", body, req)
	if err != nil {
		return nil, err
	}
	return &FetchResponse{
		Results:   c.fetchResults(data["results"], urls),
		RequestID: requestID(data, id),
	}, nil
}

// fetchPayload is the JSON body POST /v1/fetch takes, after checking the URLs
// and holding every option to the API's limits.
func fetchPayload(urls []string, o *FetchOptions) (map[string]any, error) {
	if len(urls) < 1 || len(urls) > fetchMaxURLs {
		return nil, &InvalidRequestError{msg: fmt.Sprintf("Fetch needs 1 to %d URLs, got %d", fetchMaxURLs, len(urls))}
	}
	for _, u := range urls {
		if err := rejectPrivateFetchTarget(u); err != nil {
			return nil, err
		}
	}
	payload := map[string]any{"urls": urls}
	if o == nil {
		return payload, nil
	}
	content := map[string]any{}
	if o.MaxChars != 0 {
		if o.MaxChars < 1 {
			return nil, &InvalidRequestError{msg: fmt.Sprintf("FetchOptions.MaxChars must be at least 1, got %d", o.MaxChars)}
		}
		content["max_chars"] = o.MaxChars
	}
	if o.Schema != nil {
		if o.Schema["type"] != "object" {
			return nil, &InvalidRequestError{msg: `FetchOptions.Schema must be a JSON Schema whose root has "type": "object"`}
		}
		content["schema"] = o.Schema
	}
	if o.Links != 0 {
		if o.Links < 1 || o.Links > fetchMaxLinks {
			return nil, &InvalidRequestError{msg: fmt.Sprintf("FetchOptions.Links must be from 1 to %d, got %d", fetchMaxLinks, o.Links)}
		}
		content["links"] = o.Links
	}
	if o.Images != nil {
		if *o.Images < 0 || *o.Images > fetchMaxImages {
			return nil, &InvalidRequestError{msg: fmt.Sprintf("FetchOptions.Images must be from 0 to %d, got %d", fetchMaxImages, *o.Images)}
		}
		content["images"] = *o.Images
	}
	if len(content) > 0 {
		payload["content"] = content
	}
	if h := o.MaxAgeHours; h != nil {
		if math.IsNaN(*h) || *h < 0 || *h > fetchMaxAgeHours {
			return nil, &InvalidRequestError{msg: fmt.Sprintf("FetchOptions.MaxAgeHours must be from 0 to %d, got %v", fetchMaxAgeHours, *h)}
		}
		payload["retrieval"] = map[string]any{"max_age_hours": *h}
	}
	return payload, nil
}

// fetchResults reads the reply's results: a failed URL's error object becomes
// the error that status would return, any other object a page.
func (c *Client) fetchResults(v any, urls []string) []FetchResult {
	list, _ := v.([]any)
	results := make([]FetchResult, 0, len(list))
	for i, item := range list {
		entry, ok := item.(map[string]any)
		if !ok {
			continue
		}
		asked := ""
		if i < len(urls) {
			asked = urls[i]
		}
		if failure, ok := entry["error"].(map[string]any); ok {
			status := 500
			if n := count(failure["status"]); n != nil && *n >= 400 && *n <= 599 {
				status = *n
			}
			raw, _ := json.Marshal(failure)
			url := asked
			if s := nonEmptyString(entry["url"]); s != nil {
				url = *s
			}
			results = append(results, FetchResult{URL: url, Error: toAPIError(status, raw, nil, c.Keyless())})
			continue
		}
		page := pageFromJSON(entry, asked)
		results = append(results, FetchResult{URL: page.URL, Page: page})
	}
	return results
}

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

func finiteOrNil(v any) *float64 {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return nil
	}
	return &f
}

func fetchLinks(v any) []FetchLink {
	if _, ok := v.([]any); !ok {
		return nil
	}
	out := []FetchLink{}
	for _, item := range objects(v) {
		out = append(out, FetchLink{URL: asString(item["url"]), Text: nonEmptyString(item["text"])})
	}
	return out
}

func fetchImages(v any) []FetchImage {
	if _, ok := v.([]any); !ok {
		return nil
	}
	out := []FetchImage{}
	for _, item := range objects(v) {
		out = append(out, FetchImage{URL: asString(item["url"]), Alt: nonEmptyString(item["alt"])})
	}
	return out
}

func fetchAnswerError(v any) *FetchAnswerError {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return &FetchAnswerError{Code: asString(m["code"]), Message: asString(m["message"])}
}

func fetchUsage(v any) *FetchUsage {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	u := &FetchUsage{SKU: asString(m["sku"]), Paid: m["paid"] == true, CreditsRemaining: finiteOrNil(m["credits_remaining"])}
	if n := count(m["amount"]); n != nil {
		u.Amount = *n
	}
	if f := finiteOrNil(m["credits"]); f != nil {
		u.Credits = *f
	}
	return u
}
