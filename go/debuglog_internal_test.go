package keenable

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"testing"
)

// withStderr runs fn with os.Stderr going to a pipe and returns what was written.
func withStderr(t *testing.T, fn func()) string {
	t.Helper()
	r, w, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	saved := os.Stderr
	os.Stderr = w
	defer func() { os.Stderr = saved }()
	fn()
	_ = w.Close()
	out, err := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(out)
}

func TestKeenableLogDebugWritesToStderr(t *testing.T) {
	const secret = "sk-secret-key-must-not-appear"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Request-Id", "req-9")
		_, _ = w.Write([]byte(`{"results":[]}`))
	}))
	defer srv.Close()
	for _, tc := range []struct {
		env  string
		want *regexp.Regexp
	}{
		{"debug", regexp.MustCompile(`^time=\S+ level=DEBUG msg=keenable method=POST path=/v1/search attempt=1 status=200 elapsed_ms=\d+ retry=false request_id=req-9\n$`)},
		{"", regexp.MustCompile(`^$`)},
	} {
		t.Setenv("KEENABLE_LOG", tc.env)
		got := withStderr(t, func() {
			key, base := secret, srv.URL
			c, err := New(&Options{APIKey: &key, BaseURL: &base})
			if err != nil {
				t.Fatal(err)
			}
			if _, err := c.Search(context.Background(), "q", nil); err != nil {
				t.Fatal(err)
			}
		})
		if !tc.want.MatchString(got) || strings.Contains(got, secret) {
			t.Errorf("KEENABLE_LOG=%q: stderr = %q", tc.env, got)
		}
	}
}
