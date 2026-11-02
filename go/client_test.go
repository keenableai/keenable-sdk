package keenable_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/keenableai/keenable-sdk/go"
)

var searchBody = map[string]any{
	"query": "wafer scale engine",
	"mode":  "pro",
	"results": []any{
		map[string]any{
			"title":        "How Cerebras works",
			"url":          "https://cerebras.ai/chip",
			"description":  "",
			"snippet":      "The WSE keeps the whole model\nin on-chip memory.",
			"published_at": "2026-05-31T23:57:19Z",
			"acquired_at":  "2026-07-24T01:32:23Z",
		},
		map[string]any{
			"title":   "MoE guide",
			"url":     "https://cerebras.ai/blog/moe-guide-scale",
			"snippet": "Mixture-of-experts routing at scale.",
		},
	},
}

var fetchBody = map[string]any{
	"url":         "https://example.com/",
	"title":       "Example Domain",
	"content":     "# Example Domain\n\nThis domain is for use in examples.",
	"description": "",
}

type captured struct {
	Path   string
	Query  url.Values
	Header http.Header
	Body   []byte
}

func capture(next http.Handler) (*[]captured, http.Handler) {
	seen := &[]captured{}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = r.Body.Close()
		*seen = append(*seen, captured{
			Path:   r.URL.Path,
			Query:  r.URL.Query(),
			Header: r.Header.Clone(),
			Body:   body,
		})
		next.ServeHTTP(w, r)
	})
	return seen, h
}

func jsonHandler(status int, body any) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := json.Marshal(body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(raw)
	})
}

func textHandler(status int, body string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	})
}

func routed() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.Contains(r.URL.Path, "/v1/search") {
			jsonHandler(http.StatusOK, searchBody).ServeHTTP(w, r)
			return
		}
		jsonHandler(http.StatusOK, fetchBody).ServeHTTP(w, r)
	})
}

func start(t *testing.T, h http.Handler, opts *keenable.Options) (*keenable.Client, *[]captured) {
	t.Helper()
	seen, handler := capture(h)
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	if opts == nil {
		opts = &keenable.Options{}
	}
	base := srv.URL
	opts.BaseURL = &base
	c, err := keenable.New(opts)
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	t.Cleanup(c.Close)
	return c, seen
}

func startKeyless(t *testing.T, h http.Handler, opts *keenable.Options) (*keenable.Client, *[]captured) {
	t.Helper()
	t.Setenv("KEENABLE_API_KEY", "")
	t.Setenv("KEENABLE_API_URL", "")
	return start(t, h, opts)
}

func one(t *testing.T, seen *[]captured) captured {
	t.Helper()
	if len(*seen) != 1 {
		t.Fatalf("got %d requests, want 1", len(*seen))
	}
	return (*seen)[0]
}

func payloadOf(t *testing.T, req captured) map[string]any {
	t.Helper()
	var payload map[string]any
	if err := json.Unmarshal(req.Body, &payload); err != nil {
		t.Fatalf("body: %v", err)
	}
	return payload
}

func TestSearchParsesResults(t *testing.T) {
	c, _ := startKeyless(t, jsonHandler(http.StatusOK, searchBody), nil)
	resp, err := c.Search(context.Background(), "wafer scale engine", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Results) != 2 {
		t.Fatalf("len %d", len(resp.Results))
	}
	first := resp.Results[0]
	if first.Title != "How Cerebras works" {
		t.Fatal(first.Title)
	}
	if !strings.HasPrefix(first.Snippet, "The WSE") {
		t.Fatal(first.Snippet)
	}
	if first.Description != nil {
		t.Fatalf("description %q, want absent", *first.Description)
	}
	if first.PublishedAt == nil || *first.PublishedAt != "2026-05-31T23:57:19Z" {
		t.Fatalf("published %#v", first.PublishedAt)
	}
	if first.AcquiredAt == nil || *first.AcquiredAt != "2026-07-24T01:32:23Z" {
		t.Fatalf("acquired %#v", first.AcquiredAt)
	}
	if resp.Results[1].Description != nil || resp.Results[1].AcquiredAt != nil {
		t.Fatal("second result should omit empty fields")
	}
}

