package keenable

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// SearchOptions are the optional arguments to [Client.Search].
//
// Empty strings are left unset and are not sent. SnippetMaxLength uses a
// pointer so zero can be sent; nil means unset. Mode defaults to "pro".
type SearchOptions struct {
	// RequestOptions holds this call's timeout, retry budget and headers.
	RequestOptions
	// Mode is the search mode: "pro" (the default) does deeper retrieval,
	// and "realtime" gives the fastest response, for latency-sensitive
	// agent loops. Empty means "pro".
	Mode string
	// Site restricts results to one domain, for example "arxiv.org".
	Site string
	// ExcludeDomains drops results from these hosts and their subdomains.
	// Nil is unset; a non-nil empty slice is sent as [].
	ExcludeDomains []string
	// PublishedAfter keeps pages published on or after YYYY-MM-DD.
	PublishedAfter string
	// PublishedBefore keeps pages published on or before YYYY-MM-DD.
	PublishedBefore string
	// AcquiredAfter keeps pages Keenable indexed on or after YYYY-MM-DD.
	AcquiredAfter string
	// AcquiredBefore keeps pages indexed on or before YYYY-MM-DD.
	AcquiredBefore string
	// SnippetMaxLength caps the characters of page text per result.
	// Nil means unset. A pointer to zero is sent.
	SnippetMaxLength *int
	// MaxResults is how many results to return, 1 to 50. Zero means unset,
	// and the API returns its default of 10.
	MaxResults int
	// QueryTime searches the index as it stood at this moment; pages newer
	// than it are excluded. It sets no lower bound, so it is not a recency
	// filter: use PublishedAfter for that. Accepts an ISO 8601 datetime,
	// YYYY-MM-DD, or an offset back from now such as "7d" (as of 7 days ago).
	QueryTime string

	// excludeDomainsJSON is a tool call's exclude_domains as the model sent
	// it, which []string cannot always hold; the API judges it.
	excludeDomainsJSON json.RawMessage
}

// ContextOptions controls [SearchResponse.ToContext] and [SearchResponse.Cited].
//
// [Page.ToContext] reads MaxChars only.
type ContextOptions struct {
	// MaxChars is the character budget for the whole block.
	// Zero means [DefaultContextMaxChars].
	MaxChars int
	// MaxResults keeps at most this many results before the budget is applied.
	// Nil means no cap. A pointer to zero renders nothing.
	MaxResults *int
	// IncludeDates appends the publication date to each header.
	// Nil means true.
	IncludeDates *bool
	// MaxSnippetChars caps each result's text at about this many characters
	// (plus the "…"), cut at a word boundary, so one whole-page snippet
	// cannot take the whole budget. Zero means [DefaultContextMaxSnippetChars];
	// a negative value means no cap.
	MaxSnippetChars int
}

// SearchResult is one page returned by [Client.Search].
type SearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
	// Description is deprecated: the API always sends it empty, so it is
	// always nil. Read Snippet.
	Description *string `json:"description,omitempty"`
	// PublishedAt is the ISO-8601 publication time, when the page exposes one.
	// A date the API sends as Unix seconds is given as ISO 8601 UTC, such as
	// "2024-05-01T12:00:00Z".
	PublishedAt *string `json:"published_at,omitempty"`
	// AcquiredAt is when Keenable indexed the page, in the same form as
	// PublishedAt.
	AcquiredAt *string `json:"acquired_at,omitempty"`
	// Raw is the unmodified JSON object, so new API fields stay reachable.
	Raw map[string]any `json:"-"`
}

// SearchResponse is the result set for one [Client.Search] call.
//
// Range over Results. Cited reports the subset ToContext actually numbered,
// so a source list can match the model's [1], [2], [3] citations.
type SearchResponse struct {
	Query   string         `json:"query"`
	Mode    *string        `json:"mode,omitempty"`
	Results []SearchResult `json:"results"`
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem. Empty when the API sent none.
	RequestID string         `json:"request_id,omitempty"`
	Raw       map[string]any `json:"-"`
}

// Page is a URL fetched by [Client.Fetch], with main content as markdown.
type Page struct {
	URL         string  `json:"url"`
	Title       string  `json:"title"`
	Content     string  `json:"content"`
	Description *string `json:"description,omitempty"`
	Author      *string `json:"author,omitempty"`
	// PublishedAt is when the page was published, as ISO 8601. The API sends
	// Unix seconds for a fetch; they are given in UTC to the second, such as
	// "2024-05-01T12:00:00Z", the form search results use. Nil when unknown.
	PublishedAt *string `json:"published_at,omitempty"`
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem. Empty when the API sent none.
	RequestID string         `json:"request_id,omitempty"`
	Raw       map[string]any `json:"-"`
	// Truncated is true when the page was longer than the API's max_chars and
	// Content was cut (cut content ends with "..."). Nil when the API did not
	// say.
	Truncated *bool `json:"truncated,omitempty"`
	// TotalChars is the length of the full extracted content in Unicode code
	// points, before any cut. Nil when the API did not say.
	TotalChars *int `json:"total_chars,omitempty"`
}

