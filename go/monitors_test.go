package keenable_test

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/keenableai/keenable-sdk/go"
)

var monitorBody = map[string]any{
	"id":     "mon_1",
	"object": "monitor",
	"name":   "LLM releases",
	"status": "active",
	"search": map[string]any{
		"query": "new open-weights LLM releases", "max_results": 10, "include_domains": nil,
		"exclude_domains": []string{"example.com"}, "content": map[string]any{"text": true},
	},
	"schedule":      map[string]any{"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
	"output_schema": nil,
	"webhook":       map[string]any{"url": "https://hooks.example.com/k", "events": []string{"monitor.result.found"}, "secret": "whsec_abc"},
	"metadata":      map[string]any{"team": "research"},
	"last_run_at":   nil, "next_run_at": "2026-11-18T08:00:00Z",
	"upcoming_runs": []string{"2026-11-18T08:00:00Z"},
	"created_at":    "2026-11-17T10:00:00Z", "updated_at": "2026-11-17T10:00:00Z",
}

var resultBody = map[string]any{
	"url": "https://example.org/a", "title": "A model", "author": nil,
	"published_at": "2026-11-17T09:00:00Z", "acquired_at": "2026-11-17T09:05:00Z",
	"image": nil, "matched_at": "2026-11-17T09:10:00Z",
	"published_at_source": "declared", "summary": "A lab released a model.", "importance": 4,
	"kind": "news", "source_type": "original",
}

var runBody = map[string]any{
	"id": "mrun_1", "object": "monitor_run", "monitor_id": "mon_1", "status": "completed",
	"results": []any{resultBody}, "changes": nil,
	"output": map[string]any{"structured": map[string]any{"n": 1}, "text": nil, "grounding": []any{}},
	"error":  nil, "created_at": "2026-11-17T10:00:00Z",
	"started_at": "2026-11-17T10:00:01Z", "ended_at": "2026-11-17T10:00:09Z",
}

type monitorRequest struct {
	Method  string
	Path    string
	RawPath string
	Query   url.Values
	Header  http.Header
	Body    map[string]any
}

type mreply struct {
	status int
	body   any
}

func monitorServer(t *testing.T, key string, replies ...mreply) (*keenable.Client, *[]monitorRequest) {
	t.Helper()
	var mu sync.Mutex
	seen := &[]monitorRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		mu.Lock()
		*seen = append(*seen, monitorRequest{r.Method, r.URL.Path, r.URL.EscapedPath(), r.URL.Query(), r.Header.Clone(), body})
		n := len(*seen)
		mu.Unlock()
		rep := replies[min(n, len(replies))-1]
		out, _ := json.Marshal(rep.body)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(rep.status)
		_, _ = w.Write(out)
	}))
	t.Cleanup(srv.Close)
	base := srv.URL
	retries := 2
	c, err := keenable.New(&keenable.Options{APIKey: &key, BaseURL: &base, MaxRetries: &retries})
	if err != nil {
		t.Fatal(err)
	}
	return c, seen
}

func TestMonitorsCreate(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{201, monitorBody})
	text := true
	m, err := c.Monitors.Create(context.Background(), &keenable.MonitorCreateParams{
		Search:   keenable.MonitorSearchParams{Query: "new open-weights LLM releases", ExcludeDomains: []string{"x.com"}, ContentText: &text},
		Name:     "LLM releases",
		Schedule: &keenable.MonitorScheduleParams{Type: "cron", Value: "0 9 * * 1-5", Timezone: "Europe/Paris"},
		Webhook:  &keenable.MonitorWebhookParams{URL: "https://hooks.example.com/k", Events: []string{"monitor.result.found"}},
		Metadata: map[string]string{"team": "research"},
	})
	if err != nil {
		t.Fatal(err)
	}
	req := (*seen)[0]
	if req.Method != "POST" || req.Path != "/v1/monitors" || req.Header.Get("X-API-Key") != "k" {
		t.Fatalf("request %+v", req)
	}
	if len(req.Header.Get("Idempotency-Key")) != 36 {
		t.Fatalf("Idempotency-Key %q", req.Header.Get("Idempotency-Key"))
	}
	want := map[string]any{
		"search": map[string]any{
			"query": "new open-weights LLM releases", "exclude_domains": []any{"x.com"},
			"content": map[string]any{"text": true},
		},
		"name":     "LLM releases",
		"schedule": map[string]any{"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
		"webhook":  map[string]any{"url": "https://hooks.example.com/k", "events": []any{"monitor.result.found"}},
		"metadata": map[string]any{"team": "research"},
	}
	if !reflect.DeepEqual(req.Body, want) {
		t.Fatalf("body %v", req.Body)
	}
	if m.ID != "mon_1" || !m.Search.ContentText || m.Search.ExcludeDomains[0] != "example.com" {
		t.Fatalf("monitor %+v", m)
	}
	if m.Webhook == nil || m.Webhook.Secret == nil || *m.Webhook.Secret != "whsec_abc" {
		t.Fatalf("webhook %+v", m.Webhook)
	}
	if m.Schedule == nil || *m.Schedule.Timezone != "Europe/Paris" || m.Metadata["team"] != "research" {
		t.Fatalf("monitor %+v", m)
	}
	if len(m.UpcomingRuns) != 1 || m.Raw["id"] != "mon_1" {
		t.Fatalf("monitor %+v", m)
	}
}

