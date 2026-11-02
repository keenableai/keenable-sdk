package keenable_test

import (
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
