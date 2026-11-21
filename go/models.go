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
	// Objective says what the search is for, in two or three natural
	// sentences: the facts a useful page must contain, the task context the
	// query leaves out, the sources to prefer or exclude, and what is already
	// known. Up to 1,000 characters. The API validates and logs it; it does
	// not change results or price yet.
	Objective string
	// DisableCards returns ordinary web pages in place of Keenable's cards,
	// results Keenable writes for queries such as prices, exchange rates or
	// company facts (their URLs expire after one day). It works in the "pro"
	// and "realtime" modes. False, the API default, is not sent.
	DisableCards bool

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
	// Usage is what this search cost, when it was billed (made with an API
	// key). Nil otherwise.
	Usage *Usage `json:"usage,omitempty"`
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
	// Usage is what this fetch cost, when it was billed (made with an API
	// key). Nil otherwise.
	Usage *Usage `json:"usage,omitempty"`
}

// Money is an amount of money, such as {Amount: "0.004", Currency: "usd"}.
//
// Amount is a decimal string in the currency's major unit (dollars), kept
// exactly as the API sent it; parse it with a decimal type rather than
// float64 to keep it exact. It is negative for an organization allowed a
// negative balance that is in debt. Currency is a lowercase ISO 4217 code,
// always "usd".
type Money struct {
	Amount   string `json:"amount"`
	Currency string `json:"currency"`
}

// Usage is what one billed [Client.Search] or [Client.Fetch] cost. The API
// sends it for requests made with an API key, and not for keyless ones.
type Usage struct {
	// SKU is what was billed, such as "search.pro" or "fetch.live". It
	// matches [Price].SKU.
	SKU string `json:"sku"`
	// Amount is the billed units: 1 for a search or a fetch.
	Amount *int `json:"amount,omitempty"`
	// Cost is what this request cost.
	Cost Money `json:"cost"`
	// Balance is what the organization has left to spend after this request,
	// the same figure as [Balance].Available. It can lag the organization's
	// other requests by a few seconds. Nil when the API could not read it.
	Balance *Money `json:"balance,omitempty"`
}

// Price is the price of one SKU, from [Client.Prices].
type Price struct {
	// SKU is the SKU, as [Usage].SKU names it on a billed response, such as
	// "search.pro".
	SKU string `json:"sku"`
	// Product is "search", "fetch", "webql", "extract" or "agent".
	Product string `json:"product"`
	// Description says what one unit is, such as "One search in pro mode,
	// up to 10 results."
	Description string `json:"description"`
	// Unit is what is counted: "request", "result", "turn" or "run".
	Unit string `json:"unit"`
	// UnitPrice is the price of one unit.
	UnitPrice Money `json:"unit_price"`
	// ListUnitPrice is the public list price of one unit. Only with an API
	// key, and nil when the SKU has no list price.
	ListUnitPrice *Money `json:"list_unit_price,omitempty"`
	// Source is "list" when UnitPrice is the public list price and
	// "contract" when the organization has its own price. Only with an API
	// key; nil otherwise.
	Source *string `json:"source,omitempty"`
	// Raw is the unmodified JSON object, so new API fields stay reachable.
	Raw map[string]any `json:"-"`
}

// PriceList is every SKU's price, returned by [Client.Prices]. With an API
// key these are your organization's prices, with the public list price
// beside each one; keyless, the public list prices.
type PriceList struct {
	// PriceListID identifies the price list. It changes when the prices
	// change.
	PriceListID string `json:"price_list_id"`
	// Source is "contract" when any price differs from the public list, else
	// "list".
	Source string  `json:"source"`
	Prices []Price `json:"prices"`
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem. Empty when the API sent none.
	RequestID string         `json:"request_id,omitempty"`
	Raw       map[string]any `json:"-"`
}

// Plan is the organization's plan, in [Balance].Plan.
type Plan struct {
	// Name is the plan's name, such as "Builder".
	Name string `json:"name"`
	// RenewsAt is when the plan's free allowance renews, as ISO 8601.
	RenewsAt string `json:"renews_at"`
}

// Balance is how much the organization has left to spend, from
// [Client.Balance].
type Balance struct {
	// Available is what the organization can still spend: the plan's unused
	// free allowance for this period plus the purchased balance. Calls fail
	// with an [InsufficientCreditsError] once it reaches zero, unless the
	// organization is allowed a negative balance.
	Available Money `json:"available"`
	// Purchased is the part of the balance that was bought. It does not
	// expire and is spent only after the free allowance.
	Purchased Money `json:"purchased"`
	// Plan is the organization's plan. Nil when the API could not read it.
	Plan *Plan `json:"plan"`
	// BillingURL is the console page where a person can add funds or turn on
	// auto top-up.
	BillingURL string `json:"billing_url"`
	// AsOf is when the balance was read, as ISO 8601. It can lag the
	// organization's other requests by a few seconds.
	AsOf string `json:"as_of"`
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem. Empty when the API sent none.
	RequestID string         `json:"request_id,omitempty"`
	Raw       map[string]any `json:"-"`
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
		Usage:   usageFromJSON(data["usage"]),
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
		Usage:       usageFromJSON(data["usage"]),
	}
}

// moneyFromJSON reads a required money field: the strings sent, or "" for
// anything else.
func moneyFromJSON(v any) Money {
	data, _ := v.(map[string]any)
	return Money{Amount: asString(data["amount"]), Currency: asString(data["currency"])}
}

// optionalMoney reads an optional money field: nil unless it carries an
// amount.
func optionalMoney(v any) *Money {
	data, ok := v.(map[string]any)
	if !ok || nonEmptyString(data["amount"]) == nil {
		return nil
	}
	m := moneyFromJSON(data)
	return &m
}

func usageFromJSON(v any) *Usage {
	data, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return &Usage{
		SKU:     asString(data["sku"]),
		Amount:  count(data["amount"]),
		Cost:    moneyFromJSON(data["cost"]),
		Balance: optionalMoney(data["balance"]),
	}
}

func priceListFromJSON(data map[string]any) *PriceList {
	prices := make([]Price, 0)
	if raw, ok := data["prices"].([]any); ok {
		for _, item := range raw {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			prices = append(prices, Price{
				SKU:           asString(obj["sku"]),
				Product:       asString(obj["product"]),
				Description:   asString(obj["description"]),
				Unit:          asString(obj["unit"]),
				UnitPrice:     moneyFromJSON(obj["unit_price"]),
				ListUnitPrice: optionalMoney(obj["list_unit_price"]),
				Source:        nonEmptyString(obj["source"]),
				Raw:           obj,
			})
		}
	}
	return &PriceList{
		PriceListID: asString(data["price_list_id"]),
		Source:      asString(data["source"]),
		Prices:      prices,
		Raw:         data,
	}
}

func balanceFromJSON(data map[string]any) *Balance {
	var plan *Plan
	if obj, ok := data["plan"].(map[string]any); ok {
		plan = &Plan{Name: asString(obj["name"]), RenewsAt: asString(obj["renews_at"])}
	}
	return &Balance{
		Available:  moneyFromJSON(data["available"]),
		Purchased:  moneyFromJSON(data["purchased"]),
		Plan:       plan,
		BillingURL: asString(data["billing_url"]),
		AsOf:       asString(data["as_of"]),
		Raw:        data,
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
