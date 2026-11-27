// Command smoke is a live smoke test: one keyless search and one keyless fetch
// against production. The smoke workflow copies it into a scratch module that
// requires the SDK (this repo's copy, or the latest release) and runs it.
// It exits non-zero, with the reason, if either call fails or comes back empty.
package main

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/keenableai/keenable-sdk/go"
)

const (
	query = "how do solar panels work"
	url   = "https://example.com"
	// The page's title and text both say what example.com is for; checking
	// for the word keeps the test from breaking when the wording changes.
	expect = "example"
)

func fail(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "smoke FAILED (go, keenable %s): %s\n", keenable.Version, fmt.Sprintf(format, args...))
	os.Exit(1)
}

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	client, err := keenable.New(nil)
	if err != nil {
		fail("new client: %v", err)
	}
	defer client.Close()

	results, err := client.Search(ctx, query, nil)
	if err != nil {
		fail("search %q: %v", query, err)
	}
	if len(results.Results) == 0 {
		fail("search %q returned no results (request %s)", query, results.RequestID)
	}
	first := results.Results[0]
	if !strings.HasPrefix(first.URL, "http") {
		fail("first search result has no URL: %+v", first)
	}
	fmt.Printf("search: %d results, first %s\n", len(results.Results), first.URL)

	response, err := client.Fetch(ctx, []string{url})
	if err != nil {
		fail("fetch %s: %v", url, err)
	}
	if len(response.Results) != 1 {
		fail("fetch returned %d pages for 1 URL", len(response.Results))
	}
	page := response.Results[0]
	if page.Error != nil {
		fail("fetch %s: %d %s %s", url, page.Error.Status, page.Error.Code, page.Error.Error)
	}
	if strings.TrimSpace(page.Content) == "" || !strings.Contains(strings.ToLower(page.Title+page.Content), expect) {
		fail("fetch %s: unexpected page %q: %.200q", url, page.Title, page.Content)
	}
	fmt.Printf("fetch: %s %d chars\n", page.URL, len(page.Content))
	fmt.Printf("smoke ok (go, keenable %s)\n", keenable.Version)
}
