package keenable_test

// Retries, timeouts, request ids, redirects and malformed bodies, end to end,
// with the same scenarios as python/tests/test_transport.py and
// typescript/test/transport.test.ts.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/keenableai/keenable-sdk/go"
)

const year = 365 * 24 * time.Hour

func inBackoff(d time.Duration, retry int) bool {
	base := keenable.Backoff(retry, 0)
	return d >= base*3/4 && d <= base
}

func raw(status int, body string, headers ...string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		for i := 0; i+1 < len(headers); i += 2 {
			w.Header().Set(headers[i], headers[i+1])
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}
}

func search(c *keenable.Client, req keenable.RequestOptions) (*keenable.SearchResponse, error) {
	return c.Search(context.Background(), "q", &keenable.SearchOptions{RequestOptions: req})
}

// --- the retry decision for every code the API documents -------------------

func TestEachCatalogCodeIsRetriedAsTheAPISays(t *testing.T) {
	for _, tc := range loadContract(t) {
		t.Run(tc.Name, func(t *testing.T) {
			body, _ := json.Marshal(tc.Body)
			var headers []string
			for k, v := range tc.Headers {
				headers = append(headers, k, v)
			}
			c, n, _ := scripted(t, &keenable.Options{MaxRetries: intPtr(1)}, raw(tc.Status, string(body), headers...), okBody)
			_, err := c.Search(context.Background(), "q", nil)
			waits := keenable.TakeWaits()

			retryable := tc.Status == 408 || tc.Status == 429 || tc.Status >= 500
			if tc.Expect.Retryable != nil {
				retryable = *tc.Expect.Retryable
			}
			after := tc.Expect.RetryAfterSeconds
			if !retryable || (after != nil && *after > 60) {
				api := apiErrorFrom(t, err)
				if api.StatusCode != tc.Status || n.Load() != 1 || len(waits) != 0 {
					t.Fatalf("status=%d attempts=%d waits=%v", api.StatusCode, n.Load(), waits)
				}
				return
			}
			if err != nil || n.Load() != 2 || len(waits) != 1 {
				t.Fatalf("err=%v attempts=%d waits=%v", err, n.Load(), waits)
			}
			if after == nil {
				if !inBackoff(waits[0], 0) {
					t.Fatalf("wait %v is not a first backoff", waits[0])
				}
			} else if waits[0] != time.Duration(*after*float64(time.Second)) {
				t.Fatalf("wait %v, want %vs", waits[0], *after)
			}
		})
	}
}

// --- by status, when the API sends no "retryable" ---------------------------

func TestRetryByStatus(t *testing.T) {
	for _, status := range []int{400, 401, 402, 403, 404, 409, 413, 422, 451} {
		c, n, _ := scripted(t, nil, raw(status, `{"message":"no"}`), okBody)
		_, err := c.Search(context.Background(), "q", nil)
		if api := apiErrorFrom(t, err); api.StatusCode != status || n.Load() != 1 {
			t.Fatalf("%d: attempts=%d", status, n.Load())
		}
		if w := keenable.TakeWaits(); len(w) != 0 {
			t.Fatalf("%d waited %v", status, w)
		}
	}
	for _, status := range []int{408, 429, 500, 502, 503, 504, 529} {
		c, n, _ := scripted(t, nil, raw(status, `{"message":"busy"}`), okBody)
		if _, err := c.Search(context.Background(), "q", nil); err != nil || n.Load() != 2 {
			t.Fatalf("%d: err=%v attempts=%d", status, err, n.Load())
		}
		if w := keenable.TakeWaits(); len(w) != 1 || !inBackoff(w[0], 0) {
			t.Fatalf("%d waits %v", status, w)
		}
	}
}

