//go:build ignore

// Smoke test of the Go SDK as tagged: one keyless search against prod.
// Run in a fresh module after `go get github.com/keenableai/keenable-sdk/go@v<version>`:
//
//	go run smoke.go <version>
package main

import (
	"context"
	"fmt"
	"log"
	"net/url"
	"os"
	"strings"

	keenable "github.com/keenableai/keenable-sdk/go"
)

func main() {
	expected := os.Args[1]
	if keenable.Version != expected {
		log.Fatalf("installed keenable %s, expected %s", keenable.Version, expected)
	}
	empty := ""
	client, err := keenable.New(&keenable.Options{APIKey: &empty})
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()
	res, err := client.Search(context.Background(), "albert einstein wikipedia", &keenable.SearchOptions{
		ExcludeDomains: []string{"wikipedia.org"},
	})
	if err != nil {
		log.Fatal(err)
	}
	if len(res.Results) == 0 {
		log.Fatal("no results")
	}
	for _, r := range res.Results {
		u, err := url.Parse(r.URL)
		if err != nil {
			log.Fatalf("bad result URL %q: %v", r.URL, err)
		}
		if h := u.Hostname(); h == "wikipedia.org" || strings.HasSuffix(h, ".wikipedia.org") {
			log.Fatalf("exclude_domains leaked: %s", h)
		}
	}
	fmt.Printf("keenable %s: %d results, none from wikipedia.org\n", expected, len(res.Results))
}