func TestSearchSendsFiltersAndDefaultsToPro(t *testing.T) {
	c, seen := startKeyless(t, jsonHandler(http.StatusOK, searchBody), nil)
	capLen := 200
	_, err := c.Search(context.Background(), "wafer scale engine", &keenable.SearchOptions{
		Site:             "cerebras.ai",
		PublishedAfter:   "2026-01-01",
		SnippetMaxLength: &capLen,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := payloadOf(t, one(t, seen))
	if payload["query"] != "wafer scale engine" || payload["mode"] != "pro" {
		t.Fatalf("payload %#v", payload)
	}
	if payload["site"] != "cerebras.ai" || payload["published_after"] != "2026-01-01" {
		t.Fatalf("payload %#v", payload)
	}
	if payload["snippet_max_length"] != float64(200) {
		t.Fatalf("snippet cap %#v", payload["snippet_max_length"])
	}
	for _, absent := range []string{"published_before", "acquired_after", "acquired_before"} {
		if _, ok := payload[absent]; ok {
			t.Fatalf("sent unset filter %s", absent)
		}
	}
}

func TestSearchSendsEveryFilter(t *testing.T) {
	c, seen := startKeyless(t, jsonHandler(http.StatusOK, searchBody), nil)
	zero := 0
	_, err := c.Search(context.Background(), "q", &keenable.SearchOptions{
		Site:             "arxiv.org",
		PublishedAfter:   "2026-01-01",
		PublishedBefore:  "2026-02-01",
		AcquiredAfter:    "2026-03-01",
		AcquiredBefore:   "2026-04-01",
		SnippetMaxLength: &zero,
	})
	if err != nil {
		t.Fatal(err)
	}
	payload := payloadOf(t, one(t, seen))
	for _, key := range []string{"site", "published_after", "published_before", "acquired_after", "acquired_before", "snippet_max_length"} {
		if _, ok := payload[key]; !ok {
			t.Fatalf("missing %s in %#v", key, payload)
		}
	}
	if payload["snippet_max_length"] != float64(0) {
		t.Fatalf("zero cap not sent: %#v", payload["snippet_max_length"])
	}
}

func TestKeylessUsesPublicEndpoint(t *testing.T) {
	c, seen := startKeyless(t, jsonHandler(http.StatusOK, searchBody), nil)
	if _, err := c.Search(context.Background(), "hello", nil); err != nil {
		t.Fatal(err)
	}
	if !c.Keyless() {
		t.Fatal("expected keyless")
	}
	req := one(t, seen)
	if req.Path != "/v1/search/public" {
		t.Fatal(req.Path)
	}
	if req.Header.Get("X-API-Key") != "" {
		t.Fatal(req.Header.Get("X-API-Key"))
	}
	if req.Header.Get("X-Keenable-Title") != "Keenable SDK" {
		t.Fatal(req.Header.Get("X-Keenable-Title"))
	}
	if req.Header.Get("Accept") != "application/json" {
		t.Fatal(req.Header.Get("Accept"))
	}
	if req.Header.Get("Content-Type") != "application/json" {
		t.Fatal(req.Header.Get("Content-Type"))
	}
	if got := req.Header.Get("User-Agent"); got != "keenable-go/"+keenable.Version {
		t.Fatal(got)
	}
}

func TestClientSourceOverride(t *testing.T) {
	c, seen := startKeyless(t, jsonHandler(http.StatusOK, searchBody), &keenable.Options{
		ClientSource: "Acme Agent",
	})
	if _, err := c.Search(context.Background(), "hello", nil); err != nil {
		t.Fatal(err)
	}
	if got := one(t, seen).Header.Get("X-Keenable-Title"); got != "Acme Agent" {
		t.Fatal(got)
	}
}

func TestAPIKeySelectsKeyedEndpoint(t *testing.T) {
	t.Setenv("KEENABLE_API_KEY", "ignored")
	key := "keen_test"
	c, seen := start(t, jsonHandler(http.StatusOK, searchBody), &keenable.Options{APIKey: &key})
	if _, err := c.Search(context.Background(), "hello", nil); err != nil {
		t.Fatal(err)
	}
	if c.Keyless() {
		t.Fatal("expected a key")
	}
	req := one(t, seen)
	if req.Path != "/v1/search" {
		t.Fatal(req.Path)
	}
	if req.Header.Get("X-API-Key") != "keen_test" {
		t.Fatal(req.Header.Get("X-API-Key"))
	}
}

func TestEmptyAPIKeyStaysKeylessWhenEnvIsSet(t *testing.T) {
	t.Setenv("KEENABLE_API_KEY", "keen_env")
	empty := ""
	c, seen := start(t, jsonHandler(http.StatusOK, searchBody), &keenable.Options{APIKey: &empty})
	if _, err := c.Search(context.Background(), "hello", nil); err != nil {
		t.Fatal(err)
	}
	if !c.Keyless() {
		t.Fatal("explicit empty key should force keyless")
	}
	req := one(t, seen)
	if req.Path != "/v1/search/public" || req.Header.Get("X-API-Key") != "" {
		t.Fatalf("path %s key %q", req.Path, req.Header.Get("X-API-Key"))
	}
}

func TestEnvAPIKey(t *testing.T) {
	t.Setenv("KEENABLE_API_KEY", "keen_env")
	c, seen := start(t, jsonHandler(http.StatusOK, searchBody), nil)
	if _, err := c.Search(context.Background(), "hello", nil); err != nil {
		t.Fatal(err)
	}
	if c.Keyless() {
		t.Fatal("env key ignored")
	}
	req := one(t, seen)
	if req.Path != "/v1/search" || req.Header.Get("X-API-Key") != "keen_env" {
		t.Fatalf("path %s key %q", req.Path, req.Header.Get("X-API-Key"))
	}
}

func TestToContextBudget(t *testing.T) {
	c, _ := startKeyless(t, jsonHandler(http.StatusOK, searchBody), nil)
	resp, err := c.Search(context.Background(), "wafer scale engine", nil)
	if err != nil {
		t.Fatal(err)
	}
	context := resp.ToContext(nil)
	if !strings.HasPrefix(context, "[1] How Cerebras works (https://cerebras.ai/chip)") {
		t.Fatal(context)
	}
	if !strings.Contains(context, "[2] MoE guide") {
		t.Fatal(context)
	}
	if !strings.Contains(context, "The WSE keeps the whole model in on-chip memory.") {
		t.Fatal(context)
	}
	if !strings.Contains(context, "published 2026-05-31T23:57:19Z") {
		t.Fatal(context)
	}

	trimmed := resp.ToContext(&keenable.ContextOptions{MaxChars: 120})
	if !strings.Contains(trimmed, "[1]") || strings.Contains(trimmed, "[2]") {
		t.Fatal(trimmed)
	}
	if !strings.HasSuffix(trimmed, "memory.") {
		t.Fatal(trimmed)
	}
	if resp.ToContext(&keenable.ContextOptions{MaxResults: intPtr(1)}) != trimmed {
		t.Fatal("max results 1 should match the budget trim")
	}

	off := false
	if strings.Contains(resp.ToContext(&keenable.ContextOptions{IncludeDates: &off}), "published") {
		t.Fatal("dates should be omitted")
	}
	if resp.ToContext(&keenable.ContextOptions{MaxResults: intPtr(0)}) != "" {
		t.Fatal("zero max results should render nothing")
	}
}

func TestToContextStopsAtOversizedMiddle(t *testing.T) {
	body := map[string]any{
		"query": "q",
		"results": []any{
			map[string]any{"title": "First", "url": "https://example.com/1", "snippet": "short"},
			map[string]any{"title": "Second", "url": "https://example.com/2", "snippet": strings.Repeat("x", 500)},
			map[string]any{"title": "Third", "url": "https://example.com/3", "snippet": "also short"},
		},
	}
	c, _ := startKeyless(t, jsonHandler(http.StatusOK, body), nil)
	resp, err := c.Search(context.Background(), "q", nil)
	if err != nil {
		t.Fatal(err)
	}
	context := resp.ToContext(&keenable.ContextOptions{MaxChars: 120})
	if !strings.Contains(context, "[1] First") || strings.Contains(context, "[2]") || strings.Contains(context, "Third") {
		t.Fatal(context)
	}
}

func TestCitedMatchesRendered(t *testing.T) {
	c, _ := startKeyless(t, jsonHandler(http.StatusOK, searchBody), nil)
	resp, err := c.Search(context.Background(), "wafer scale engine", nil)
	if err != nil {
		t.Fatal(err)
	}
	if titles(resp.Cited(nil)) != "How Cerebras works|MoE guide" {
		t.Fatal(titles(resp.Cited(nil)))
	}
	if titles(resp.Cited(&keenable.ContextOptions{MaxChars: 120})) != "How Cerebras works" {
		t.Fatal(titles(resp.Cited(&keenable.ContextOptions{MaxChars: 120})))
	}
}

func TestFetchReturnsMarkdown(t *testing.T) {
	c, seen := startKeyless(t, jsonHandler(http.StatusOK, fetchBody), nil)
	page, err := c.Fetch(context.Background(), "https://example.com")
	if err != nil {
		t.Fatal(err)
	}
	req := one(t, seen)
	if req.Path != "/v1/fetch/public" {
		t.Fatal(req.Path)
	}
	if req.Query.Get("url") != "https://example.com" {
		t.Fatal(req.Query.Get("url"))
	}
	if req.Header.Get("Content-Type") != "" {
		t.Fatal(req.Header.Get("Content-Type"))
	}
	if page.Title != "Example Domain" || !strings.HasPrefix(page.Content, "# Example Domain") {
		t.Fatalf("%#v", page)
	}
	if page.URL != "https://example.com/" {
		t.Fatal(page.URL)
	}
}

func TestFetchAllowsPublicAddress(t *testing.T) {
	c, seen := startKeyless(t, jsonHandler(http.StatusOK, fetchBody), nil)
	if _, err := c.Fetch(context.Background(), "https://8.8.8.8/path"); err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 1 {
		t.Fatalf("public IP was refused, requests=%d", len(*seen))
	}
}

func TestPageToContextCuts(t *testing.T) {
	c, _ := startKeyless(t, jsonHandler(http.StatusOK, fetchBody), nil)
	page, err := c.Fetch(context.Background(), "https://example.com")
	if err != nil {
		t.Fatal(err)
	}
	context := page.ToContext(nil)
	if !strings.HasPrefix(context, "[1] Example Domain (https://example.com/)") {
		t.Fatal(context)
	}
	if !strings.Contains(context, "This domain is for use in examples.") {
		t.Fatal(context)
	}
	if !strings.HasPrefix(page.ToContext(&keenable.ContextOptions{MaxChars: 60}), "[1] Example Domain") {
		t.Fatal(page.ToContext(&keenable.ContextOptions{MaxChars: 60}))
	}
}

func TestFetchRefusesInternalTargets(t *testing.T) {
	urls := []string{
		"http://localhost:8080/admin",
		"http://127.0.0.1/",
		"https://169.254.169.254/latest/meta-data/",
		"https://10.0.0.5/",
		"https://192.168.1.1/",
		"file:///etc/passwd",
		"https://metadata.google.internal/",
		"https://localhost./",
		"https://metadata.google.internal./",
		"https://[::ffff:169.254.169.254]/latest/meta-data/",
		"https://[::ffff:127.0.0.1]/",
		"https://[::ffff:10.0.0.1]/",
		"https://[::ffff:7f00:1]/",
		"https://[0:0:0:0:0:ffff:169.254.169.254]/",
	}
	c, seen := startKeyless(t, jsonHandler(http.StatusOK, fetchBody), nil)
	for _, raw := range urls {
		before := len(*seen)
		_, err := c.Fetch(context.Background(), raw)
		var inv *keenable.InvalidRequestError
		if !errors.As(err, &inv) {
			t.Fatalf("%s: %v", raw, err)
		}
		if len(*seen) != before {
			t.Fatalf("%s sent a request", raw)
		}
	}
}

func TestEmptyQuerySendsNothing(t *testing.T) {
	c, seen := startKeyless(t, jsonHandler(http.StatusOK, searchBody), nil)
	_, err := c.Search(context.Background(), "   ", nil)
	var inv *keenable.InvalidRequestError
	if !errors.As(err, &inv) {
		t.Fatal(err)
	}
	var sdk keenable.Error
	if !errors.As(err, &sdk) {
		t.Fatal("InvalidRequestError should implement Error")
	}
	if len(*seen) != 0 {
		t.Fatal("empty query sent a request")
	}
}

func TestNilContext(t *testing.T) {
	c, seen := startKeyless(t, jsonHandler(http.StatusOK, searchBody), nil)
	if _, err := c.Search(nil, "q", nil); !errors.As(err, new(*keenable.InvalidRequestError)) {
		t.Fatal(err)
	}
	if _, err := c.Fetch(nil, "https://example.com"); !errors.As(err, new(*keenable.InvalidRequestError)) {
		t.Fatal(err)
	}
	if len(*seen) != 0 {
		t.Fatal("nil context sent a request")
	}
}

func TestStatusErrors(t *testing.T) {
	t.Run("429", func(t *testing.T) {
		c, _ := startKeyless(t, jsonHandler(http.StatusTooManyRequests, map[string]any{"message": "hourly cap reached"}), nil)
		_, err := c.Search(context.Background(), "q", nil)
		var rate *keenable.RateLimitError
		if !errors.As(err, &rate) {
			t.Fatal(err)
		}
		if rate.StatusCode != 429 || !strings.Contains(err.Error(), "hourly cap reached") {
			t.Fatal(err)
		}
		var api *keenable.APIError
		if !errors.As(err, &api) {
			t.Fatal("rate limit should unwrap to APIError")
		}
	})
	t.Run("401", func(t *testing.T) {
		c, _ := startKeyless(t, jsonHandler(http.StatusUnauthorized, map[string]any{"error": "bad key"}), nil)
		_, err := c.Search(context.Background(), "q", nil)
		var auth *keenable.AuthError
		if !errors.As(err, &auth) || auth.StatusCode != 401 || !strings.Contains(err.Error(), "bad key") {
			t.Fatal(err)
		}
	})
	t.Run("403", func(t *testing.T) {
		c, _ := startKeyless(t, jsonHandler(http.StatusForbidden, map[string]any{"error": "forbidden"}), nil)
		_, err := c.Search(context.Background(), "q", nil)
		if !errors.As(err, new(*keenable.AuthError)) {
			t.Fatal(err)
		}
	})
	t.Run("402", func(t *testing.T) {
		c, _ := startKeyless(t, jsonHandler(http.StatusPaymentRequired, map[string]any{"detail": "no credits"}), nil)
		_, err := c.Search(context.Background(), "q", nil)
		var api *keenable.APIError
		if !errors.As(err, &api) || api.StatusCode != 402 {
			t.Fatal(err)
		}
		if errors.As(err, new(*keenable.AuthError)) || errors.As(err, new(*keenable.RateLimitError)) {
			t.Fatal("402 should stay a plain APIError")
		}
		if !strings.Contains(err.Error(), "insufficient credits") || !strings.Contains(err.Error(), "no credits") {
			t.Fatal(err)
		}
	})
	t.Run("500", func(t *testing.T) {
		c, _ := startKeyless(t, jsonHandler(http.StatusInternalServerError, map[string]any{"error": "boom"}), nil)
		_, err := c.Search(context.Background(), "q", nil)
		var api *keenable.APIError
		if !errors.As(err, &api) || !strings.Contains(err.Error(), "Keenable API error (500)") || !strings.Contains(err.Error(), "boom") {
			t.Fatal(err)
		}
	})
}

func TestNonJSONAndNonObjectBodies(t *testing.T) {
	c, _ := startKeyless(t, textHandler(http.StatusOK, "nope"), nil)
	_, err := c.Search(context.Background(), "q", nil)
	var api *keenable.APIError
	if !errors.As(err, &api) || !strings.Contains(err.Error(), "non-JSON") {
		t.Fatal(err)
	}

	c, _ = startKeyless(t, textHandler(http.StatusOK, "[1,2]"), nil)
	_, err = c.Search(context.Background(), "q", nil)
	if !errors.As(err, &api) || !strings.Contains(err.Error(), "Unexpected response") {
		t.Fatal(err)
	}
}

func TestBaseURLValidation(t *testing.T) {
	t.Setenv("KEENABLE_API_KEY", "")
	t.Setenv("KEENABLE_API_URL", "")
	for _, raw := range []string{"ftp://api.keenable.ai", "http://api.keenable.ai", "", "https://api.keenable.ai?tenant=x", "https://api.keenable.ai#section"} {
		_, err := keenable.New(&keenable.Options{BaseURL: &raw})
		if !errors.As(err, new(*keenable.InvalidRequestError)) {
			t.Fatalf("%q: %v", raw, err)
		}
	}
	for _, raw := range []string{"http://127.0.0.1:9", "http://localhost:8000", "http://[::1]:8000", "https://api.keenable.ai"} {
		c, err := keenable.New(&keenable.Options{BaseURL: &raw})
		if err != nil {
			t.Fatalf("%q: %v", raw, err)
		}
		c.Close()
	}
}

func TestRunToolCall(t *testing.T) {
	c, seen := startKeyless(t, routed(), nil)
	searched, err := keenable.RunToolCall(context.Background(), c, "keenable_search", `{"query":"wafer scale","site":"cerebras.ai"}`)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(searched, "[1] How Cerebras works") {
		t.Fatal(searched)
	}
	if payloadOf(t, (*seen)[0])["site"] != "cerebras.ai" {
		t.Fatal(payloadOf(t, (*seen)[0]))
	}

	fetched, err := keenable.RunToolCall(context.Background(), c, "keenable_fetch", map[string]any{"url": "https://example.com"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(fetched, "[1] Example Domain (https://example.com/)") {
		t.Fatal(fetched)
	}

	if _, err := keenable.RunToolCall(context.Background(), c, "keenable_search", "not json"); !errors.As(err, new(*keenable.InvalidRequestError)) {
		t.Fatal(err)
	}
	if _, err := keenable.RunToolCall(context.Background(), c, "nope", "{}"); !errors.As(err, new(*keenable.InvalidRequestError)) {
		t.Fatal(err)
	}
	var syntax *json.SyntaxError
	if _, err := keenable.RunToolCall(context.Background(), c, "keenable_search", "not json"); errors.As(err, &syntax) {
		t.Fatal("leaked json.SyntaxError")
	}
}

func TestToolArgumentTypes(t *testing.T) {
	c, _ := startKeyless(t, routed(), nil)
	for _, args := range []any{123, nil, []any{}, true} {
		_, err := keenable.RunToolCall(context.Background(), c, "keenable_search", args)
		if !errors.As(err, new(*keenable.InvalidRequestError)) {
			t.Fatalf("%#v: %v", args, err)
		}
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) {
			t.Fatalf("%#v leaked json.SyntaxError", args)
		}
	}
}

func TestToolCallForwardsOnlySchemaFilters(t *testing.T) {
	c, seen := startKeyless(t, routed(), nil)
	props := searchToolProperties(t)
	args := map[string]any{"query": "q", "acquired_after": "2026-01-01"}
	for name, raw := range props {
		if name == "query" {
			continue
		}
		prop, _ := raw.(map[string]any)
		if prop["type"] == "integer" {
			args[name] = 10
		} else {
			args[name] = "value"
		}
	}
	if _, err := keenable.RunToolCall(context.Background(), c, "keenable_search", args); err != nil {
		t.Fatal(err)
	}
	payload := payloadOf(t, one(t, seen))
	if _, ok := payload["acquired_after"]; ok {
		t.Fatal("acquired_after is not in the tool schema")
	}
	for name := range props {
		if name == "query" {
			continue
		}
		if _, ok := payload[name]; !ok {
			t.Fatalf("schema filter %s was not forwarded: %#v", name, payload)
		}
	}
	if _, ok := props["site"]; !ok {
		t.Fatal("site should be tool-exposed")
	}
	if _, ok := props["published_after"]; !ok {
		t.Fatal("published_after should be tool-exposed")
	}
	if _, ok := props["acquired_after"]; ok {
		t.Fatal("acquired_after should not be in the schema")
	}
}

func TestTimeoutCoversSlowBody(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		time.Sleep(2 * time.Second)
		_, _ = w.Write([]byte(`{"query":"q","results":[]}`))
	})
	timeout := 40 * time.Millisecond
	c, _ := startKeyless(t, h, &keenable.Options{Timeout: timeout})
	_, err := c.Search(context.Background(), "q", nil)
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) {
		t.Fatal(err)
	}
	if errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("client timeout should be a ConnectionError, not the caller context")
	}
	if !strings.Contains(err.Error(), timeout.String()) {
		t.Fatal(err)
	}
}

