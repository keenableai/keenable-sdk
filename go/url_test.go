package keenable

import (
	"strings"
	"testing"
)

func TestEndpointURLNeverBuildsAPublicBillingPath(t *testing.T) {
	base := "https://api.keenable.ai"
	empty, key := "", "sk-test"
	keyless, err := New(&Options{APIKey: &empty, BaseURL: &base})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer keyless.Close()
	keyed, err := New(&Options{APIKey: &key, BaseURL: &base})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	defer keyed.Close()
	for _, tc := range []struct {
		c        *Client
		endpoint string
		want     string
	}{
		{keyless, "billing", "/v1/billing"},
		{keyed, "billing", "/v1/billing"},
		{keyless, "search", "/v1/search/public"},
		{keyless, "fetch", "/v1/fetch/public"},
		{keyed, "search", "/v1/search"},
	} {
		got, err := tc.c.endpointURL(tc.endpoint, nil)
		if err != nil {
			t.Fatalf("endpointURL(%q): %v", tc.endpoint, err)
		}
		if !strings.HasSuffix(got, tc.want) {
			t.Errorf("endpointURL(%q) = %q, want suffix %q", tc.endpoint, got, tc.want)
		}
	}
}
