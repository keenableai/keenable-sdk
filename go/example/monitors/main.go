// Command monitors watches the web for a topic, reads what the monitor
// found, watches a pricing page for changes, and shows a webhook handler that
// verifies deliveries.
//
//	KEENABLE_API_KEY=keen_... go run ./example/monitors
package main

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"

	"github.com/keenableai/keenable-sdk/go"
)

func main() {
	client, err := keenable.New(nil)
	if err != nil {
		log.Fatal(err)
	}
	defer client.Close()
	ctx := context.Background()

	monitor, err := client.Monitors.Create(ctx, &keenable.MonitorCreateParams{
		Name:     "Open-weights LLMs",
		Search:   keenable.MonitorSearchParams{Query: "new open-weights LLM releases", MaxResults: 20},
		Schedule: &keenable.MonitorScheduleParams{Type: "interval", Value: "6h"},
		Metadata: map[string]string{"team": "research"},
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("created", monitor.ID)

	run, err := client.Monitors.Trigger(ctx, monitor.ID, nil)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("run", run.ID, "is", run.Status)

	results, err := client.Monitors.Results(ctx, monitor.ID, &keenable.MonitorResultsParams{MinImportance: 4})
	if err != nil {
		log.Fatal(err)
	}
	for _, result := range results.Data {
		fmt.Println(result.URL)
	}

	if _, err := client.Monitors.Delete(ctx, monitor.ID, nil); err != nil {
		log.Fatal(err)
	}

	// A page monitor watches one page and reports the changes worth telling.
	pricing, err := client.Monitors.Create(ctx, &keenable.MonitorCreateParams{
		Name: "Example pricing",
		Type: "page",
		Page: &keenable.MonitorPageTarget{
			URL:         "https://example.com/pricing",
			WatchFor:    "plan prices and new plans",
			Sensitivity: "meaningful",
		},
		Schedule: &keenable.MonitorScheduleParams{Type: "interval", Value: "6h"},
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("watching", pricing.Page.URL)

	versions, err := client.Monitors.Versions(ctx, pricing.ID, &keenable.MonitorVersionsParams{Limit: 10})
	if err != nil {
		log.Fatal(err)
	}
	for _, v := range versions.Data {
		if v.Diff != nil {
			fmt.Println("version", v.Version, "added", v.Diff.Added)
		}
	}

	if _, err := client.Monitors.Delete(ctx, pricing.ID, nil); err != nil {
		log.Fatal(err)
	}
}

// webhookHandler verifies each delivery before acting on it.
func webhookHandler(secret string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, "unreadable body", http.StatusBadRequest)
			return
		}
		event, err := keenable.VerifyWebhook(body, r.Header, secret, nil)
		if err != nil {
			http.Error(w, "bad signature", http.StatusBadRequest)
			return
		}
		if event.Type == "monitor.result.found" && event.Data.Result != nil {
			fmt.Println("new result:", event.Data.Result.URL)
		}
		if event.Type == "monitor.page.changed" && event.Data.Run != nil && event.Data.Run.Changes != nil && event.Data.Run.Changes.Summary != nil {
			fmt.Println("the page changed:", *event.Data.Run.Changes.Summary)
		}
	}
}