func TestRetryableOverridesTheStatusAndTheRetryAfter(t *testing.T) {
	c, n, _ := scripted(t, nil, raw(400, `{"retryable":true}`), okBody)
	if _, err := c.Search(context.Background(), "q", nil); err != nil || n.Load() != 2 {
		t.Fatalf("400 retryable: err=%v attempts=%d", err, n.Load())
	}
	c, n, _ = scripted(t, nil, raw(429, `{"retryable":false,"retry_after_seconds":1}`), okBody)
	_, err := c.Search(context.Background(), "q", nil)
	var rl *keenable.RateLimitError
	if !errors.As(err, &rl) || n.Load() != 1 {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
	keenable.TakeWaits()
}

func TestSearchAndFetchAreRetriedAlike(t *testing.T) {
	var methods []string
	h := func(w http.ResponseWriter, r *http.Request) {
		methods = append(methods, r.Method)
		if len(methods)%2 == 1 {
			raw(503, ``)(w, r)
			return
		}
		raw(200, `{"query":"q","url":"https://e.com","content":"c","results":[]}`)(w, r)
	}
	c, _, seen := scripted(t, nil, h)
	if _, err := c.Search(context.Background(), "q", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Fetch(context.Background(), "https://e.com"); err != nil {
		t.Fatal(err)
	}
	got := strings.Join(methods, ",")
	if got != "POST,POST,GET,GET" {
		t.Fatalf("methods = %s", got)
	}
	// The retried POST carries the same body.
	if string((*seen)[0].Body) != string((*seen)[1].Body) || len((*seen)[1].Body) == 0 {
		t.Fatalf("bodies %q vs %q", (*seen)[0].Body, (*seen)[1].Body)
	}
	keenable.TakeWaits()
}

// --- the retry budget --------------------------------------------------------

func TestTheDefaultBudgetIsTwoRetries(t *testing.T) {
	keenable.TakeWaits()
	// scripted() and start() set MaxRetries; build a client that leaves it nil.
	base := firstURL(t, raw(503, ``))
	c, err := keenable.New(&keenable.Options{APIKey: strPtr("k"), BaseURL: &base})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	_, err = c.Search(context.Background(), "q", nil)
	apiErrorFrom(t, err)
	w := keenable.TakeWaits()
	if len(w) != 2 || !inBackoff(w[0], 0) || !inBackoff(w[1], 1) {
		t.Fatalf("waits %v", w)
	}
}

func TestPerCallBudgetOverridesTheClients(t *testing.T) {
	cases := []struct {
		client   int
		call     *int
		attempts int32
	}{
		{0, nil, 1}, {0, intPtr(3), 4}, {5, intPtr(1), 2}, {5, intPtr(0), 1}, {1, nil, 2},
	}
	for _, tc := range cases {
		c, n, _ := scripted(t, &keenable.Options{MaxRetries: intPtr(tc.client)}, raw(503, ``))
		_, err := search(c, keenable.RequestOptions{MaxRetries: tc.call})
		apiErrorFrom(t, err)
		if n.Load() != tc.attempts || len(keenable.TakeWaits()) != int(tc.attempts-1) {
			t.Fatalf("%+v: attempts=%d", tc, n.Load())
		}
	}
}

func TestTheLastErrorIsReturnedWhenTheBudgetRunsOut(t *testing.T) {
	c, _, _ := scripted(t, &keenable.Options{MaxRetries: intPtr(1)},
		raw(503, `{"code":"first"}`), raw(502, `{"code":"last"}`, "X-Request-Id", "r2"))
	_, err := c.Search(context.Background(), "q", nil)
	api := apiErrorFrom(t, err)
	if api.APICode != "last" || api.RequestID != "r2" {
		t.Fatalf("got %+v", api)
	}
	keenable.TakeWaits()
}

func TestABadPerCallSettingIsRejectedBeforeSending(t *testing.T) {
	for _, req := range []keenable.RequestOptions{{MaxRetries: intPtr(-1)}, {Timeout: -time.Second}} {
		c, n, _ := scripted(t, nil, okBody)
		_, err := search(c, req)
		var bad *keenable.InvalidRequestError
		if !errors.As(err, &bad) || n.Load() != 0 {
			t.Fatalf("%+v: err=%v attempts=%d", req, err, n.Load())
		}
	}
	if _, err := keenable.New(&keenable.Options{Timeout: -1}); err == nil {
		t.Fatal("a negative client timeout was accepted")
	}
}

// --- backoff and jitter ------------------------------------------------------

func TestBackoffBoundsAndCap(t *testing.T) {
	for retry := 0; retry < 70; retry++ {
		base := keenable.Backoff(retry, 0)
		want := 8 * time.Second
		if retry < 5 {
			want = (500 * time.Millisecond) << retry
		}
		if base != want {
			t.Fatalf("Backoff(%d) = %v, want %v", retry, base, want)
		}
		if got := keenable.Backoff(retry, 0.999999); got < base*3/4 || got > base {
			t.Fatalf("jittered Backoff(%d) = %v", retry, got)
		}
	}
	if keenable.Backoff(1<<30, 0.5) != 7*time.Second {
		t.Fatal("a huge retry index is not capped")
	}
}

// --- Retry-After -------------------------------------------------------------

func TestRetryAfterSetsTheWait(t *testing.T) {
	past := "Wed, 21 Oct 2015 07:28:00 GMT"
	cases := []struct {
		name string
		h    http.HandlerFunc
		wait time.Duration
	}{
		{"header 0", raw(429, `{}`, "Retry-After", "0"), 0},
		{"header 60", raw(429, `{}`, "Retry-After", "60"), 60 * time.Second},
		{"header padded", raw(429, `{}`, "Retry-After", " 7 "), 7 * time.Second},
		{"header zeros", raw(429, `{}`, "Retry-After", "007"), 7 * time.Second},
		{"body fraction", raw(429, `{"retry_after_seconds":0.25}`), 250 * time.Millisecond},
		{"body 60", raw(429, `{"retry_after_seconds":60}`), 60 * time.Second},
		{"body over header", raw(429, `{"retry_after_seconds":1}`, "Retry-After", "30"), time.Second},
		{"header over legacy", raw(429, `{"retryAfter":9}`, "Retry-After", "4"), 4 * time.Second},
		{"legacy", raw(429, `{"retryAfter":3}`), 3 * time.Second},
		{"negative body", raw(429, `{"retry_after_seconds":-5}`, "Retry-After", "2"), 2 * time.Second},
		{"string body", raw(429, `{"retry_after_seconds":"5"}`, "Retry-After", "2"), 2 * time.Second},
		{"bool body", raw(429, `{"retry_after_seconds":true}`, "Retry-After", "2"), 2 * time.Second},
		{"overflowing body", raw(429, `{"retry_after_seconds":1e400}`, "Retry-After", "2"), 2 * time.Second},
		{"past date", raw(429, `{}`, "Retry-After", past), 0},
	}
	for _, tc := range cases {
		c, n, _ := scripted(t, nil, tc.h, okBody)
		if _, err := c.Search(context.Background(), "q", nil); err != nil || n.Load() != 2 {
			t.Fatalf("%s: err=%v attempts=%d", tc.name, err, n.Load())
		}
		if w := keenable.TakeWaits(); len(w) != 1 || w[0] != tc.wait {
			t.Fatalf("%s: waits %v, want %v", tc.name, w, tc.wait)
		}
	}
}

func TestARetryAfterDateIsWaitedUntil(t *testing.T) {
	when := time.Now().Add(30 * time.Second).UTC().Format(http.TimeFormat)
	c, _, _ := scripted(t, nil, raw(429, `{}`, "Retry-After", when), okBody)
	if _, err := c.Search(context.Background(), "q", nil); err != nil {
		t.Fatal(err)
	}
	if w := keenable.TakeWaits(); len(w) != 1 || w[0] < 28*time.Second || w[0] > 31*time.Second {
		t.Fatalf("waits %v", w)
	}
}

func TestAMalformedRetryAfterFallsBackToBackoff(t *testing.T) {
	for _, header := range []string{"1.5", "-1", "+5", "5s", "soon", "Jan 1", "2015-10-21"} {
		c, _, _ := scripted(t, nil, raw(429, `{}`, "Retry-After", header), okBody)
		if _, err := c.Search(context.Background(), "q", nil); err != nil {
			t.Fatalf("%q: %v", header, err)
		}
		if w := keenable.TakeWaits(); len(w) != 1 || !inBackoff(w[0], 0) {
			t.Fatalf("%q: waits %v", header, w)
		}
	}
}

func TestARetryAfterOverAMinuteIsReturnedAtOnce(t *testing.T) {
	cases := []struct {
		h        http.HandlerFunc
		reported time.Duration
	}{
		{raw(429, `{}`, "Retry-After", "61"), 61 * time.Second},
		{raw(429, `{"retry_after_seconds":60.5}`), 60500 * time.Millisecond},
		{raw(429, `{"retry_after_seconds":1800}`), 1800 * time.Second},
		// The clamps from #48: a huge delay is a year, not an overflow.
		{raw(429, `{}`, "Retry-After", strings.Repeat("9", 400)), year},
		{raw(429, `{}`, "Retry-After", "Fri, 31 Dec 9999 23:59:59 GMT"), year},
		{raw(429, `{"retry_after_seconds":1e300}`), year},
		{raw(429, `{"retryAfter":1e30}`), year},
	}
	for i, tc := range cases {
		c, n, _ := scripted(t, nil, tc.h, okBody)
		_, err := c.Search(context.Background(), "q", nil)
		var rl *keenable.RateLimitError
		if !errors.As(err, &rl) || rl.RetryAfter != tc.reported || n.Load() != 1 {
			t.Fatalf("case %d: err=%v attempts=%d", i, err, n.Load())
		}
		if w := keenable.TakeWaits(); len(w) != 0 {
			t.Fatalf("case %d waited %v", i, w)
		}
	}
}

// --- network failures and timeouts -------------------------------------------

// hangUp closes the connection without a response.
func hangUp(w http.ResponseWriter, r *http.Request) {
	conn, _, err := w.(http.Hijacker).Hijack()
	if err == nil {
		_ = conn.Close()
	}
}

func slowFor(d time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
		case <-time.After(d):
			okBody(w, r)
		}
	}
}

