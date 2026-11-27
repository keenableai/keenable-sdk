package keenable_test

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/keenableai/keenable-sdk/go"
)

const (
	debugSecret       = "sk-secret-key-must-not-appear"
	debugSecretHeader = "header-secret-must-not-appear"
	debugSecretQuery  = "query-text-must-not-appear"
)

func TestConformanceDebugLog(t *testing.T) {
	fixture := loadConformance(t)
	for _, tc := range fixture.DebugLog.Env {
		if got := keenable.DebugEnabled(tc.Value); got != tc.Enabled {
			t.Errorf("KEENABLE_LOG %s: enabled = %v, want %v", tc.Name, got, tc.Enabled)
		}
	}
	for _, tc := range fixture.DebugLog.Lines {
		a := tc.Attempt
		status, failure, wait, id := 0, "", int64(0), ""
		if a.Status != nil {
			status = *a.Status
		}
		if a.Error != nil {
			failure = *a.Error
		}
		if a.WaitMS != nil {
			wait = *a.WaitMS
		}
		if a.RequestID != nil {
			id = *a.RequestID
		}
		got := keenable.DebugLine(a.Method, a.Path, a.Attempt, status, failure, a.ElapsedMS, a.Retry, wait, id)
		if got != tc.Line {
			t.Errorf("%s:\n got  %s\n want %s", tc.Name, got, tc.Line)
		}
	}
}

// syncBuffer is a bytes.Buffer safe for the handler's writes.
type syncBuffer struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *syncBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

// debugClient is a keyed client whose debug records go to the returned buffer.
func debugClient(t *testing.T, retries int, replies ...http.HandlerFunc) (*keenable.Client, *syncBuffer) {
	t.Helper()
	out := &syncBuffer{}
	key := debugSecret
	logger := slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{
		Level: slog.LevelDebug,
		// Drop the time so the records are stable.
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.TimeKey {
				return slog.Attr{}
			}
			return a
		},
	}))
	c, _, _ := scripted(t, &keenable.Options{
		APIKey:     &key,
		MaxRetries: intPtr(retries),
		Headers:    map[string]string{"X-Proxy-Token": debugSecretHeader},
		Logger:     logger,
	}, replies...)
	return c, out
}

func TestDebugLogOneRecordPerAttempt(t *testing.T) {
	c, out := debugClient(t, 1,
		reply(503, `{"message":"busy"}`, "X-Request-Id", "req-1"),
		reply(200, `{"query":"q","results":[]}`, "X-Request-Id", "req-2"),
	)
	if _, err := c.Search(context.Background(), debugSecretQuery, nil); err != nil {
		t.Fatalf("Search: %v", err)
	}
	waits := keenable.TakeWaits()
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 || len(waits) != 1 {
		t.Fatalf("lines = %q, waits = %v", lines, waits)
	}
	first := regexp.MustCompile(`^level=DEBUG msg=keenable method=POST path=/v1/search attempt=1 status=503 elapsed_ms=\d+ retry=true wait_ms=(\d+) request_id=req-1$`)
	m := first.FindStringSubmatch(lines[0])
	if m == nil || m[1] != strconv.FormatInt(waits[0].Milliseconds(), 10) {
		t.Errorf("first record = %q (wait %v)", lines[0], waits[0])
	}
	second := regexp.MustCompile(`^level=DEBUG msg=keenable method=POST path=/v1/search attempt=2 status=200 elapsed_ms=\d+ retry=false request_id=req-2$`)
	if !second.MatchString(lines[1]) {
		t.Errorf("second record = %q", lines[1])
	}
	for _, secret := range []string{debugSecret, debugSecretHeader, debugSecretQuery} {
		if strings.Contains(out.String(), secret) {
			t.Errorf("the log holds %q", secret)
		}
	}
}

func TestDebugLogAFailureAndARedirect(t *testing.T) {
	c, out := debugClient(t, 0, reply(503, `{"message":"busy"}`, "X-Request-Id", "req-1"))
	var api *keenable.APIError
	if _, err := c.Search(context.Background(), "q", nil); !errors.As(err, &api) {
		t.Fatalf("err = %v", err)
	}
	want := regexp.MustCompile(`^level=DEBUG msg=keenable method=POST path=/v1/search attempt=1 status=503 elapsed_ms=\d+ retry=false request_id=req-1\n$`)
	if !want.MatchString(out.String()) {
		t.Errorf("record = %q", out.String())
	}

	c, out = debugClient(t, 0, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "https://elsewhere.example/", http.StatusFound)
	})
	if _, err := c.Billing(context.Background(), nil); err == nil {
		t.Fatal("a redirect succeeded")
	}
	want = regexp.MustCompile(`^level=DEBUG msg=keenable method=GET path=/v1/billing attempt=1 error=redirect elapsed_ms=\d+ retry=false\n$`)
	if !want.MatchString(out.String()) {
		t.Errorf("record = %q", out.String())
	}
}

func TestDebugLogACanceledCall(t *testing.T) {
	c, out := debugClient(t, 2, okBody)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Search(ctx, "q", nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v", err)
	}
	want := regexp.MustCompile(`^level=DEBUG msg=keenable method=POST path=/v1/search attempt=1 error=canceled elapsed_ms=\d+ retry=false\n$`)
	if !want.MatchString(out.String()) {
		t.Errorf("record = %q", out.String())
	}
}

func TestDebugLogNothingAboveDebug(t *testing.T) {
	out := &syncBuffer{}
	logger := slog.New(slog.NewTextHandler(out, &slog.HandlerOptions{Level: slog.LevelInfo}))
	c, _, _ := scripted(t, &keenable.Options{Logger: logger}, okBody)
	if _, err := c.Search(context.Background(), "q", nil); err != nil {
		t.Fatal(err)
	}
	if out.String() != "" {
		t.Errorf("logged at info level: %q", out.String())
	}
}
