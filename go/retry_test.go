package keenable_test

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/keenableai/keenable-sdk/go"
)

// scripted answers attempt n with replies[n], repeating the last one.
func scripted(t *testing.T, opts *keenable.Options, replies ...http.HandlerFunc) (*keenable.Client, *atomic.Int32, *[]captured) {
	t.Helper()
	var n atomic.Int32
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		i := int(n.Add(1)) - 1
		if i >= len(replies) {
			i = len(replies) - 1
		}
		replies[i](w, r)
	})
	if opts == nil {
		opts = &keenable.Options{}
	}
	if opts.APIKey == nil {
		key := "k"
		opts.APIKey = &key
	}
	if opts.MaxRetries == nil {
		two := 2
		opts.MaxRetries = &two
	}
	keenable.TakeWaits()
	c, seen := start(t, h, opts)
	return c, &n, seen
}

func reply(status int, body string, headers ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

var (
	busy   = reply(529, `{"code":"search_overloaded","retryable":true}`)
	okBody = reply(200, `{"query":"q","results":[{"title":"t","url":"https://e.com","snippet":"s"}]}`)
)

func TestRetriesThenSucceeds(t *testing.T) {
	c, n, _ := scripted(t, nil, busy, busy, okBody)
	resp, err := c.Search(context.Background(), "q", nil)
	if err != nil {
		t.Fatalf("Search: %v", err)
	}
	if len(resp.Results) != 1 || n.Load() != 3 {
		t.Fatalf("results=%d attempts=%d", len(resp.Results), n.Load())
	}
	waits := keenable.TakeWaits()
	if len(waits) != 2 || waits[0] > 500*time.Millisecond || waits[0] < 375*time.Millisecond ||
		waits[1] > time.Second || waits[1] < 750*time.Millisecond {
		t.Fatalf("waits = %v", waits)
	}
}

func TestGivesUpAfterMaxRetries(t *testing.T) {
	c, n, _ := scripted(t, &keenable.Options{MaxRetries: intPtr(1)}, busy)
	_, err := c.Search(context.Background(), "q", nil)
	var api *keenable.APIError
	if !errors.As(err, &api) || n.Load() != 2 {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
}

func TestPerCallMaxRetriesZero(t *testing.T) {
	c, n, _ := scripted(t, nil, busy)
	opts := &keenable.SearchOptions{RequestOptions: keenable.RequestOptions{MaxRetries: intPtr(0)}}
	if _, err := c.Search(context.Background(), "q", opts); err == nil {
		t.Fatal("want an error")
	}
	if n.Load() != 1 {
		t.Fatalf("attempts = %d", n.Load())
	}
	c, n, _ = scripted(t, nil, busy)
	fo := &keenable.FetchOptions{RequestOptions: keenable.RequestOptions{MaxRetries: intPtr(0)}}
	if _, err := c.Fetch(context.Background(), "https://example.com", fo); err == nil {
		t.Fatal("want an error")
	}
	if n.Load() != 1 {
		t.Fatalf("fetch attempts = %d", n.Load())
	}
}

func TestWaitsRetryAfterHeader(t *testing.T) {
	c, _, _ := scripted(t, nil, reply(429, `{"message":"slow"}`, "Retry-After", "3"), okBody)
	if _, err := c.Search(context.Background(), "q", nil); err != nil {
		t.Fatal(err)
	}
	if waits := keenable.TakeWaits(); len(waits) != 1 || waits[0] != 3*time.Second {
		t.Fatalf("waits = %v", waits)
	}
}

func TestNeverRetriesNotRetryable(t *testing.T) {
	c, n, _ := scripted(t, nil, reply(402, `{"code":"insufficient_credits","retryable":false}`))
	_, err := c.Search(context.Background(), "q", nil)
	var credits *keenable.InsufficientCreditsError
	if !errors.As(err, &credits) || n.Load() != 1 {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
}

func TestDoesNotWaitOutHourlyCap(t *testing.T) {
	c, n, _ := scripted(t, nil, reply(429, `{"code":"public_rate_limit_hourly","retryable":true,"retry_after_seconds":1800}`))
	_, err := c.Search(context.Background(), "q", nil)
	var rl *keenable.RateLimitError
	if !errors.As(err, &rl) || rl.RetryAfter != 30*time.Minute || n.Load() != 1 {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
	if waits := keenable.TakeWaits(); len(waits) != 0 {
		t.Fatalf("waits = %v", waits)
	}
}

func TestTimeoutIsRetriedAndReported(t *testing.T) {
	slow := func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(2 * time.Second):
		}
	}
	c, n, _ := scripted(t, &keenable.Options{Timeout: 20 * time.Millisecond, MaxRetries: intPtr(1)}, slow)
	_, err := c.Search(context.Background(), "q", nil)
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) || !conn.Timeout() {
		t.Fatalf("err = %v", err)
	}
	if n.Load() != 2 {
		t.Fatalf("attempts = %d", n.Load())
	}
}

func TestRetryPolicy(t *testing.T) {
	apiErr := func(status int) error { return &keenable.APIError{StatusCode: status} }
	for _, s := range []int{408, 429, 500, 502, 503, 504, 529} {
		if _, ok := keenable.RetryDelay(apiErr(s), 0, 0); !ok {
			t.Errorf("%d should retry", s)
		}
	}
	for _, s := range []int{400, 401, 402, 403, 404, 409, 422} {
		if _, ok := keenable.RetryDelay(apiErr(s), 0, 0); ok {
			t.Errorf("%d should not retry", s)
		}
	}
	yes, no := true, false
	if _, ok := keenable.RetryDelay(&keenable.APIError{StatusCode: 422, Retryable: &yes}, 0, 0); !ok {
		t.Error("retryable true should retry")
	}
	if _, ok := keenable.RetryDelay(&keenable.APIError{StatusCode: 500, Retryable: &no}, 0, 0); ok {
		t.Error("retryable false should not retry")
	}
	if _, ok := keenable.RetryDelay(&keenable.InvalidRequestError{}, 0, 0); ok {
		t.Error("local errors should not retry")
	}
	var got []time.Duration
	for i := 0; i < 6; i++ {
		got = append(got, keenable.Backoff(i, 0))
	}
	want := []time.Duration{500 * time.Millisecond, time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 8 * time.Second}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("backoff = %v", got)
		}
	}
	if keenable.Backoff(0, 1) != 375*time.Millisecond || keenable.Backoff(100, 0) != 8*time.Second {
		t.Fatal("jitter or cap wrong")
	}
}