func TestAClosedConnectionIsRetried(t *testing.T) {
	c, n, _ := scripted(t, nil, hangUp, okBody)
	if _, err := c.Search(context.Background(), "q", nil); err != nil || n.Load() != 2 {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
	if w := keenable.TakeWaits(); len(w) != 1 || !inBackoff(w[0], 0) {
		t.Fatalf("waits %v", w)
	}

	c, n, _ = scripted(t, &keenable.Options{MaxRetries: intPtr(1)}, hangUp)
	_, err := c.Search(context.Background(), "q", nil)
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) || conn.Timeout() || n.Load() != 2 {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
	keenable.TakeWaits()
}

func TestATimeoutDuringRetriesThenSuccess(t *testing.T) {
	c, n, _ := scripted(t, &keenable.Options{Timeout: 50 * time.Millisecond}, slowFor(5*time.Second), raw(503, ``), okBody)
	if _, err := c.Search(context.Background(), "q", nil); err != nil || n.Load() != 3 {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
	if w := keenable.TakeWaits(); len(w) != 2 || !inBackoff(w[0], 0) || !inBackoff(w[1], 1) {
		t.Fatalf("waits %v", w)
	}
}

func TestATimeoutIsNotRetriedWithRetriesOff(t *testing.T) {
	c, n, _ := scripted(t, &keenable.Options{Timeout: 30 * time.Millisecond, MaxRetries: intPtr(0)}, slowFor(5*time.Second), okBody)
	_, err := c.Search(context.Background(), "q", nil)
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) || !conn.Timeout() || n.Load() != 1 {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
	if !strings.Contains(err.Error(), "within 30ms") {
		t.Fatalf("message %q does not name the deadline", err)
	}
}

func TestPerCallAndClientTimeouts(t *testing.T) {
	// A per-call deadline shorter than the client's applies.
	c, _, _ := scripted(t, &keenable.Options{Timeout: 5 * time.Second, MaxRetries: intPtr(0)}, slowFor(2*time.Second))
	_, err := search(c, keenable.RequestOptions{Timeout: 30 * time.Millisecond})
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) || !conn.Timeout() || !strings.Contains(err.Error(), "within 30ms") {
		t.Fatalf("short per-call timeout: %v", err)
	}
	// Zero per call keeps the client's.
	c, _, _ = scripted(t, &keenable.Options{Timeout: 30 * time.Millisecond, MaxRetries: intPtr(0)}, slowFor(2*time.Second))
	_, err = search(c, keenable.RequestOptions{Timeout: 0})
	if !errors.As(err, &conn) || !conn.Timeout() {
		t.Fatalf("zero per-call timeout: %v", err)
	}
	// Each retry gets the whole per-call deadline again.
	c, n, _ := scripted(t, &keenable.Options{Timeout: 30 * time.Millisecond, MaxRetries: intPtr(1)}, slowFor(2*time.Second), slowFor(60*time.Millisecond))
	if _, err := search(c, keenable.RequestOptions{Timeout: time.Second}); err != nil {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
	keenable.TakeWaits()
}

func TestACanceledContextStopsRetrying(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	var n atomic.Int32
	h := func(w http.ResponseWriter, r *http.Request) {
		if n.Add(1) == 1 {
			cancel()
		}
		raw(503, ``)(w, r)
	}
	c, _, _ := scripted(t, nil, h)
	_, err := c.Search(ctx, "q", nil)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	if n.Load() != 1 {
		t.Fatalf("attempts = %d", n.Load())
	}
	keenable.TakeWaits()
}

// --- request ids -------------------------------------------------------------

func TestRequestIDOnSuccess(t *testing.T) {
	cases := []struct {
		fetch bool
		h     http.HandlerFunc
		want  string
	}{
		{false, raw(200, `{"results":[]}`, "X-Request-Id", "h"), "h"},
		{false, raw(200, `{"results":[],"request_id":"b"}`, "X-Request-Id", "h"), "b"},
		{false, raw(200, `{"results":[]}`, "X-Request-Id", "  "), ""},
		{false, raw(200, `{"results":[],"request_id":""}`, "X-Request-Id", "h"), "h"},
		{false, raw(200, `{"results":[],"request_id":7}`, "X-Request-Id", "h"), "h"},
		{false, raw(200, `{"results":[]}`), ""},
		{true, raw(200, `{"url":"https://e.com"}`, "X-Request-Id", "h"), "h"},
		{true, raw(200, `{"url":"https://e.com","request_id":"b"}`, "X-Request-Id", "h"), "b"},
		{true, raw(200, `{"url":"https://e.com"}`), ""},
	}
	for i, tc := range cases {
		c, _, _ := scripted(t, nil, tc.h)
		var got string
		if tc.fetch {
			page, err := c.Fetch(context.Background(), "https://e.com")
			if err != nil {
				t.Fatal(err)
			}
			got = page.RequestID
		} else {
			resp, err := c.Search(context.Background(), "q", nil)
			if err != nil {
				t.Fatal(err)
			}
			got = resp.RequestID
		}
		if got != tc.want {
			t.Fatalf("case %d: request id %q, want %q", i, got, tc.want)
		}
	}
}

func TestRequestIDOnError(t *testing.T) {
	cases := []struct {
		h    http.HandlerFunc
		want string
	}{
		{raw(400, `{"message":"m"}`, "X-Request-Id", "h"), "h"},
		{raw(400, `{"request_id":"b"}`, "X-Request-Id", "h"), "b"},
		{raw(400, `<html>`, "X-Request-Id", "h"), "h"},
		{raw(400, `{"message":"m"}`), ""},
	}
	for i, tc := range cases {
		c, _, _ := scripted(t, nil, tc.h)
		_, err := c.Search(context.Background(), "q", nil)
		api := apiErrorFrom(t, err)
		if api.RequestID != tc.want {
			t.Fatalf("case %d: request id %q, want %q", i, api.RequestID, tc.want)
		}
		if tc.want != "" && !strings.Contains(err.Error(), "(request_id: "+tc.want+")") {
			t.Fatalf("case %d: message %q", i, err)
		}
		if tc.want == "" && strings.Contains(err.Error(), "request_id") {
			t.Fatalf("case %d: message %q", i, err)
		}
		// A 400 is not retried, so the message must not say to retry it.
		if strings.Contains(err.Error(), "Retry the request") {
			t.Fatalf("case %d: message %q", i, err)
		}
	}
}

func TestTheRequestIDIsTheAnsweringAttempts(t *testing.T) {
	c, _, _ := scripted(t, nil, raw(503, ``, "X-Request-Id", "first"), raw(200, `{"results":[]}`, "X-Request-Id", "second"))
	resp, err := c.Search(context.Background(), "q", nil)
	if err != nil || resp.RequestID != "second" {
		t.Fatalf("resp=%+v err=%v", resp, err)
	}
	keenable.TakeWaits()
}

// --- redirects: the API key never leaves the configured host -----------------

// trap counts the requests that reach it and the API keys they carry.
type trap struct {
	srv  *httptest.Server
	hits atomic.Int32
	keys atomic.Int32
}

func newTrap(t *testing.T) *trap {
	tr := &trap{}
	tr.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tr.hits.Add(1)
		if r.Header.Get("X-API-Key") != "" {
			tr.keys.Add(1)
		}
		okBody(w, r)
	}))
	t.Cleanup(tr.srv.Close)
	return tr
}

