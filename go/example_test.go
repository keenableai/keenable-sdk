package keenable_test

import (
	"context"
	"errors"
	"fmt"
	"log"

	"github.com/keenableai/keenable-sdk/go"
)

func ExampleNew_keyless() {
	// A pointer to an empty string forces keyless even when KEENABLE_API_KEY is set.
	// A Go literal cannot be addressed, so the string lives in a variable.
	empty := ""
	client, err := keenable.New(&keenable.Options{APIKey: &empty})
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()
	fmt.Println(client.Keyless())
	// Output:
	// true
}

func ExampleInvalidRequestError() {
	empty := ""
	_, err := keenable.New(&keenable.Options{BaseURL: &empty})
	fmt.Println(err)
	var sdk keenable.Error
	if errors.As(err, &sdk) {
		fmt.Println(sdk.Code())
	}
	// Output:
	// baseURL must be an https:// URL with a host, got "" (invalid_request)
	// invalid_request
}

func ExampleClient_Search_domainFilters() {
	client, err := keenable.New(nil)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()

	results, err := client.Search(context.Background(), "security council resolution on sudan", &keenable.SearchOptions{
		IncludeDomains: []string{"press.un.org", "undocs.org", "documents.un.org"},
		ExcludeDomains: []string{"blogs.un.org"},
	})
	var api *keenable.APIError
	if errors.As(err, &api) && api.StatusCode == 400 {
		log.Fatalf("bad %s entry %q: %s", api.Field, api.Value, api.Reason)
	}
	if err != nil {
		log.Fatal(err)
	}
	for _, result := range results.Results {
		fmt.Println(result.URL)
	}
}