func TestCallerCancelIsNotConnectionError(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	})
	c, _ := startKeyless(t, h, &keenable.Options{Timeout: 5 * time.Second})
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(20 * time.Millisecond)
		cancel()
	}()
	_, err := c.Search(ctx, "q", nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if errors.As(err, new(*keenable.ConnectionError)) {
		t.Fatal("canceled context became ConnectionError")
	}
}

func TestSlowBodyInsideDeadline(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(30 * time.Millisecond)
		jsonHandler(http.StatusOK, searchBody).ServeHTTP(w, r)
	})
	c, _ := startKeyless(t, h, &keenable.Options{Timeout: 2 * time.Second})
	resp, err := c.Search(context.Background(), "q", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(resp.Results) != 2 {
		t.Fatalf("len %d", len(resp.Results))
	}
}

func TestErrorCarriesCodeAndRequestID(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-Id", "req_test")
		w.Header().Set("X-RateLimit-Limit", "1000")
		w.Header().Set("X-RateLimit-Remaining", "0")
		w.Header().Set("X-RateLimit-Reset", "2026-10-28T14:52:48.084Z")
		jsonHandler(http.StatusTooManyRequests, map[string]any{"message": "hourly cap reached"}).ServeHTTP(w, r)
	})
	c, _ := startKeyless(t, h, nil)
	_, err := c.Search(context.Background(), "q", nil)
	var rate *keenable.RateLimitError
	if !errors.As(err, &rate) {
		t.Fatal(err)
	}
	if rate.Code() != keenable.CodeRateLimit || rate.RequestID != "req_test" || rate.Reset == "" || rate.Limit != 1000 {
		t.Fatalf("%s limit=%d reset=%q id=%q", err, rate.Limit, rate.Reset, rate.RequestID)
	}
	if !strings.Contains(err.Error(), "req_test") || !strings.Contains(err.Error(), "Retry after 2026-10-28T14:52:48.084Z") || !strings.Contains(err.Error(), "(rate_limit)") {
		t.Fatal(err)
	}
	var sdk keenable.Error
	if !errors.As(err, &sdk) || sdk.Code() != keenable.CodeRateLimit {
		t.Fatal(err)
	}
}