func TestMonitorsCreateRetriesWithTheSameKey(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{503, map[string]any{"retry_after_seconds": 0}}, mreply{201, monitorBody})
	_, err := c.Monitors.Create(context.Background(), &keenable.MonitorCreateParams{
		Search: keenable.MonitorSearchParams{Query: "q"}, IdempotencyKey: "key-1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 2 || (*seen)[0].Header.Get("Idempotency-Key") != "key-1" || (*seen)[1].Header.Get("Idempotency-Key") != "key-1" {
		t.Fatalf("requests %+v", *seen)
	}
}

func TestMonitorsCreateNeedsAQuery(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{201, monitorBody})
	_, err := c.Monitors.Create(context.Background(), &keenable.MonitorCreateParams{})
	var bad *keenable.InvalidRequestError
	if !errors.As(err, &bad) || len(*seen) != 0 {
		t.Fatalf("err %v, %d requests", err, len(*seen))
	}
}

func TestMonitorsNeedAKey(t *testing.T) {
	t.Setenv("KEENABLE_API_KEY", "")
	c, seen := monitorServer(t, "", mreply{200, monitorBody})
	_, err := c.Monitors.Get(context.Background(), "mon_1", nil)
	var auth *keenable.AuthError
	if !errors.As(err, &auth) || auth.APICode != "missing_api_key" || len(*seen) != 0 {
		t.Fatalf("err %v, %d requests", err, len(*seen))
	}
}

func TestMonitorsListAll(t *testing.T) {
	second := map[string]any{}
	for k, v := range monitorBody {
		second[k] = v
	}
	second["id"] = "mon_2"
	c, seen := monitorServer(t, "k",
		mreply{200, map[string]any{"data": []any{monitorBody}, "has_more": true, "next_cursor": "c1"}},
		mreply{200, map[string]any{"data": []any{second}, "has_more": false, "next_cursor": nil}},
	)
	it := c.Monitors.ListAll(context.Background(), &keenable.MonitorListParams{
		Status: "active", Limit: 1, Metadata: map[string]string{"team": "research"},
	})
	var ids []string
	for it.Next() {
		ids = append(ids, it.Monitor().ID)
	}
	if err := it.Err(); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(ids, []string{"mon_1", "mon_2"}) {
		t.Fatalf("ids %v", ids)
	}
	q := (*seen)[0].Query
	if q.Get("status") != "active" || q.Get("limit") != "1" || q.Get("metadata[team]") != "research" || q.Get("cursor") != "" {
		t.Fatalf("query %v", q)
	}
	if (*seen)[1].Query.Get("cursor") != "c1" {
		t.Fatalf("query %v", (*seen)[1].Query)
	}
}

func TestMonitorsPathsGetAndDelete(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{200, monitorBody})
	if _, err := c.Monitors.Get(context.Background(), "mon/1", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Monitors.Delete(context.Background(), "mon_1", nil); err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].RawPath != "/v1/monitors/mon%2F1" || (*seen)[1].Method != "DELETE" {
		t.Fatalf("requests %+v", *seen)
	}
}

