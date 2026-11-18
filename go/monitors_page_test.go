package keenable_test

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/keenableai/keenable-sdk/go"
)

func pageMonitorBody() map[string]any {
	out := map[string]any{}
	for k, v := range monitorBody {
		out[k] = v
	}
	out["id"] = "mon_p"
	out["type"] = "page"
	out["search"] = nil
	out["page"] = map[string]any{"url": "https://example.com/pricing", "watch_for": "plan prices", "sensitivity": "meaningful"}
	out["webhook"] = nil
	out["status"] = "disabled"
	out["cost_this_month_usd"] = 0.004
	out["disabled_reason"] = map[string]any{"code": "insufficient_credits", "message": "The organization is out of credits."}
	return out
}

var diffBody = map[string]any{
	"previous_at": "2026-11-17T08:00:00Z", "ratio": 0.12,
	"added": []string{"Pro: $30/month"}, "removed": []string{"Pro: $25/month"},
}

func pageRunBody() map[string]any {
	out := map[string]any{}
	for k, v := range runBody {
		out[k] = v
	}
	out["id"], out["monitor_id"], out["results"] = "mrun_p", "mon_p", []any{}
	out["changes"] = map[string]any{
		"changed": true, "notified": true, "baseline": false, "version": 3, "source": "live",
		"summary": "The Pro plan went from $25 to $30 a month.", "items": []string{"Pro: $30/month"}, "diff": diffBody,
	}
	out["output"] = map[string]any{
		"structured": nil, "text": nil, "grounding": []any{}, "fresh": false,
		"error": map[string]any{"code": "output_invalid", "message": "missing field price"},
	}
	out["usage"] = map[string]any{"runs": 1, "credits": 0.5, "cost_usd": 0.002}
	return out
}

var versionBody = map[string]any{
	"id": "ver_3", "object": "page_version", "version": 3, "fetched_at": "2026-11-18T08:00:00Z",
	"title": "Pricing", "source": "live", "notified": true,
	"summary": "The Pro plan went from $25 to $30 a month.", "items": []string{"Pro: $30/month"}, "diff": diffBody,
}