func assertRefusedRedirect(t *testing.T, err error, n int32) {
	t.Helper()
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) || conn.Timeout() {
		t.Fatalf("want a redirect ConnectionError, got %T %v", err, err)
	}
	var api *keenable.APIError
	if errors.As(err, &api) {
		t.Fatalf("a redirect became an APIError: %v", err)
	}
	if strings.Contains(err.Error(), "keen_secret") || !strings.Contains(err.Error(), "KEENABLE_API_URL") {
		t.Fatalf("message %q", err)
	}
	if n != 1 {
		t.Fatalf("a refused redirect was retried: %d attempts", n)
	}
	if w := keenable.TakeWaits(); len(w) != 0 {
		t.Fatalf("waited %v before a refused redirect", w)
	}
}

func secretOpts(extra *keenable.Options) *keenable.Options {
	if extra == nil {
		extra = &keenable.Options{}
	}
	extra.APIKey = strPtr("keen_secret")
	extra.MaxRetries = intPtr(2)
	return extra
}

func TestARedirectToAnotherHostIsNotFollowed(t *testing.T) {
	tr := newTrap(t)
	other := strings.TrimPrefix(tr.srv.URL, "http://")
	port := other[strings.LastIndex(other, ":")+1:]
	targets := []string{
		tr.srv.URL + "/v1/search",                 // same IP, another port
		"http://localhost:" + port + "/v1/search", // another name for the same machine
		"http://user@" + other + "/v1/search",
	}
	for _, status := range []int{301, 302, 303, 307, 308} {
		for _, target := range targets {
			for _, own := range []bool{true, false} {
				opts := secretOpts(nil)
				if !own {
					opts.HTTPClient = &http.Client{}
				}
				c, n, _ := scripted(t, opts, func(w http.ResponseWriter, r *http.Request) {
					http.Redirect(w, r, target, status)
				})
				_, err := c.Search(context.Background(), "q", nil)
				assertRefusedRedirect(t, err, n.Load())
			}
		}
	}
	if tr.hits.Load() != 0 || tr.keys.Load() != 0 {
		t.Fatalf("the other host got %d requests, %d with a key", tr.hits.Load(), tr.keys.Load())
	}
}