// Cited returns the results ToContext would render, in citation order.
//
// Index 0 is the source the model cites as [1]. Listing Results instead would
// number sources the model never saw once the budget trimmed them.
func (r *SearchResponse) Cited(opts *ContextOptions) []SearchResult {
	if r == nil {
		return nil
	}
	maxChars := contextMaxChars(opts)
	includeDates := contextIncludeDates(opts)
	maxSnippet := contextMaxSnippetChars(opts)
	selected := r.Results
	if n, ok := contextMaxResults(opts); ok {
		if n < 0 {
			n = 0
		}
		if n > len(selected) {
			n = len(selected)
		}
		selected = selected[:n]
	}

	kept := make([]SearchResult, 0, len(selected))
	used := 0
	for i, result := range selected {
		header := sourceHeader(i+1, result.Title, result.URL, result.PublishedAt, includeDates)
		body := resultBody(result, maxSnippet)
		blockLen := utf8.RuneCountInString(header)
		if body != "" {
			blockLen += 1 + utf8.RuneCountInString(body)
		}
		cost := blockLen
		if len(kept) > 0 {
			cost += 2 // the blank line between sources
		}
		// The first result is kept even when it alone exceeds the budget.
		// Later results are dropped whole, so a citation number is never skipped.
		if len(kept) > 0 && used+cost > maxChars {
			break
		}
		kept = append(kept, result)
		used += cost
	}
	return kept
}

// ToContext renders the results as a numbered block for a prompt.
//
// Each result is a "[n] title (url)" header followed by its page text.
// Page text is cleaned first (image markup dropped, relative links resolved
// against the result URL, tables flattened), then each is cut to
// MaxSnippetChars at a word boundary and ends in "…". Results are then added
// whole until MaxChars is reached, and the budget counts the cleaned, capped
// text; Snippet itself is left untouched. The first result is always kept,
// even if it alone exceeds MaxChars.
func (r *SearchResponse) ToContext(opts *ContextOptions) string {
	if r == nil {
		return ""
	}
	includeDates := contextIncludeDates(opts)
	maxSnippet := contextMaxSnippetChars(opts)
	cited := r.Cited(opts)
	parts := make([]string, 0, len(cited))
	for i, result := range cited {
		parts = append(parts, contextBlock(
			sourceHeader(i+1, result.Title, result.URL, result.PublishedAt, includeDates),
			resultBody(result, maxSnippet),
		))
	}
	return strings.Join(parts, "\n\n")
}

// ToContext renders the page as a citable block, same shape as a search result.
//
// Only MaxChars is read. A page is one document, so an oversized page is cut
// at the budget instead of dropped. The publication date is included when
// the page has one. Content has image markup dropped and relative links
// resolved before the cut; Content itself is left untouched.
func (p *Page) ToContext(opts *ContextOptions) string {
	if p == nil {
		return ""
	}
	maxChars := contextMaxChars(opts)
	header := sourceHeader(1, p.Title, p.URL, p.PublishedAt, true)
	budget := maxChars - utf8.RuneCountInString(header) - 1
	if budget <= 0 {
		return header
	}
	content := cleanContextText(p.Content, p.URL)
	body := strings.TrimRightFunc(cutRunes(content, budget), unicode.IsSpace)
	return contextBlock(header, body)
}

func contextMaxChars(opts *ContextOptions) int {
	if opts == nil || opts.MaxChars <= 0 {
		return DefaultContextMaxChars
	}
	return opts.MaxChars
}

// contextMaxSnippetChars returns the per-result cap; below 1 means none.
func contextMaxSnippetChars(opts *ContextOptions) int {
	if opts == nil || opts.MaxSnippetChars == 0 {
		return DefaultContextMaxSnippetChars
	}
	return opts.MaxSnippetChars
}

func contextIncludeDates(opts *ContextOptions) bool {
	if opts == nil || opts.IncludeDates == nil {
		return true
	}
	return *opts.IncludeDates
}

func contextMaxResults(opts *ContextOptions) (int, bool) {
	if opts == nil || opts.MaxResults == nil {
		return 0, false
	}
	return *opts.MaxResults, true
}