func TestMonitorsCreatePage(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{201, pageMonitorBody()})
	m, err := c.Monitors.Create(context.Background(), &keenable.MonitorCreateParams{
		Type:     "page",
		Page:     &keenable.MonitorPageTarget{URL: "https://example.com/pricing", WatchFor: "plan prices", Sensitivity: "any"},
		Schedule: &keenable.MonitorScheduleParams{Type: "interval", Value: "10m"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]any{
		"type":     "page",
		"page":     map[string]any{"url": "https://example.com/pricing", "watch_for": "plan prices", "sensitivity": "any"},
		"schedule": map[string]any{"type": "interval", "value": "10m"},
	}
	if body := (*seen)[0].Body; !reflect.DeepEqual(body, want) {
		t.Fatalf("body %v", body)
	}
	if m.Type != "page" || m.Search != nil || m.Page == nil {
		t.Fatalf("monitor %+v", m)
	}
	if *m.Page != (keenable.MonitorPageTarget{URL: "https://example.com/pricing", WatchFor: "plan prices", Sensitivity: "meaningful"}) {
		t.Fatalf("page %+v", m.Page)
	}
	if m.CostThisMonthUSD == nil || *m.CostThisMonthUSD != 0.004 {
		t.Fatalf("cost %v", m.CostThisMonthUSD)
	}
	if m.DisabledReason == nil || m.DisabledReason.Code != "insufficient_credits" {
		t.Fatalf("disabled reason %+v", m.DisabledReason)
	}
}

func TestMonitorsSearchMonitorHasNoPage(t *testing.T) {
	body := map[string]any{}
	for k, v := range monitorBody {
		body[k] = v
	}
	body["type"], body["page"], body["disabled_reason"] = "search", nil, nil
	c, seen := monitorServer(t, "k", mreply{201, body})
	m, err := c.Monitors.Create(context.Background(), &keenable.MonitorCreateParams{
		Type: "search", Search: keenable.MonitorSearchParams{Query: "q"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"type": "search", "search": map[string]any{"query": "q"}}; !reflect.DeepEqual((*seen)[0].Body, want) {
		t.Fatalf("body %v", (*seen)[0].Body)
	}
	if m.Type != "search" || m.Page != nil || m.DisabledReason != nil || m.Search == nil || m.Search.Query == "" {
		t.Fatalf("monitor %+v", m)
	}
}

func TestMonitorsCreateChecksTheKind(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{201, monitorBody})
	cases := []*keenable.MonitorCreateParams{
		{Type: "page"},
		{Type: "page", Page: &keenable.MonitorPageTarget{URL: " "}},
		{Type: "page", Page: &keenable.MonitorPageTarget{URL: "https://example.com"}, Search: keenable.MonitorSearchParams{Query: "q"}},
		{Search: keenable.MonitorSearchParams{Query: "q"}, Page: &keenable.MonitorPageTarget{URL: "https://example.com"}},
		{Type: "feed", Search: keenable.MonitorSearchParams{Query: "q"}},
	}
	for i, params := range cases {
		var bad *keenable.InvalidRequestError
		if _, err := c.Monitors.Create(context.Background(), params); !errors.As(err, &bad) {
			t.Fatalf("case %d: err %v", i, err)
		}
	}
	if len(*seen) != 0 {
		t.Fatalf("%d requests, want 0", len(*seen))
	}
}

func TestMonitorsUpdatePage(t *testing.T) {
	c, seen := monitorServer(t, "k", mreply{200, pageMonitorBody()})
	ctx := context.Background()
	if _, err := c.Monitors.Update(ctx, "mon_p", &keenable.MonitorUpdateParams{
		Page: &keenable.MonitorPageTarget{Sensitivity: "any"}, RemovePageWatchFor: true,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Monitors.Update(ctx, "mon_p", &keenable.MonitorUpdateParams{
		Page: &keenable.MonitorPageTarget{URL: "https://example.com/plans"},
	}); err != nil {
		t.Fatal(err)
	}
	if want := map[string]any{"page": map[string]any{"sensitivity": "any", "watch_for": nil}}; !reflect.DeepEqual((*seen)[0].Body, want) {
		t.Fatalf("body %v", (*seen)[0].Body)
	}
	if want := map[string]any{"page": map[string]any{"url": "https://example.com/plans"}}; !reflect.DeepEqual((*seen)[1].Body, want) {
		t.Fatalf("body %v", (*seen)[1].Body)
	}
}

func TestMonitorsPageRun(t *testing.T) {
	c, _ := monitorServer(t, "k", mreply{200, pageRunBody()})
	run, err := c.Monitors.Run(context.Background(), "mon_p", "mrun_p", nil)
	if err != nil {
		t.Fatal(err)
	}
	ch := run.Changes
	if ch == nil || !ch.Changed || !ch.Notified || ch.Baseline || *ch.Version != 3 || *ch.Source != "live" {
		t.Fatalf("changes %+v", ch)
	}
	if !reflect.DeepEqual(ch.Items, []string{"Pro: $30/month"}) || ch.Diff == nil || *ch.Diff.Ratio != 0.12 || ch.Diff.Removed[0] != "Pro: $25/month" {
		t.Fatalf("changes %+v", ch)
	}
	if run.Output == nil || run.Output.Fresh || run.Output.Error == nil || *run.Output.Error != (keenable.MonitorRunOutputError{Code: "output_invalid", Message: "missing field price"}) {
		t.Fatalf("output %+v", run.Output)
	}
	if run.Usage == nil || *run.Usage != (keenable.MonitorRunUsage{Runs: 1, Credits: 0.5, CostUSD: 0.002}) {
		t.Fatalf("usage %+v", run.Usage)
	}
}

func TestMonitorsSearchRunOutputIsFresh(t *testing.T) {
	body := map[string]any{}
	for k, v := range runBody {
		body[k] = v
	}
	c, _ := monitorServer(t, "k", mreply{200, body}, mreply{200, map[string]any{"id": "mrun_2", "output": map[string]any{"error": "output_failed"}}})
	run, err := c.Monitors.Run(context.Background(), "mon_1", "mrun_1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if run.Changes != nil || run.Usage != nil || run.Output == nil || !run.Output.Fresh || run.Output.Error != nil {
		t.Fatalf("run %+v", run)
	}
	bare, err := c.Monitors.Run(context.Background(), "mon_1", "mrun_2", nil)
	if err != nil {
		t.Fatal(err)
	}
	if bare.Output == nil || bare.Output.Error == nil || bare.Output.Error.Code != "output_failed" || bare.Output.Error.Message != "" {
		t.Fatalf("output %+v", bare.Output)
	}
}

func TestMonitorsVersions(t *testing.T) {
	first := map[string]any{}
	for k, v := range versionBody {
		first[k] = v
	}
	first["id"], first["version"], first["notified"], first["summary"], first["items"], first["diff"] = "ver_1", 1, false, nil, []string{}, nil
	c, seen := monitorServer(t, "k", mreply{200, map[string]any{"data": []any{versionBody, first}, "has_more": true, "next_cursor": "ver_1"}})
	list, err := c.Monitors.Versions(context.Background(), "mon_p", &keenable.MonitorVersionsParams{Limit: 2, Cursor: "ver_4"})
	if err != nil {
		t.Fatal(err)
	}
	req := (*seen)[0]
	if req.Method != http.MethodGet || req.Path != "/v1/monitors/mon_p/versions" || req.Query.Get("limit") != "2" || req.Query.Get("cursor") != "ver_4" {
		t.Fatalf("request %+v", req)
	}
	if !list.HasMore || list.NextCursor != "ver_1" || len(list.Data) != 2 {
		t.Fatalf("list %+v", list)
	}
	v := list.Data[0]
	if v.Version != 3 || v.Source != "live" || !v.Notified || *v.FetchedAt != "2026-11-18T08:00:00Z" || v.Diff == nil || v.Diff.Added[0] != "Pro: $30/month" {
		t.Fatalf("version %+v", v)
	}
	if list.Data[1].Diff != nil || list.Data[1].Summary != nil {
		t.Fatalf("first version %+v", list.Data[1])
	}
	var bad *keenable.InvalidRequestError
	if _, err := c.Monitors.Versions(context.Background(), "..", nil); !errors.As(err, &bad) || len(*seen) != 1 {
		t.Fatalf("err %v, %d requests", err, len(*seen))
	}
}

func TestVerifyWebhookMonitorChange(t *testing.T) {
	const secret = "whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE="
	body, _ := json.Marshal(map[string]any{
		"id": "msg_change1", "type": "monitor.change", "created_at": "2026-11-18T08:00:05Z",
		"data": map[string]any{"monitor_id": "mon_p", "run": pageRunBody()}, "metadata": nil,
	})
	key, _ := base64.StdEncoding.DecodeString(strings.TrimPrefix(secret, "whsec_"))
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte("msg_change1.1763452805." + string(body)))
	h := http.Header{}
	h.Set("webhook-id", "msg_change1")
	h.Set("webhook-timestamp", "1763452805")
	h.Set("webhook-signature", "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	event, err := keenable.VerifyWebhook(body, h, secret, &keenable.WebhookOptions{Now: time.Unix(1763452805, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if event.Type != "monitor.change" || event.Data.Run == nil || event.Data.Run.Changes == nil || event.Data.Result != nil {
		t.Fatalf("event %+v", event)
	}
	if *event.Data.Run.Changes.Summary != "The Pro plan went from $25 to $30 a month." {
		t.Fatalf("summary %q", *event.Data.Run.Changes.Summary)
	}
}

func TestMonitorTypeDefaultsToSearch(t *testing.T) {
	body := map[string]any{}
	for k, v := range monitorBody {
		body[k] = v
	}
	delete(body, "type")
	c, _ := monitorServer(t, "k", mreply{200, body})
	m, err := c.Monitors.Get(context.Background(), "mon_1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.Type != "search" {
		t.Fatalf("type %q, want search when the response leaves it out", m.Type)
	}
	if _, ok := m.Raw["type"]; ok {
		t.Fatalf("raw %v should stay as sent", m.Raw)
	}
	var list keenable.List[keenable.Monitor]
	if err := json.Unmarshal([]byte(`{"data":[{"id":"a"},{"id":"b","type":null},{"id":"c","type":"page"}]}`), &list); err != nil {
		t.Fatal(err)
	}
	if got := []string{list.Data[0].Type, list.Data[1].Type, list.Data[2].Type}; !reflect.DeepEqual(got, []string{"search", "search", "page"}) {
		t.Fatalf("types %v", got)
	}
}

func TestMonitorTypeKeepsPage(t *testing.T) {
	c, _ := monitorServer(t, "k", mreply{200, pageMonitorBody()})
	m, err := c.Monitors.Get(context.Background(), "mon_p", nil)
	if err != nil {
		t.Fatal(err)
	}
	if m.Type != "page" {
		t.Fatalf("type %q, want page", m.Type)
	}
}

func TestMonitorUnmarshalKeepsRequestIDAndRaw(t *testing.T) {
	m := keenable.Monitor{RequestID: "req_1", Raw: map[string]any{"id": "mon_1"}}
	if err := json.Unmarshal([]byte(`{"id":"mon_2"}`), &m); err != nil {
		t.Fatal(err)
	}
	if m.ID != "mon_2" || m.Type != "search" {
		t.Fatalf("decoded %q %q", m.ID, m.Type)
	}
	if m.RequestID != "req_1" || m.Raw["id"] != "mon_1" {
		t.Fatalf("lost metadata: %q %v", m.RequestID, m.Raw)
	}
}
