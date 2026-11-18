// Command monitors watches the web for a topic, reads what the monitor
// found, and shows a webhook handler that verifies deliveries.
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

	pages, err := client.Monitors.Pages(ctx, monitor.ID, &keenable.MonitorPagesParams{MinImportance: 4})
	if err != nil {
		log.Fatal(err)
	}
	for _, page := range pages.Data {
		fmt.Println(page.URL)
	}

	if _, err := client.Monitors.Delete(ctx, monitor.ID, nil); err != nil {
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
		if event.Type == "monitor.hit" && event.Data.Result != nil {
			fmt.Println("new page:", event.Data.Result.URL)
		}
	}
}