func TestNilClientDoesNotPanic(t *testing.T) {
	var client *keenable.Client
	if client.Keyless() {
		t.Fatal("nil client is not keyless")
	}
	if _, err := client.Search(context.Background(), "q", nil); !errors.As(err, new(*keenable.InvalidRequestError)) {
		t.Fatal(err)
	}
	if _, err := client.Fetch(context.Background(), "https://example.com"); !errors.As(err, new(*keenable.InvalidRequestError)) {
		t.Fatal(err)
	}
	if (*keenable.SearchResponse)(nil).ToContext(nil) != "" {
		t.Fatal("nil response should render nothing")
	}
	if (*keenable.SearchResponse)(nil).Cited(nil) != nil {
		t.Fatal("nil response has no citations")
	}
	if (*keenable.Page)(nil).ToContext(nil) != "" {
		t.Fatal("nil page should render nothing")
	}
}

func TestCustomHTTPClientTimeoutIsTheDeadlineWeName(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		jsonHandler(http.StatusOK, searchBody).ServeHTTP(w, r)
	})
	optsTimeout := 5 * time.Second
	httpTimeout := 40 * time.Millisecond
	c, _ := startKeyless(t, h, &keenable.Options{
		Timeout:    optsTimeout,
		HTTPClient: &http.Client{Timeout: httpTimeout},
	})
	_, err := c.Search(context.Background(), "q", nil)
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) {
		t.Fatal(err)
	}
	if !strings.Contains(err.Error(), httpTimeout.String()) || !strings.Contains(err.Error(), "http.Client") {
		t.Fatal(err)
	}
	if strings.Contains(err.Error(), optsTimeout.String()) || strings.Contains(err.Error(), "pass a context") {
		t.Fatal(err)
	}
}