func TestMonitorsUpdatePauseResume(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{200, monitorBody})
	name := "New"
	ctx := context.Background()
	if _, err := c.Monitors.Update(ctx, "mon_1", &keenable.MonitorUpdateParams{
		Name: &name, RemoveSchedule: true, Search: &keenable.MonitorSearchParams{MaxResults: 5},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Monitors.Pause(ctx, "mon_1", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Monitors.Resume(ctx, "mon_1", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Monitors.Update(ctx, "mon_1", &keenable.MonitorUpdateParams{Name: &name, RemoveName: true}); err != nil {
		t.Fatal(err)
	}
	if (*seen)[0].Method != "PATCH" {
		t.Fatalf("method %s", (*seen)[0].Method)
	}
	want := []map[string]any{
		{"name": "New", "schedule": nil, "search": map[string]any{"max_results": float64(5)}},
		{"status": "paused"},
		{"status": "active"},
		{"name": nil},
	}
	for i, w := range want {
		if !reflect.DeepEqual((*seen)[i].Body, w) {
			t.Fatalf("body %d: %v", i, (*seen)[i].Body)
		}
	}
}

func TestMonitorsUnsafeCallsAreNotRetriedOn5xx(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{503, map[string]any{"retry_after_seconds": 0}})
	ctx := context.Background()
	name := "x"
	if _, err := c.Monitors.Update(ctx, "mon_1", &keenable.MonitorUpdateParams{Name: &name}); err == nil {
		t.Fatal("want an error")
	}
	if _, err := c.Monitors.Trigger(ctx, "mon_1", nil); err == nil {
		t.Fatal("want an error")
	}
	if _, err := c.Monitors.Bulk(ctx, "pause", &keenable.MonitorBulkParams{IDs: []string{"mon_1"}}); err == nil {
		t.Fatal("want an error")
	}
	if len(*seen) != 3 {
		t.Fatalf("%d requests, want 3", len(*seen))
	}
}

func TestMonitorsTriggerIsRetriedOn429(t *testing.T) {
	queued := map[string]any{}
	for k, v := range runBody {
		queued[k] = v
	}
	queued["status"], queued["results"] = "queued", nil
	c, seen := monitorServer(t, "k", mreply{429, map[string]any{"retry_after_seconds": 0}}, mreply{200, queued})
	run, err := c.Monitors.Trigger(context.Background(), "mon_1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 2 || (*seen)[0].Path != "/v1/monitors/mon_1/trigger" || run.Status != "queued" || run.Results != nil {
		t.Fatalf("run %+v, %d requests", run, len(*seen))
	}
}

func TestMonitorsReads(t *testing.T) {
	hit := map[string]any{}
	for k, v := range resultBody {
		hit[k] = v
	}
	hit["id"], hit["same_story"] = "h1", 2
	delivery := map[string]any{
		"id": "evt_1", "type": "monitor.result.found", "url": "https://hooks.example.com/k",
		"created_at": "2026-11-17T10:00:00Z", "attempts": 2, "delivered_at": nil,
		"last_error": "HTTP 500", "next_attempt_at": nil,
	}
	page := func(items ...any) map[string]any {
		return map[string]any{"data": items, "has_more": false, "next_cursor": nil}
	}
	c, seen := monitorServer(t, "k",
		mreply{200, page(runBody)},
		mreply{200, runBody},
		mreply{200, page(hit)},
		mreply{200, page(delivery)},
		mreply{200, map[string]any{"total": 3, "by_status": map[string]any{"active": 2}, "by_schedule": map[string]any{"manual": 3}}},
		mreply{200, map[string]any{"action": "pause", "affected": 1, "ids": []string{"mon_1"}, "dry_run": true, "has_more": false, "not_found": []string{"mon_x"}}},
	)
	ctx := context.Background()
	runs, err := c.Monitors.Runs(ctx, "mon_1", &keenable.MonitorPageParams{Limit: 5, Cursor: "r0"})
	if err != nil {
		t.Fatal(err)
	}
	run, err := c.Monitors.Run(ctx, "mon_1", "mrun_1", nil)
	if err != nil {
		t.Fatal(err)
	}
	results, err := c.Monitors.Results(ctx, "mon_1", &keenable.MonitorResultsParams{MinImportance: 4})
	if err != nil {
		t.Fatal(err)
	}
	deliveries, err := c.Monitors.Deliveries(ctx, "mon_1", nil)
	if err != nil {
		t.Fatal(err)
	}
	stats, err := c.Monitors.Stats(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	result, err := c.Monitors.Bulk(ctx, "pause", &keenable.MonitorBulkParams{IDs: []string{"mon_1", "mon_x"}, Filter: &keenable.BulkFilter{Status: "active"}})
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for _, r := range *seen {
		paths = append(paths, r.Path)
	}
	wantPaths := []string{
		"/v1/monitors/mon_1/runs", "/v1/monitors/mon_1/runs/mrun_1", "/v1/monitors/mon_1/results",
		"/v1/monitors/mon_1/deliveries", "/v1/monitors/stats", "/v1/monitors/bulk",
	}
	if !reflect.DeepEqual(paths, wantPaths) {
		t.Fatalf("paths %v", paths)
	}
	if (*seen)[0].Query["limit"][0] != "5" || (*seen)[0].Query["cursor"][0] != "r0" || (*seen)[2].Query["min_importance"][0] != "4" {
		t.Fatalf("queries %v %v", (*seen)[0].Query, (*seen)[2].Query)
	}
	wantBulk := map[string]any{"action": "pause", "dry_run": true, "ids": []any{"mon_1", "mon_x"}, "filter": map[string]any{"status": "active"}}
	if !reflect.DeepEqual((*seen)[5].Body, wantBulk) {
		t.Fatalf("bulk body %v", (*seen)[5].Body)
	}
	if runs.Data[0].MonitorID != "mon_1" || *run.Results[0].Importance != 4 || run.Output.Structured.(map[string]any)["n"] != float64(1) {
		t.Fatalf("run %+v", run)
	}
	if *results.Data[0].ID != "h1" || *results.Data[0].SameStory != 2 || *results.Data[0].SourceType != "original" {
		t.Fatalf("results %+v", results.Data[0])
	}
	if *deliveries.Data[0].LastError != "HTTP 500" || stats.ByStatus["active"] != 2 || result.NotFound[0] != "mon_x" || !result.DryRun {
		t.Fatalf("deliveries %+v stats %+v bulk %+v", deliveries, stats, result)
	}
}

func TestMonitorsBulkChecksItsArguments(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{200, map[string]any{}})
	ctx := context.Background()
	if _, err := c.Monitors.Bulk(ctx, "archive", &keenable.MonitorBulkParams{IDs: []string{"mon_1"}}); err == nil {
		t.Fatal("want an error")
	}
	if _, err := c.Monitors.Bulk(ctx, "pause", nil); err == nil {
		t.Fatal("want an error")
	}
	if len(*seen) != 0 {
		t.Fatalf("%d requests", len(*seen))
	}
}

const webhookBody = `{"id":"msg_2nY8kTestVector01","type":"monitor.result.found","created_at":"2026-11-17T17:20:00Z","data":{"monitor_id":"mon_test01","result":{"url":"https://example.com/news/1","title":"Open weights model released","author":null,"published_at":"2026-11-17T16:00:00Z","acquired_at":"2026-11-17T16:05:00Z","image":null,"matched_at":"2026-11-17T16:10:00Z","published_at_source":"declared","summary":"A lab released an open-weights model.","importance":4,"kind":"news","source_type":"original"}},"metadata":{"team":"research"}}`

func webhookHeaders() http.Header {
	h := http.Header{}
	h.Set("webhook-id", "msg_2nY8kTestVector01")
	h.Set("webhook-timestamp", "1763400000")
	h.Set("webhook-signature", "v1,ifN2KIni7msErjuVooGtcP9OlWfUymaJfl41PUpTBMc=")
	return h
}

func TestVerifyWebhookKnownVector(t *testing.T) {
	event, err := keenable.VerifyWebhook([]byte(webhookBody), webhookHeaders(),
		"whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE=", &keenable.WebhookOptions{Now: time.Unix(1763400000, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if event.ID != "msg_2nY8kTestVector01" || event.Type != "monitor.result.found" || event.Data.MonitorID != "mon_test01" {
		t.Fatalf("event %+v", event)
	}
	if event.Data.Result == nil || event.Data.Result.URL != "https://example.com/news/1" || *event.Data.Result.Importance != 4 {
		t.Fatalf("result %+v", event.Data.Result)
	}
	if event.Metadata["team"] != "research" || event.Raw["id"] != "msg_2nY8kTestVector01" {
		t.Fatalf("event %+v", event)
	}
}

func TestVerifyWebhookRefusesAStaleDeliveryByTheClock(t *testing.T) {
	_, err := keenable.VerifyWebhook([]byte(webhookBody), webhookHeaders(),
		"whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE=", nil)
	var bad *keenable.WebhookVerificationError
	if !errors.As(err, &bad) || bad.Code() != keenable.CodeWebhookVerification {
		t.Fatalf("err %v", err)
	}
}

func TestMonitorsDotIDsAreRefused(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{200, monitorBody})
	ctx := context.Background()
	for _, id := range []string{".", ".."} {
		var bad *keenable.InvalidRequestError
		if _, err := c.Monitors.Get(ctx, id, nil); !errors.As(err, &bad) {
			t.Fatalf("Get(%q) err %v", id, err)
		}
		if _, err := c.Monitors.Delete(ctx, id, nil); !errors.As(err, &bad) {
			t.Fatalf("Delete(%q) err %v", id, err)
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("%d requests, want 0", len(*seen))
	}
}

func TestVerifyWebhookRefusesAnEmptyKeyAndALongTimestamp(t *testing.T) {
	opts := &keenable.WebhookOptions{Now: time.Unix(1763400000, 0)}
	var bad *keenable.WebhookVerificationError
	if _, err := keenable.VerifyWebhook([]byte(webhookBody), webhookHeaders(), "whsec_", opts); !errors.As(err, &bad) {
		t.Fatalf("empty key: err %v", err)
	}
	h := webhookHeaders()
	h.Set("webhook-timestamp", strings.Repeat("1", 400))
	_, err := keenable.VerifyWebhook([]byte(webhookBody), h, "whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE=", opts)
	if !errors.As(err, &bad) || !strings.Contains(err.Error(), "not a Unix time") {
		t.Fatalf("long timestamp: err %v", err)
	}
}

var previewResultBody = map[string]any{
	"title":        "Example Labs releases a 70B open-weights model",
	"url":          "https://example.com/news/example-70b",
	"published_at": "2026-11-24T08:12:00Z",
}

func TestMonitorsPreviewSearch(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{200, map[string]any{
		"type": "search",
		"results": []any{previewResultBody, map[string]any{
			"title": nil, "url": "https://example.com/b", "published_at": nil,
		}},
		"page": nil,
	}})
	preview, err := c.Monitors.Preview(context.Background(), &keenable.MonitorPreviewParams{
		Search: keenable.MonitorSearchParams{Query: "open-weights LLM releases", ExcludeDomains: []string{"example.org"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	req := (*seen)[0]
	if req.Method != http.MethodPost || req.Path != "/v1/monitors/preview" || req.Header.Get("Idempotency-Key") != "" {
		t.Fatalf("request %+v", req)
	}
	want := map[string]any{"search": map[string]any{"query": "open-weights LLM releases", "exclude_domains": []any{"example.org"}}}
	if !reflect.DeepEqual(req.Body, want) {
		t.Fatalf("body %v", req.Body)
	}
	if preview.Type != "search" || preview.Page != nil || len(preview.Results) != 2 {
		t.Fatalf("preview %+v", preview)
	}
	first, second := preview.Results[0], preview.Results[1]
	if first.URL != "https://example.com/news/example-70b" || first.PublishedAt == nil || *first.PublishedAt != "2026-11-24T08:12:00Z" || first.Title == nil {
		t.Fatalf("first %+v", first)
	}
	if second.Title != nil || second.PublishedAt != nil {
		t.Fatalf("second %+v", second)
	}
}

func TestMonitorsPreviewPage(t *testing.T) {
	c, seen := monitorServer(t, "k",
		mreply{200, map[string]any{"type": "page", "results": []any{}, "page": map[string]any{
			"url": "https://example.com/pricing", "title": "Pricing", "excerpt": "Plans start at $20", "source": "live", "error": nil,
		}}},
		mreply{200, map[string]any{"type": "page", "results": []any{}, "page": map[string]any{
			"url": "https://example.com/gone", "title": nil, "excerpt": nil, "source": nil, "error": "HTTP 404",
		}}},
	)
	ctx := context.Background()
	preview, err := c.Monitors.Preview(ctx, &keenable.MonitorPreviewParams{Type: "page", Page: &keenable.MonitorPageTarget{URL: "https://example.com/pricing"}})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"type": "page", "page": map[string]any{"url": "https://example.com/pricing"}}
	if !reflect.DeepEqual((*seen)[0].Body, want) {
		t.Fatalf("body %v", (*seen)[0].Body)
	}
	if preview.Type != "page" || len(preview.Results) != 0 || preview.Page == nil {
		t.Fatalf("preview %+v", preview)
	}
	if p := preview.Page; p.Source == nil || *p.Source != "live" || p.Excerpt == nil || *p.Excerpt != "Plans start at $20" || p.Error != nil {
		t.Fatalf("page %+v", p)
	}
	gone, err := c.Monitors.Preview(ctx, &keenable.MonitorPreviewParams{Type: "page", Page: &keenable.MonitorPageTarget{URL: "https://example.com/gone"}})
	if err != nil {
		t.Fatal(err)
	}
	if p := gone.Page; p == nil || p.Error == nil || *p.Error != "HTTP 404" || p.Title != nil || p.Source != nil || p.Excerpt != nil {
		t.Fatalf("gone %+v", p)
	}
}

func TestMonitorsPreviewChecksItsArguments(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{200, map[string]any{}})
	page := &keenable.MonitorPageTarget{URL: "https://example.com"}
	for _, params := range []*keenable.MonitorPreviewParams{
		nil,
		{},
		{Search: keenable.MonitorSearchParams{Query: " "}},
		{Type: "page"},
		{Type: "page", Page: page, Search: keenable.MonitorSearchParams{Query: "q"}},
		{Search: keenable.MonitorSearchParams{Query: "q"}, Page: page},
		{Type: "feed", Search: keenable.MonitorSearchParams{Query: "q"}},
	} {
		var invalid *keenable.InvalidRequestError
		if _, err := c.Monitors.Preview(context.Background(), params); !errors.As(err, &invalid) {
			t.Fatalf("%+v: err %v", params, err)
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("%d requests, want 0", len(*seen))
	}
}

func TestMonitorsPreviewIsRetriedOn5xx(t *testing.T) {
	c, seen := monitorServer(t, "k",
		mreply{503, map[string]any{"retry_after_seconds": 0}},
		mreply{200, map[string]any{"type": "search", "results": nil, "page": nil}},
	)
	preview, err := c.Monitors.Preview(context.Background(), &keenable.MonitorPreviewParams{Search: keenable.MonitorSearchParams{Query: "q"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(*seen) != 2 || preview.Results == nil || len(preview.Results) != 0 {
		t.Fatalf("preview %+v, %d requests", preview, len(*seen))
	}
}

func TestMonitorsTestWebhook(t *testing.T) {
	const secret = "whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE="
	c, seen := monitorServer(t, "k",
		mreply{200, map[string]any{"ok": true, "status": 204, "latency_ms": 182, "error": nil, "signed_with": "provided", "request_id": "req_1"}},
		mreply{200, map[string]any{"ok": false, "status": nil, "latency_ms": 10003, "error": "no answer within 10 s", "signed_with": "throwaway"}},
	)
	ctx := context.Background()
	ok, err := c.Monitors.TestWebhook(ctx, "https://hooks.example.com/k", &keenable.MonitorWebhookTestParams{Secret: secret})
	if err != nil {
		t.Fatal(err)
	}
	bad, err := c.Monitors.TestWebhook(ctx, "https://hooks.example.com/k", nil)
	if err != nil {
		t.Fatal(err)
	}
	if r := (*seen)[0]; r.Method != http.MethodPost || r.Path != "/v1/monitors/webhook-test" ||
		!reflect.DeepEqual(r.Body, map[string]any{"url": "https://hooks.example.com/k", "secret": secret}) {
		t.Fatalf("request %+v", r)
	}
	if !reflect.DeepEqual((*seen)[1].Body, map[string]any{"url": "https://hooks.example.com/k"}) {
		t.Fatalf("body %v", (*seen)[1].Body)
	}
	if !ok.OK || ok.Status == nil || *ok.Status != 204 || ok.LatencyMS != 182 || ok.Error != nil || ok.SignedWith != "provided" || ok.RequestID != "req_1" {
		t.Fatalf("ok %+v", ok)
	}
	if bad.OK || bad.Status != nil || bad.Error == nil || *bad.Error != "no answer within 10 s" || bad.SignedWith != "throwaway" || bad.LatencyMS != 10003 {
		t.Fatalf("bad %+v", bad)
	}
}

func TestMonitorsTestWebhookIsNotRetriedOn5xx(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{503, map[string]any{"retry_after_seconds": 0}})
	if _, err := c.Monitors.TestWebhook(context.Background(), "https://hooks.example.com/k", nil); err == nil {
		t.Fatal("want an error")
	}
	if len(*seen) != 1 {
		t.Fatalf("%d requests, want 1", len(*seen))
	}
}

func TestMonitorsTestWebhookNeedsAURL(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{200, map[string]any{}})
	var invalid *keenable.InvalidRequestError
	if _, err := c.Monitors.TestWebhook(context.Background(), " ", nil); !errors.As(err, &invalid) {
		t.Fatalf("err %v", err)
	}
	if len(*seen) != 0 {
		t.Fatalf("%d requests, want 0", len(*seen))
	}
}
