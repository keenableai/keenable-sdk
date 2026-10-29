// Package keenable is the official Go SDK for the Keenable web search API.
//
// Keyless by default. [New] with a nil [Options] works with no account; an
// API key only lifts the hourly rate limit.
//
//	client, err := keenable.New(nil)
//	if err != nil {
//		log.Fatal(err)
//	}
//	defer client.Close()
//
//	results, err := client.Search(context.Background(), "fastest inference providers 2026", nil)
//	if err != nil {
//		log.Fatal(err)
//	}
//	fmt.Println(results.ToContext(nil))
package keenable