func TestASchemeDowngradeRedirectIsNotFollowed(t *testing.T) {
	var hits atomic.Int32
	var srv *httptest.Server
	srv = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Redirect(w, r, "http://"+r.Host+r.URL.Path, http.StatusTemporaryRedirect)
	}))
	t.Cleanup(srv.Close)
	base := srv.URL
	c, err := keenable.New(secretOpts(&keenable.Options{BaseURL: &base, HTTPClient: srv.Client()}))
	if err != nil {
		t.Fatal(err)
	}
	_, err = c.Search(context.Background(), "q", nil)
	assertRefusedRedirect(t, err, hits.Load())
}

func TestASameHostHopThenAnotherHostIsNotFollowed(t *testing.T) {
	tr := newTrap(t)
	var hits atomic.Int32
	h := func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Query().Get("hop") == "" {
			http.Redirect(w, r, r.URL.Path+"?hop=1", http.StatusTemporaryRedirect)
			return
		}
		http.Redirect(w, r, tr.srv.URL+"/stolen", http.StatusTemporaryRedirect)
	}
	c, _, _ := scripted(t, secretOpts(nil), h)
	_, err := c.Search(context.Background(), "q", nil)
	var conn *keenable.ConnectionError
	if !errors.As(err, &conn) || tr.hits.Load() != 0 {
		t.Fatalf("err=%v other-host hits=%d", err, tr.hits.Load())
	}
	// One attempt of two hops, not retried.
	if hits.Load() != 2 {
		t.Fatalf("hits = %d", hits.Load())
	}
	keenable.TakeWaits()
}

