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
	// Moderation filters unsafe results: "moderate" or "strict" removes
	// results a safety model judges unsafe at that level, so a search can
	// return fewer results or none. Empty means no moderation and is not
	// sent. It works in the "pro" and "realtime" modes, and not when the
	// query is a URL or with QueryTime; the API rejects it there.
	Moderation string

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
	RequestID string `json:"request_id,omitempty"`
	// Warnings name what the request should change, such as a deprecated
	// parameter it used; the request was still served. Nil when the API
	// sent none.
	Warnings []SearchWarning `json:"warnings,omitempty"`
	Raw      map[string]any  `json:"-"`
}

// SearchWarning is something in a search request to change, such as a
// deprecated parameter.
type SearchWarning struct {
	// Code is the kind of warning, such as "deprecated_parameter".
	Code string `json:"code"`
	// Path is a JSON pointer to the request parameter, such as "/safety_mode".
	Path string `json:"path"`
	// Message says what to change and by when.
	Message string `json:"message"`
}

// FetchResponse is what [Client.Fetch] returns: Results[i] is for urls[i].
type FetchResponse struct {
	Results []Page `json:"results"`
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem. Empty when the API sent none.
	RequestID string         `json:"request_id,omitempty"`
	Raw       map[string]any `json:"-"`
}

// FetchError is why one URL of a [Client.Fetch] call failed, as the API sent it.
type FetchError struct {
	Status    int    `json:"status"`
	Error     string `json:"error"`
	Code      string `json:"code,omitempty"`
	Type      string `json:"type,omitempty"`
	Message   string `json:"message,omitempty"`
	Fix       string `json:"fix,omitempty"`
	Retryable *bool  `json:"retryable,omitempty"`
}

// PageLink is a link on a fetched page.
type PageLink struct {
	URL  string  `json:"url"`
	Text *string `json:"text"`
}

// PageImage is an image on a fetched page.
type PageImage struct {
	URL string  `json:"url"`
	Alt *string `json:"alt"`
}

// AnswerError is why the answer for Schema could not be made.
type AnswerError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Usage is what reading one page cost.
type Usage struct {
	SKU              string   `json:"sku"`
	Amount           int      `json:"amount"`
	Credits          float64  `json:"credits"`
	Paid             bool     `json:"paid"`
	CreditsRemaining *float64 `json:"credits_remaining,omitempty"`
}