func TestSuppliedClientStillHonorsOptionsTimeout(t *testing.T) {
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(2 * time.Second)
		jsonHandler(http.StatusOK, searchBody).ServeHTTP(w, r)
	})
	timeout := 40 * time.Millisecond
	hc := &http.Client{}
	c, _ := startKeyless(t, h, &keenable.Options{
		Timeout:    timeout,
		HTTPClient: hc,
	})
	_, err := c.Search(context.Background(), "q", nil)
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) || !strings.Contains(err.Error(), timeout.String()) || !strings.Contains(err.Error(), "Options.Timeout") {
		t.Fatal(err)
	}
	if hc.Timeout != 0 || hc.CheckRedirect != nil {
		t.Fatal("New mutated the supplied http.Client")
	}
}

func TestBaseURLPathIsPreserved(t *testing.T) {
	seen, handler := capture(jsonHandler(http.StatusOK, searchBody))
	srv := httptest.NewServer(handler)
	t.Cleanup(srv.Close)
	base := srv.URL + "/prefix"
	empty := ""
	c, err := keenable.New(&keenable.Options{BaseURL: &base, APIKey: &empty})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	if _, err := c.Search(context.Background(), "q", nil); err != nil {
		t.Fatal(err)
	}
	if got := one(t, seen).Path; got != "/prefix/v1/search/public" {
		t.Fatal(got)
	}
}