func TestAnUnfollowedRedirectIsAConnectionError(t *testing.T) {
	// Bug: a 3xx the caller's client chose not to follow was an APIError that
	// told the agent to retry; Python and TypeScript report a redirect.
	noFollow := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error {
		return http.ErrUseLastResponse
	}}
	for _, status := range []int{301, 302, 307, 308} {
		c, n, _ := scripted(t, secretOpts(&keenable.Options{HTTPClient: noFollow}), func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/v1/elsewhere", status)
		})
		_, err := c.Search(context.Background(), "q", nil)
		assertRefusedRedirect(t, err, n.Load())
		if !strings.Contains(err.Error(), "/v1/elsewhere") {
			t.Fatalf("message %q does not say where", err)
		}
	}
	// Go does not follow a 300 or 304 at all.
	for _, status := range []int{300, 304} {
		c, n, _ := scripted(t, secretOpts(nil), raw(status, ``))
		_, err := c.Search(context.Background(), "q", nil)
		assertRefusedRedirect(t, err, n.Load())
	}
}

// --- malformed and empty bodies ----------------------------------------------

func TestAMalformedErrorBodyStillMapsByStatus(t *testing.T) {
	cases := []struct {
		status  int
		body    string
		detail  string
		hasRaw  bool
		errType string
	}{
		{400, ``, "", false, keenable.TypeInvalidRequestError},
		{400, `   `, "", false, keenable.TypeInvalidRequestError},
		{400, `{"code": "x"`, `{"code": "x"`, false, keenable.TypeInvalidRequestError},
		{400, `[1, 2]`, "", false, keenable.TypeInvalidRequestError},
		{400, `"oops"`, "", false, keenable.TypeInvalidRequestError},
		{400, `null`, "", false, keenable.TypeInvalidRequestError},
		{403, `<h1>Forbidden</h1>`, "<h1>Forbidden</h1>", false, keenable.TypePermissionError},
		{400, `{"message":" ","error":"Bad","detail":"d"}`, "Bad", true, keenable.TypeInvalidRequestError},
		{400, `{"detail":"only"}`, "only", true, keenable.TypeInvalidRequestError},
		{400, `{}`, "", true, keenable.TypeInvalidRequestError},
		{451, `{}`, "", true, keenable.TypeBillingError},
	}
	for i, tc := range cases {
		c, n, _ := scripted(t, nil, raw(tc.status, tc.body))
		_, err := c.Search(context.Background(), "q", nil)
		api := apiErrorFrom(t, err)
		if api.StatusCode != tc.status || api.Body != tc.detail || (api.Raw != nil) != tc.hasRaw ||
			api.Type != tc.errType || api.APICode != "" || n.Load() != 1 {
			t.Fatalf("case %d: %+v attempts=%d", i, api, n.Load())
		}
		if tc.detail != "" && !strings.Contains(err.Error(), tc.detail) {
			t.Fatalf("case %d: message %q", i, err)
		}
	}
}