func TestRejectsNegativeMaxRetries(t *testing.T) {
	if _, err := keenable.New(&keenable.Options{MaxRetries: intPtr(-1)}); err == nil {
		t.Fatal("want an error")
	}
}

func TestHeadersLayeringAndKeyProtection(t *testing.T) {
	c, _, seen := scripted(t, &keenable.Options{Headers: map[string]string{"X-Gateway": "a", "X-Team": "search"}}, okBody)
	opts := &keenable.SearchOptions{RequestOptions: keenable.RequestOptions{
		Headers: map[string]string{"x-gateway": "b", "X-API-Key": "stolen"},
	}}
	if _, err := c.Search(context.Background(), "q", opts); err != nil {
		t.Fatal(err)
	}
	got := one(t, seen)
	if got.Header.Get("X-Gateway") != "b" || got.Header.Get("X-Team") != "search" || got.Header.Get("X-API-Key") != "k" {
		t.Fatalf("headers = %v", got.Header)
	}

	empty := ""
	c, _, seen = scripted(t, &keenable.Options{APIKey: &empty, Headers: map[string]string{"X-API-Key": "nope"}}, okBody)
	if _, err := c.Search(context.Background(), "q", nil); err != nil {
		t.Fatal(err)
	}
	got = one(t, seen)
	if got.Header.Get("X-API-Key") != "" || !strings.HasSuffix(got.Path, "/public") {
		t.Fatalf("keyless call sent %v to %s", got.Header, got.Path)
	}
}

func TestRequestID(t *testing.T) {
	c, _, _ := scripted(t, nil, reply(200, `{"query":"q","results":[]}`, "X-Request-Id", "s"))
	resp, err := c.Search(context.Background(), "q", nil)
	if err != nil || resp.RequestID != "s" {
		t.Fatalf("resp=%+v err=%v", resp, err)
	}
	c, _, _ = scripted(t, nil, reply(200, `{"url":"https://e.com","request_id":"body"}`, "X-Request-Id", "h"))
	page, err := c.Fetch(context.Background(), "https://e.com")
	if err != nil || page.RequestID != "body" {
		t.Fatalf("page=%+v err=%v", page, err)
	}
}