func TestCrossHostRedirectDoesNotSendTheAPIKey(t *testing.T) {
	var hits int
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if r.Header.Get("X-API-Key") != "" {
			t.Error("API key was forwarded")
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"query":"q","results":[]}`))
	}))
	t.Cleanup(other.Close)

	api := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/stolen", http.StatusTemporaryRedirect)
	}))
	t.Cleanup(api.Close)

	key := "keen_secret"
	base := api.URL
	userCalled := false
	hc := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		userCalled = true
		return nil
	}}
	c, err := keenable.New(&keenable.Options{APIKey: &key, BaseURL: &base, HTTPClient: hc})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	_, err = c.Search(context.Background(), "q", nil)
	if hits != 0 {
		t.Fatalf("followed the redirect, hits=%d", hits)
	}
	if userCalled {
		t.Fatal("caller CheckRedirect ran for a cross-host redirect")
	}
	if err == nil || strings.Contains(err.Error(), key) || !strings.Contains(err.Error(), "redirect") {
		t.Fatal(err)
	}
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) {
		t.Fatal(err)
	}
}

func TestSameHostRedirectKeepsTheAPIKey(t *testing.T) {
	var saw string
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("ok") == "" {
			http.Redirect(w, r, srv.URL+r.URL.Path+"?ok=1", http.StatusTemporaryRedirect)
			return
		}
		saw = r.Header.Get("X-API-Key")
		jsonHandler(http.StatusOK, searchBody).ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	key := "keen_secret"
	base := srv.URL
	c, err := keenable.New(&keenable.Options{APIKey: &key, BaseURL: &base})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	if _, err := c.Search(context.Background(), "q", nil); err != nil {
		t.Fatal(err)
	}
	if saw != key {
		t.Fatalf("same-host redirect dropped the key: %q", saw)
	}
}

func TestKeyedRateLimitDoesNotAskForAKey(t *testing.T) {
	var sawKey string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawKey = r.Header.Get("X-API-Key")
		jsonHandler(http.StatusTooManyRequests, map[string]any{"message": "slow down"}).ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	key := "keen_test"
	base := srv.URL
	c, err := keenable.New(&keenable.Options{APIKey: &key, BaseURL: &base})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	_, err = c.Search(context.Background(), "q", nil)
	if sawKey != key {
		t.Fatalf("request key %q", sawKey)
	}
	var rate *keenable.RateLimitError
	if !errors.As(err, &rate) || strings.Contains(err.Error(), "KEENABLE_API_KEY") || !strings.Contains(err.Error(), "window") {
		t.Fatal(err)
	}
}

func TestLocalErrorsNameTheFix(t *testing.T) {
	c, _ := startKeyless(t, jsonHandler(http.StatusOK, searchBody), nil)
	_, err := c.Search(context.Background(), "  ", nil)
	if !strings.Contains(err.Error(), "query argument") {
		t.Fatal(err)
	}
	_, err = c.Fetch(context.Background(), "http://127.0.0.1/")
	if !strings.Contains(err.Error(), "public http(s) URL") {
		t.Fatal(err)
	}
	_, err = keenable.RunToolCall(context.Background(), c, "nope", "{}")
	if !strings.Contains(err.Error(), "keenable_search") {
		t.Fatal(err)
	}
}

func searchToolProperties(t *testing.T) map[string]any {
	t.Helper()
	raw, err := json.Marshal(keenable.SearchTool)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Function struct {
			Parameters struct {
				Properties map[string]any `json:"properties"`
			} `json:"parameters"`
		} `json:"function"`
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Function.Parameters.Properties
}

func titles(results []keenable.SearchResult) string {
	names := make([]string, len(results))
	for i, r := range results {
		names[i] = r.Title
	}
	return strings.Join(names, "|")
}

func intPtr(n int) *int { return &n }