func TestA5xxHTMLPageFromAProxyIsRetried(t *testing.T) {
	page := raw(502, `<html>Bad Gateway</html>`)
	c, n, _ := scripted(t, nil, page, okBody)
	if _, err := c.Search(context.Background(), "q", nil); err != nil || n.Load() != 2 {
		t.Fatalf("err=%v attempts=%d", err, n.Load())
	}
	c, _, _ = scripted(t, nil, page)
	_, err := c.Search(context.Background(), "q", nil)
	if api := apiErrorFrom(t, err); api.Body != "<html>Bad Gateway</html>" || api.Type != keenable.TypeAPIError {
		t.Fatalf("got %+v", api)
	}
	keenable.TakeWaits()
}

func TestASuccessThatIsNotAJSONObjectIsAnErrorNotRetried(t *testing.T) {
	for _, tc := range []struct{ body, msg string }{
		{``, "non-JSON"}, {`<html>`, "non-JSON"}, {`{"results": [`, "non-JSON"},
		{`[]`, "Unexpected response"}, {`"text"`, "Unexpected response"}, {`null`, "Unexpected response"},
	} {
		c, n, _ := scripted(t, nil, raw(200, tc.body, "X-Request-Id", "r"), okBody)
		_, err := c.Search(context.Background(), "q", nil)
		api := apiErrorFrom(t, err)
		if !strings.Contains(err.Error(), tc.msg) || api.StatusCode != 200 || api.RequestID != "r" || n.Load() != 1 {
			t.Fatalf("%q: %v attempts=%d", tc.body, err, n.Load())
		}
	}
}

func TestALenientSuccessBodyParses(t *testing.T) {
	c, _, _ := scripted(t, nil, raw(200, `{"query":"  ","results":[null,3,{"title":"t","url":"u"}]}`))
	resp, err := c.Search(context.Background(), "q", nil)
	if err != nil || resp.Query != "q" || len(resp.Results) != 1 || resp.Results[0].Title != "t" {
		t.Fatalf("resp=%+v err=%v", resp, err)
	}
	c, _, _ = scripted(t, nil, raw(200, `{"query":5,"results":"x"}`))
	resp, err = c.Search(context.Background(), "q", nil)
	if err != nil || resp.Query != "q" || len(resp.Results) != 0 {
		t.Fatalf("resp=%+v err=%v", resp, err)
	}
	c, _, _ = scripted(t, nil, raw(200, `{"url":"","title":null}`))
	page, err := c.Fetch(context.Background(), "https://e.com/a")
	if err != nil || page.URL != "https://e.com/a" || page.Title != "" {
		t.Fatalf("page=%+v err=%v", page, err)
	}
}