// Page is one result of [Client.Fetch]: a page as markdown, or Error when
// that URL failed.
type Page struct {
	URL         string  `json:"url"`
	Title       string  `json:"title"`
	Content     string  `json:"content"`
	Description *string `json:"description,omitempty"`
	Author      *string `json:"author,omitempty"`
	// PublishedAt is when the page was published, as ISO 8601. The API sends
	// Unix seconds for a fetch; they are given in UTC to the second, such as
	// "2024-05-01T12:00:00Z", the form search results use. Nil when unknown.
	PublishedAt *string        `json:"published_at,omitempty"`
	Raw         map[string]any `json:"-"`
	// Truncated is true when the page was longer than the API's max_chars and
	// Content was cut (cut content ends with "..."). Nil when the API did not
	// say.
	Truncated *bool `json:"truncated,omitempty"`
	// TotalChars is the length of the full extracted content in Unicode code
	// points, before any cut. Nil when the API did not say.
	TotalChars *int    `json:"total_chars,omitempty"`
	Image      *string `json:"image,omitempty"`
	Favicon    *string `json:"favicon,omitempty"`
	// Links are the page's links, when FetchOptions.Links was set.
	Links  []PageLink  `json:"links,omitempty"`
	Images []PageImage `json:"images,omitempty"`
	// Structured is the answer for FetchOptions.Schema.
	Structured  map[string]any `json:"structured,omitempty"`
	AnswerError *AnswerError   `json:"answer_error,omitempty"`
	Stale       *bool          `json:"stale,omitempty"`
	Usage       *Usage         `json:"usage,omitempty"`
	// Error is set when this URL failed; the other fields are then empty.
	Error *FetchError `json:"error,omitempty"`
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
	var warnings []SearchWarning
	if raw, ok := data["warnings"].([]any); ok {
		for _, item := range raw {
			obj, ok := item.(map[string]any)
			if !ok {
				continue
			}
			warnings = append(warnings, SearchWarning{
				Code:    asString(obj["code"]),
				Path:    asString(obj["path"]),
				Message: asString(obj["message"]),
			})
		}
	}
	return &SearchResponse{
		Query:    q,
		Mode:     nonEmptyString(data["mode"]),
		Results:  results,
		Warnings: warnings,
		Raw:      data,
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
	page := &Page{
		URL:         pageURL,
		Title:       asString(data["title"]),
		Content:     asString(data["content"]),
		Description: nonEmptyString(data["description"]),
		Author:      nonEmptyString(data["author"]),
		PublishedAt: timestamp(data["published_at"]),
		Raw:         data,
		Truncated:   optionalBool(data["truncated"]),
		TotalChars:  count(data["total_chars"]),
		Image:       nonEmptyString(data["image"]),
		Favicon:     nonEmptyString(data["favicon"]),
		Stale:       optionalBool(data["stale"]),
	}
	page.Structured, _ = data["structured"].(map[string]any)
	decodeField(data["links"], &page.Links)
	decodeField(data["images"], &page.Images)
	decodeField(data["answer_error"], &page.AnswerError)
	decodeField(data["usage"], &page.Usage)
	decodeField(data["error"], &page.Error)
	return page
}

// decodeField fills out from a decoded JSON value, leaving it unset when the
// value is missing or has another shape.
func decodeField(value, out any) {
	if value == nil {
		return
	}
	if raw, err := json.Marshal(value); err == nil {
		_ = json.Unmarshal(raw, out)
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

// Money is an amount of money, as the API sent it.
type Money struct {
	// Amount is the amount in the currency's major unit (US dollars), such
	// as 0.004, with up to nine decimal places. Negative for an account in
	// debt. 0 when the API sent no finite number.
	Amount float64 `json:"amount"`
	// Currency is the lowercase ISO 4217 code, such as "usd".
	Currency string `json:"currency"`
}

// BillingPrice is the price of one SKU, from [Client.Billing].
type BillingPrice struct {
	// SKU is what is billed, such as "search.pro" or "fetch.live".
	SKU string `json:"sku"`
	// Unit is what one unit is: "search", "result" or "page".
	Unit string `json:"unit"`
	// UnitPrice is the price of one unit.
	UnitPrice Money `json:"unit_price"`
	// ListUnitPrice is the public list price of one unit. Only with an API key.
	ListUnitPrice *Money `json:"list_unit_price"`
	// Source is "list" when UnitPrice is the list price, "contract" when the
	// organization has its own. Only with an API key.
	Source *string `json:"source"`
}

// BillingBalance is what the organization can still spend.
type BillingBalance struct {
	// Available is the unused free allowance for this month plus the
	// purchased balance.
	Available Money `json:"available"`
	// Purchased is the part of the balance that was bought, spent after the
	// allowance.
	Purchased Money `json:"purchased"`
}

// BillingUsageLine is the use of one SKU since the start of the period.
type BillingUsageLine struct {
	// SKU is "search", "search.extra_result" or "fetch".
	SKU string `json:"sku"`
	// Quantity is the units used since the start of the period.
	Quantity int `json:"quantity"`
	// Cost is what those units cost.
	Cost Money `json:"cost"`
}

// BillingUsage is the spend since the start of the current monthly period.
type BillingUsage struct {
	// Since is the start of the period (ISO 8601), when the free allowance
	// last renewed.
	Since string `json:"since"`
	// Cost is the total spend since Since.
	Cost      Money              `json:"cost"`
	LineItems []BillingUsageLine `json:"line_items"`
}

// BillingAccount is the organization's balance and usage.
type BillingAccount struct {
	Balance BillingBalance `json:"balance"`
	Usage   BillingUsage   `json:"usage"`
	// BillingURL is the console page where a person can add funds.
	BillingURL string `json:"billing_url"`
	// AsOf is when this was read (ISO 8601). Usage can lag recent calls by
	// about a minute.
	AsOf string `json:"as_of"`
}

// Billing is what [Client.Billing] returns: prices, and the account with an
// API key.
type Billing struct {
	// Prices are the public list prices without an API key. With one, they
	// are your organization's prices; a SKU without a price on your plan is
	// left out.
	Prices []BillingPrice `json:"prices"`
	// Account is the balance and usage. Nil without an API key.
	Account *BillingAccount `json:"account"`
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem. Empty when the API sent none.
	RequestID string         `json:"request_id,omitempty"`
	Raw       map[string]any `json:"-"`
}

func objectOrEmpty(v any) map[string]any {
	if m, ok := v.(map[string]any); ok {
		return m
	}
	return map[string]any{}
}

func objects(v any) []map[string]any {
	items, _ := v.([]any)
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func asAmount(v any) float64 {
	f, ok := v.(float64)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return 0
	}
	return f
}

func moneyFromJSON(v any) Money {
	m := objectOrEmpty(v)
	return Money{Amount: asAmount(m["amount"]), Currency: asString(m["currency"])}
}

func billingFromJSON(data map[string]any) *Billing {
	b := &Billing{Prices: make([]BillingPrice, 0), Raw: data}
	for _, p := range objects(data["prices"]) {
		price := BillingPrice{
			SKU:       asString(p["sku"]),
			Unit:      asString(p["unit"]),
			UnitPrice: moneyFromJSON(p["unit_price"]),
			Source:    nonEmptyString(p["source"]),
		}
		if list, ok := p["list_unit_price"].(map[string]any); ok {
			m := moneyFromJSON(list)
			price.ListUnitPrice = &m
		}
		b.Prices = append(b.Prices, price)
	}
	account, ok := data["account"].(map[string]any)
	if !ok {
		return b
	}
	balance := objectOrEmpty(account["balance"])
	usage := objectOrEmpty(account["usage"])
	acct := &BillingAccount{
		Balance: BillingBalance{
			Available: moneyFromJSON(balance["available"]),
			Purchased: moneyFromJSON(balance["purchased"]),
		},
		Usage: BillingUsage{
			Since:     asString(usage["since"]),
			Cost:      moneyFromJSON(usage["cost"]),
			LineItems: make([]BillingUsageLine, 0),
		},
		BillingURL: asString(account["billing_url"]),
		AsOf:       asString(account["as_of"]),
	}
	for _, line := range objects(usage["line_items"]) {
		quantity := 0
		if n := count(line["quantity"]); n != nil {
			quantity = *n
		}
		acct.Usage.LineItems = append(acct.Usage.LineItems, BillingUsageLine{
			SKU:      asString(line["sku"]),
			Quantity: quantity,
			Cost:     moneyFromJSON(line["cost"]),
		})
	}
	b.Account = acct
	return b
}