func sourceHeader(index int, title, pageURL string, published *string, includeDates bool) string {
	header := "[" + strconv.Itoa(index) + "] " + title + " (" + pageURL + ")"
	if includeDates && published != nil {
		header += " - published " + *published
	}
	return header
}

func contextBlock(header, body string) string {
	if body == "" {
		return header
	}
	return header + "\n" + body
}

func resultBody(r SearchResult, maxSnippet int) string {
	text := r.Snippet
	if text == "" && r.Description != nil {
		text = *r.Description
	}
	return capSnippet(collapse(cleanContextText(text, r.URL)), maxSnippet)
}

// capSnippet cuts text to limit characters at the last space at or before
// limit (a hard cut when there is none), trims it and appends "…". Text at or
// under the limit, or a limit below 1, leaves text as is. text is collapsed,
// so a plain space is the only whitespace in it.
func capSnippet(text string, limit int) string {
	if limit < 1 || utf8.RuneCountInString(text) <= limit {
		return text
	}
	runes := []rune(text)
	cut := limit
	for j := limit; j > 0; j-- {
		if runes[j] == ' ' {
			cut = j
			break
		}
	}
	return strings.TrimRightFunc(string(runes[:cut]), unicode.IsSpace) + "…"
}

func collapse(text string) string {
	return strings.Join(strings.Fields(text), " ")
}

func cutRunes(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if utf8.RuneCountInString(s) <= n {
		return s
	}
	runes := []rune(s)
	return string(runes[:n])
}

func searchResponseFromJSON(data map[string]any, query string) *SearchResponse {
	q := query
	if s := nonEmptyString(data["query"]); s != nil {
		q = *s
	}
	results := make([]SearchResult, 0)
	if raw, ok := data["results"].([]any); ok {
		for _, item := range raw {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			results = append(results, searchResultFromJSON(obj))
		}
	}
	return &SearchResponse{
		Query:   q,
		Mode:    nonEmptyString(data["mode"]),
		Results: results,
		Raw:     data,
	}
}

func searchResultFromJSON(data map[string]any) SearchResult {
	return SearchResult{
		Title:       asString(data["title"]),
		URL:         asString(data["url"]),
		Snippet:     asString(data["snippet"]),
		Description: nonEmptyString(data["description"]),
		PublishedAt: timestamp(data["published_at"]),
		AcquiredAt:  timestamp(data["acquired_at"]),
		Raw:         data,
	}
}

func pageFromJSON(data map[string]any, fallbackURL string) *Page {
	pageURL := fallbackURL
	// A blank or non-string url falls back to the one asked for.
	if s := nonEmptyString(data["url"]); s != nil {
		pageURL = *s
	}
	return &Page{
		URL:         pageURL,
		Title:       asString(data["title"]),
		Content:     asString(data["content"]),
		Description: nonEmptyString(data["description"]),
		Author:      nonEmptyString(data["author"]),
		PublishedAt: timestamp(data["published_at"]),
		Raw:         data,
		Truncated:   optionalBool(data["truncated"]),
		TotalChars:  count(data["total_chars"]),
	}
}

// maxUnixSeconds is the last Unix second with a four-digit year,
// 9999-12-31T23:59:59Z. A larger number is not a date the API sends (a
// millisecond value lands past it).
const maxUnixSeconds = 253402300799

// timestamp reads a date as the API sends it, as one ISO 8601 string.
//
// Search sends ISO 8601 strings, kept as sent (when not blank). Fetch sends
// Unix seconds, which become ISO 8601 UTC to the second, such as
// "2024-05-01T12:00:00Z"; a fraction is dropped. A number below 1 (the API
// omits an unknown date rather than send 0), past the year 9999 or not finite
// is nil, as is anything else.
func timestamp(v any) *string {
	switch t := v.(type) {
	case string:
		return nonEmptyString(t)
	case float64:
		if math.IsNaN(t) || math.IsInf(t, 0) {
			return nil
		}
		seconds := math.Floor(t)
		if seconds < 1 || seconds > maxUnixSeconds {
			return nil
		}
		s := time.Unix(int64(seconds), 0).UTC().Format("2006-01-02T15:04:05Z")
		return &s
	}
	return nil
}

// optionalBool is a JSON boolean, or nil for anything else.
func optionalBool(v any) *bool {
	b, ok := v.(bool)
	if !ok {
		return nil
	}
	return &b
}

// count is a whole number from 0 to 2^53 - 1, or nil for anything else.
func count(v any) *int {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || f < 0 || f > maxSafeInteger || f > math.MaxInt {
		return nil
	}
	n := int(f)
	return &n
}

func nonEmptyString(v any) *string {
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return nil
	}
	return &s
}

func asString(v any) string {
	s, ok := v.(string)
	if !ok {
		return ""
	}
	return s
}