// --- fetch targets -------------------------------------------------------------

func TestFetchRefusesInternalTargetSpellings(t *testing.T) {
	for _, u := range []string{
		// Hosts spelled as numbers reach 127.0.0.1 in a URL parser (the
		// TypeScript SDK refuses them too).
		"http://2130706433/",
		"http://0x7f.0.0.1/",
		"http://0x7F000001/",
		"http://017700000001/",
		"http://0177.0.0.1/",
		"http://127.1/",
		"http://10.1/",
		"http://0/",
		"http://0x/",
		// Fullwidth digits and ideographic full stops fold to ASCII.
		"http://１２７.０.０.１/",
		"http://127。0。0。1/",
		"http://ｌｏｃａｌｈｏｓｔ/",
		"https://user:pass@127.0.0.1/",
		"https://example.com@10.0.0.1/",
		"http://127.0.0.1:8080/",
		"http://[::]/",
		"http://[::1]/",
		"http://[::ffff:7f00:1]/",
		"http://[fd00::1]/",
		"http://[fe80::1]/",
		"http://[ff02::1]/",
		"http://224.0.0.1/",
		"http://240.0.0.1/", // Bug: IsGlobalUnicast counts 240.0.0.0/4 as public.
		"http://255.255.255.255/",
		"http://0.0.0.0/",
		"http://METADATA.google.internal./",
		"https:///nohost",
		"ftp://example.com/",
		"javascript:alert(1)",
	} {
		c, n, _ := scripted(t, nil, okBody)
		_, err := c.Fetch(context.Background(), u)
		var bad *keenable.InvalidRequestError
		if !errors.As(err, &bad) || n.Load() != 0 {
			t.Errorf("%s: err=%v attempts=%d", u, err, n.Load())
		}
	}
}

func TestFetchAllowsPublicTargets(t *testing.T) {
	for _, u := range []string{
		"https://fdic.gov/",
		"https://fcbarcelona.com/",
		"https://febreze.com/",
		"https://ff02.example/",
		"https://localhost.example.com/",
		"https://127.0.0.1.nip.io.example/",
		"https://127.0.0.1@example.com/",
		"https://example.com:8443/x",
		"https://1e100.net/",
		"https://0x7f.example/",
		"https://8.8.8.8/",
		"https://134744072/", // 8.8.8.8 spelled as a number
		"https://172.32.0.1/",
		"https://例え.jp/",
		"https://xn--r8jz45g.jp/",
		"https://256.0.0.1/",
	} {
		c, _, seen := scripted(t, nil, raw(200, `{"url":"x"}`))
		if _, err := c.Fetch(context.Background(), u); err != nil {
			t.Errorf("%s: %v", u, err)
			continue
		}
		if got := one(t, seen).Query.Get("url"); got != u {
			t.Errorf("sent url %q, want %q", got, u)
		}
	}
}

// --- concurrency ---------------------------------------------------------------

func TestConcurrentCallsRetryIndependently(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]int{}
	h := func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Call")
		mu.Lock()
		seen[id]++
		first := seen[id] == 1
		mu.Unlock()
		if first {
			raw(503, ``)(w, r)
			return
		}
		raw(200, `{"results":[]}`, "X-Request-Id", id)(w, r)
	}
	c, _, _ := scripted(t, nil, h)
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(id string) {
			defer wg.Done()
			resp, err := search(c, keenable.RequestOptions{Headers: map[string]string{"X-Call": id}})
			if err == nil && resp.RequestID != id {
				err = fmt.Errorf("call %s got request id %s", id, resp.RequestID)
			}
			errs <- err
		}(fmt.Sprint(i))
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	for id, attempts := range seen {
		if attempts != 2 {
			t.Fatalf("call %s made %d attempts", id, attempts)
		}
	}
	keenable.TakeWaits()
}

func strPtr(s string) *string { return &s }

// firstURL starts a server for h and returns its URL.
func firstURL(t *testing.T, h http.Handler) string {
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv.URL
}
