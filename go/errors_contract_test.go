package keenable_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/keenableai/keenable-sdk/go"
)

// contractCase is one entry of testdata/error_contract.json: a body and
// headers the backend sends (keenable-backend-ts PRs #663 and #666),
// generated from its own error constructors.
type contractCase struct {
	Name    string            `json:"name"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    map[string]any    `json:"body"`
	Expect  struct {
		Kind              string   `json:"kind"`
		Code              *string  `json:"code"`
		Retryable         *bool    `json:"retryable"`
		RetryAfterSeconds *float64 `json:"retry_after_seconds"`
		RequestID         *string  `json:"request_id"`
		Param             *string  `json:"param"`
		DocsURL           *string  `json:"docs_url"`
		Fix               *string  `json:"fix"`
		Limit             *struct {
			Scope    string `json:"scope"`
			Window   string `json:"window"`
			Max      int    `json:"max"`
			ResetsAt string `json:"resets_at"`
		} `json:"limit"`
		BillingURL      *string `json:"billing_url"`
		AutoTopUpURL    *string `json:"auto_top_up_url"`
		PayPerRequest   *string `json:"pay_per_request"`
		MessageContains string  `json:"message_contains"`
	} `json:"expect"`
}

func loadContract(t *testing.T) []contractCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/error_contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var file struct {
		Cases []contractCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &file); err != nil {
		t.Fatal(err)
	}
	return file.Cases
}

func keyed() *keenable.Options {
	key := "k"
	return &keenable.Options{APIKey: &key}
}

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func replyWith(status int, body any, headers map[string]string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for k, v := range headers {
			w.Header().Set(k, v)
		}
		jsonHandler(status, body).ServeHTTP(w, r)
	})
}

func apiErrorFrom(t *testing.T, err error) *keenable.APIError {
	t.Helper()
	var api *keenable.APIError
	if !errors.As(err, &api) {
		t.Fatalf("want an APIError, got %T: %v", err, err)
	}
	return api
}

func TestBackendErrorBodiesParseIntoTypedErrors(t *testing.T) {
	for _, tc := range loadContract(t) {
		t.Run(tc.Name, func(t *testing.T) {
			c, _ := start(t, replyWith(tc.Status, tc.Body, tc.Headers), keyed())
			_, err := c.Search(context.Background(), "q", nil)
			api := apiErrorFrom(t, err)
			want := tc.Expect

			kinds := map[string]bool{
				"auth":                 errors.As(err, new(*keenable.AuthError)),
				"rate_limit":           errors.As(err, new(*keenable.RateLimitError)),
				"insufficient_credits": errors.As(err, new(*keenable.InsufficientCreditsError)),
			}
			for kind, got := range kinds {
				if got != (kind == want.Kind) {
					t.Fatalf("kind %s = %v, want kind %s: %T", kind, got, want.Kind, err)
				}
			}
			if api.StatusCode != tc.Status || api.APICode != deref(want.Code) || api.Title != tc.Body["error"] {
				t.Fatalf("status=%d code=%q title=%q", api.StatusCode, api.APICode, api.Title)
			}
			if api.Fix != deref(want.Fix) || api.DocsURL != deref(want.DocsURL) || api.Param != deref(want.Param) {
				t.Fatalf("fix=%q docs=%q param=%q", api.Fix, api.DocsURL, api.Param)
			}
			if api.RequestID != deref(want.RequestID) {
				t.Fatalf("request id %q", api.RequestID)
			}
			if api.BillingURL != deref(want.BillingURL) || api.AutoTopUpURL != deref(want.AutoTopUpURL) || api.PayPerRequest != deref(want.PayPerRequest) {
				t.Fatalf("billing=%q topup=%q ppr=%q", api.BillingURL, api.AutoTopUpURL, api.PayPerRequest)
			}
			if (api.Retryable == nil) != (want.Retryable == nil) || (api.Retryable != nil && *api.Retryable != *want.Retryable) {
				t.Fatalf("retryable %v, want %v", api.Retryable, want.Retryable)
			}
			wantWait := time.Duration(0)
			if want.RetryAfterSeconds != nil {
				wantWait = time.Duration(*want.RetryAfterSeconds * float64(time.Second))
			}
			if api.RetryAfter != wantWait {
				t.Fatalf("retry after %v, want %v", api.RetryAfter, wantWait)
			}
			if want.Limit == nil {
				if api.RateLimit != nil {
					t.Fatalf("unexpected limit %+v", api.RateLimit)
				}
			} else {
				got := keenable.RateLimitInfo{Scope: want.Limit.Scope, Window: want.Limit.Window, Max: want.Limit.Max, ResetsAt: want.Limit.ResetsAt}
				if api.RateLimit == nil || *api.RateLimit != got {
					t.Fatalf("limit %+v, want %+v", api.RateLimit, got)
				}
			}
			if !reflect.DeepEqual(api.Raw, tc.Body) {
				t.Fatalf("raw %v", api.Raw)
			}
			if !strings.Contains(err.Error(), want.MessageContains) {
				t.Fatal(err)
			}
		})
	}
}

func contractCaseNamed(t *testing.T, name string) contractCase {
	t.Helper()
	for _, tc := range loadContract(t) {
		if tc.Name == name {
			return tc
		}
	}
	t.Fatalf("no fixture %q", name)
	return contractCase{}
}

func TestBlockedFetchTargetIsNotAnAuthError(t *testing.T) {
	tc := contractCaseNamed(t, "target_blocked")
	c, _ := start(t, replyWith(403, tc.Body, nil), keyed())
	_, err := c.Fetch(context.Background(), "https://example.com")
	if errors.As(err, new(*keenable.AuthError)) {
		t.Fatal("a blocked fetch target is not an auth failure")
	}
	msg := err.Error()
	if !strings.HasPrefix(msg, "Keenable API error (403): ") || strings.Contains(msg, "KEENABLE_API_KEY") || !strings.Contains(msg, "not about your API key") {
		t.Fatal(msg)
	}
}

func TestNonRetryableErrorsDoNotTellTheAgentToRetry(t *testing.T) {
	tc := contractCaseNamed(t, "missing_parameter")
	c, _ := start(t, replyWith(400, tc.Body, nil), keyed())
	_, err := c.Search(context.Background(), "q", nil)
	if strings.Contains(err.Error(), "Retry the request") || !strings.Contains(err.Error(), deref(tc.Expect.Fix)) {
		t.Fatal(err)
	}
}

func TestNotYourLimitDoesNotAskForAKey(t *testing.T) {
	tc := contractCaseNamed(t, "search_rate_limited")
	c, _ := startKeyless(t, replyWith(429, tc.Body, tc.Headers), nil)
	_, err := c.Search(context.Background(), "q", nil)
	msg := err.Error()
	if strings.Contains(msg, "KEENABLE_API_KEY") || !strings.Contains(msg, "not your own limit") || !strings.Contains(msg, "Retry after 1s.") {
		t.Fatal(msg)
	}
}

func TestNotYourLimitWithoutFixStillDoesNotAskForAKey(t *testing.T) {
	c, _ := startKeyless(t, replyWith(429, map[string]any{"message": "busy", "code": "search_rate_limited"}, nil), nil)
	_, err := c.Search(context.Background(), "q", nil)
	want := "Keenable rate limit exceeded (429): busy. Wait for the rate limit window to reset, then retry. (rate_limit)"
	if err.Error() != want {
		t.Fatalf("%q", err.Error())
	}
}

func TestTheAPIsFixIsTheNextStepForEveryStatus(t *testing.T) {
	for _, name := range []string{"credentials_forbidden", "insufficient_credits", "rate_limit_per_second"} {
		t.Run(name, func(t *testing.T) {
			tc := contractCaseNamed(t, name)
			c, _ := startKeyless(t, replyWith(tc.Status, tc.Body, tc.Headers), nil)
			_, err := c.Search(context.Background(), "q", nil)
			msg := err.Error()
			if !strings.Contains(msg, ". "+deref(tc.Expect.Fix)) || strings.Contains(msg, "Check KEENABLE_API_KEY") ||
				strings.Contains(msg, "Add credits at") || strings.Contains(msg, "lift the keyless hourly cap") {
				t.Fatal(msg)
			}
		})
	}
}

func TestInsufficientCreditsKeepsTheOldCodeAndMessage(t *testing.T) {
	c, _ := startKeyless(t, jsonHandler(http.StatusPaymentRequired, map[string]any{"detail": "no credits"}), nil)
	_, err := c.Search(context.Background(), "q", nil)
	var credits *keenable.InsufficientCreditsError
	if !errors.As(err, &credits) || credits.Code() != keenable.CodeAPI {
		t.Fatal(err)
	}
	if !errors.As(err, new(*keenable.CreditsError)) {
		t.Fatal("CreditsError is the same type")
	}
	want := "Keenable: insufficient credits (402): no credits. Add credits at https://keenable.ai/console. (api_error)"
	if err.Error() != want {
		t.Fatalf("%q", err.Error())
	}
}

func TestTodaysAPILeavesTheNewFieldsEmpty(t *testing.T) {
	c, _ := startKeyless(t, jsonHandler(http.StatusTooManyRequests, map[string]any{"message": "hourly cap reached"}), nil)
	_, err := c.Search(context.Background(), "q", nil)
	api := apiErrorFrom(t, err)
	if api.APICode != "" || api.Fix != "" || api.DocsURL != "" || api.Retryable != nil || api.RetryAfter != 0 ||
		api.RequestID != "" || api.Param != "" || api.RateLimit != nil || api.BillingURL != "" ||
		api.AutoTopUpURL != "" || api.PayPerRequest != "" {
		t.Fatalf("%+v", api)
	}
	want := "Keenable rate limit exceeded (429): hourly cap reached. Set KEENABLE_API_KEY to lift the keyless hourly cap. Create a key at https://keenable.ai/console. (rate_limit)"
	if err.Error() != want {
		t.Fatalf("%q", err.Error())
	}

	c, _ = startKeyless(t, textHandler(http.StatusBadGateway, "upstream exploded"), nil)
	_, err = c.Search(context.Background(), "q", nil)
	if apiErrorFrom(t, err).Raw != nil {
		t.Fatal("a non-JSON body has no Raw")
	}
}

func TestRetryAfterSources(t *testing.T) {
	cases := []struct {
		name    string
		body    map[string]any
		headers map[string]string
		want    time.Duration
	}{
		{"header seconds", map[string]any{"message": "m"}, map[string]string{"Retry-After": "7"}, 7 * time.Second},
		{"older body field", map[string]any{"message": "m", "retryAfter": 3}, nil, 3 * time.Second},
		{"body wins", map[string]any{"retry_after_seconds": 4}, map[string]string{"Retry-After": "9"}, 4 * time.Second},
		{"malformed", map[string]any{"retry_after_seconds": -1}, map[string]string{"Retry-After": "soon"}, 0},
		{"oversized header", map[string]any{"message": "m"}, map[string]string{"Retry-After": strings.Repeat("9", 400)}, 365 * 24 * time.Hour},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c, _ := start(t, replyWith(429, tc.body, tc.headers), keyed())
			_, err := c.Search(context.Background(), "q", nil)
			if got := apiErrorFrom(t, err).RetryAfter; got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}

	t.Run("http date", func(t *testing.T) {
		when := time.Now().Add(30 * time.Second).UTC().Format(http.TimeFormat)
		c, _ := start(t, replyWith(503, map[string]any{"error": "x"}, map[string]string{"Retry-After": when}), keyed())
		_, err := c.Search(context.Background(), "q", nil)
		got := apiErrorFrom(t, err).RetryAfter
		if got < 25*time.Second || got > 31*time.Second {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("request id falls back to the header", func(t *testing.T) {
		c, _ := start(t, replyWith(429, map[string]any{"message": "m"}, map[string]string{"X-Request-Id": "req-h"}), keyed())
		_, err := c.Search(context.Background(), "q", nil)
		if id := apiErrorFrom(t, err).RequestID; id != "req-h" {
			t.Fatalf("%q", id)
		}
	})
}
