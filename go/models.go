package keenable

import (
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

// SearchOptions are the optional arguments to [Client.Search].
//
// Empty strings are left unset and are not sent. SnippetMaxLength uses a
// pointer so zero can be sent; nil means unset. Mode defaults to "pro".
type SearchOptions struct {
	// Mode is the search mode. Empty means "pro".
	Mode string
	// Site restricts results to one domain, for example "arxiv.org".
	Site string
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
}

// SearchResult is one page returned by [Client.Search].
type SearchResult struct {
	Title   string `json:"title"`
	URL     string `json:"url"`
	Snippet string `json:"snippet"`
	// Description is the page's meta description. Often absent. Prefer Snippet
	// in prompts. Nil when the API omitted it or sent an empty string.
	Description *string `json:"description,omitempty"`
	// PublishedAt is the ISO-8601 publication time, when the page exposes one.
	PublishedAt *string `json:"published_at,omitempty"`
	// AcquiredAt is when Keenable indexed the page.
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
	Raw     map[string]any `json:"-"`
}

// Page is a URL fetched by [Client.Fetch], with main content as markdown.
type Page struct {
	URL         string         `json:"url"`
	Title       string         `json:"title"`
	Content     string         `json:"content"`
	Description *string        `json:"description,omitempty"`
	Author      *string        `json:"author,omitempty"`
	PublishedAt *string        `json:"published_at,omitempty"`
	Raw         map[string]any `json:"-"`
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
		body := resultBody(result)
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
// Results are added whole until the budget is reached, so a trimmed context
// never ends mid-sentence.
func (r *SearchResponse) ToContext(opts *ContextOptions) string {
	if r == nil {
		return ""
	}
	includeDates := contextIncludeDates(opts)
	cited := r.Cited(opts)
	parts := make([]string, 0, len(cited))
	for i, result := range cited {
		parts = append(parts, contextBlock(
			sourceHeader(i+1, result.Title, result.URL, result.PublishedAt, includeDates),
			resultBody(result),
		))
	}
	return strings.Join(parts, "\n\n")
}

// ToContext renders the page as a citable block, same shape as a search result.
//
// Only MaxChars is read. A page is one document, so an oversized page is cut
// at the budget instead of dropped. The publication date is included when
// the page has one.
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
	body := strings.TrimRightFunc(cutRunes(p.Content, budget), unicode.IsSpace)
	return contextBlock(header, body)
}

func contextMaxChars(opts *ContextOptions) int {
	if opts == nil || opts.MaxChars <= 0 {
		return DefaultContextMaxChars
	}
	return opts.MaxChars
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

func resultBody(r SearchResult) string {
	text := r.Snippet
	if text == "" && r.Description != nil {
		text = *r.Description
	}
	return collapse(text)
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
		PublishedAt: nonEmptyString(data["published_at"]),
		AcquiredAt:  nonEmptyString(data["acquired_at"]),
		Raw:         data,
	}
}

func pageFromJSON(data map[string]any, fallbackURL string) *Page {
	pageURL := fallbackURL
	if s := asString(data["url"]); s != "" {
		pageURL = s
	}
	return &Page{
		URL:         pageURL,
		Title:       asString(data["title"]),
		Content:     asString(data["content"]),
		Description: nonEmptyString(data["description"]),
		Author:      nonEmptyString(data["author"]),
		PublishedAt: nonEmptyString(data["published_at"]),
		Raw:         data,
	}
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
