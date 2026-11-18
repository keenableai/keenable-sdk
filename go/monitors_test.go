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
	"agent_run_id": nil, "backfill": nil,
	"schedule":      map[string]any{"type": "cron", "value": "0 9 * * 1-5", "timezone": "Europe/Paris"},
	"output_schema": nil,
	"webhook":       map[string]any{"url": "https://hooks.example.com/k", "events": []string{"monitor.hit"}, "secret": "whsec_abc"},
	"metadata":      map[string]any{"team": "research"},
	"memory_scope":  nil, "estimated_cost_usd": nil, "cost_this_month_usd": nil,
	"last_run_at": nil, "next_run_at": "2026-11-18T08:00:00Z",
	"upcoming_runs": []string{"2026-11-18T08:00:00Z"},
	"created_at":    "2026-11-17T10:00:00Z", "updated_at": "2026-11-17T10:00:00Z",
}

var resultBody = map[string]any{
	"url": "https://example.org/a", "title": "A model", "author": nil,
	"published_at": "2026-11-17T09:00:00Z", "acquired_at": "2026-11-17T09:05:00Z",
	"image": nil, "favicon": nil, "highlights": nil, "matched_at": "2026-11-17T09:10:00Z",
	"published_at_source": "declared", "summary": "A lab released a model.", "importance": 4,
	"kind": "news", "source_type": "original", "score": 0.7,
}

var runBody = map[string]any{
	"id": "mrun_1", "object": "monitor_run", "monitor_id": "mon_1", "status": "completed",
	"results": []any{resultBody}, "changes": nil,
	"output": map[string]any{"structured": map[string]any{"n": 1}, "text": nil, "grounding": []any{}},
	"error":  nil, "usage": nil, "created_at": "2026-11-17T10:00:00Z",
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
		Webhook:  &keenable.MonitorWebhookParams{URL: "https://hooks.example.com/k", Events: []string{"monitor.hit"}},
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
		"webhook":  map[string]any{"url": "https://hooks.example.com/k", "events": []any{"monitor.hit"}},
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
	if m.EstimatedCostUSD != nil || len(m.UpcomingRuns) != 1 || m.Raw["id"] != "mon_1" {
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
		"id": "evt_1", "type": "monitor.hit", "url": "https://hooks.example.com/k",
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
	pages, err := c.Monitors.Pages(ctx, "mon_1", &keenable.MonitorPagesParams{MinImportance: 4})
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
		"/v1/monitors/mon_1/runs", "/v1/monitors/mon_1/runs/mrun_1", "/v1/monitors/mon_1/hits",
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
	if *pages.Data[0].ID != "h1" || *pages.Data[0].SameStory != 2 || *pages.Data[0].SourceType != "original" {
		t.Fatalf("pages %+v", pages.Data[0])
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

const webhookBody = `{"id":"msg_2nY8kTestVector01","type":"monitor.hit","created_at":"2026-11-17T17:20:00Z","data":{"monitor_id":"mon_test01","result":{"url":"https://example.com/news/1","title":"Open weights model released","author":null,"published_at":"2026-11-17T16:00:00Z","acquired_at":"2026-11-17T16:05:00Z","image":null,"favicon":null,"highlights":null,"matched_at":"2026-11-17T16:10:00Z","published_at_source":"declared","summary":"A lab released an open-weights model.","importance":4,"kind":"news","source_type":"original","score":0.82}},"metadata":{"team":"research"}}`

func webhookHeaders() http.Header {
	h := http.Header{}
	h.Set("webhook-id", "msg_2nY8kTestVector01")
	h.Set("webhook-timestamp", "1763400000")
	h.Set("webhook-signature", "v1,9+ChBZb9nSbPYLix6nY+Pd+ykv10PwAjK5TDBLb2qp4=")
	return h
}

func TestVerifyWebhookKnownVector(t *testing.T) {
	event, err := keenable.VerifyWebhook([]byte(webhookBody), webhookHeaders(),
		"whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE=", &keenable.WebhookOptions{Now: time.Unix(1763400000, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if event.ID != "msg_2nY8kTestVector01" || event.Type != "monitor.hit" || event.Data.MonitorID != "mon_test01" {
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
