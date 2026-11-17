package keenable

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// DefaultWebhookTolerance is how far a delivery's timestamp may be from now.
const DefaultWebhookTolerance = 5 * time.Minute

// WebhookOptions are the optional arguments to [VerifyWebhook].
type WebhookOptions struct {
	// Tolerance is how far the delivery's timestamp may be from now. Zero
	// means [DefaultWebhookTolerance].
	Tolerance time.Duration
	// Now is the current time; tests pin it. Zero means time.Now().
	Now time.Time
}

// WebhookEventData is what an event is about. Which field is set depends on
// the event's Type.
type WebhookEventData struct {
	MonitorID string `json:"monitor_id"`
	// Monitor is set on monitor.created, updated, deleted and disabled.
	Monitor *Monitor `json:"monitor,omitempty"`
	// Run is set on monitor.run.created, completed and failed.
	Run *MonitorRun `json:"run,omitempty"`
	// Result is set on monitor.hit and monitor.update.
	Result *MonitorResult `json:"result,omitempty"`
	// Reason is why, on monitor.disabled.
	Reason *string `json:"reason,omitempty"`
}

// WebhookEvent is a verified webhook event.
type WebhookEvent struct {
	// ID is the delivery's id, the same across retries: use it to drop
	// repeats.
	ID        string           `json:"id"`
	Type      string           `json:"type"`
	CreatedAt string           `json:"created_at"`
	Data      WebhookEventData `json:"data"`
	// Metadata is the monitor's metadata.
	Metadata map[string]string `json:"metadata"`
	// Raw is the unmodified JSON object.
	Raw map[string]any `json:"-"`
}

func webhookKey(secret string) []byte {
	text := strings.TrimPrefix(secret, "whsec_")
	if key, err := base64.StdEncoding.DecodeString(text); err == nil && text != "" {
		return key
	}
	return []byte(text)
}

// VerifyWebhook checks a webhook delivery's signature (Standard Webhooks)
// and returns the event it carries. Pass the body exactly as received,
// before any JSON parsing, and the request's headers. secret is the
// monitor's Webhook.Secret (whsec_...). opts may be nil.
//
// It returns a [*WebhookVerificationError] when the delivery is not authentic
// or not fresh.
func VerifyWebhook(payload []byte, headers http.Header, secret string, opts *WebhookOptions) (*WebhookEvent, error) {
	fail := func(format string, args ...any) (*WebhookEvent, error) {
		return nil, &WebhookVerificationError{msg: fmt.Sprintf(format, args...)}
	}
	if strings.TrimSpace(secret) == "" {
		return fail("the webhook secret is empty: pass the monitor's Webhook.Secret")
	}
	tolerance := DefaultWebhookTolerance
	now := time.Now()
	if opts != nil {
		if opts.Tolerance < 0 {
			return fail("Tolerance must be positive")
		}
		if opts.Tolerance > 0 {
			tolerance = opts.Tolerance
		}
		if !opts.Now.IsZero() {
			now = opts.Now
		}
	}
	get := func(name string) string {
		if v := headers.Get(name); v != "" {
			return v
		}
		for k, vs := range headers {
			if strings.EqualFold(k, name) && len(vs) > 0 {
				return vs[0]
			}
		}
		return ""
	}
	id := get("webhook-id")
	stamp := strings.TrimSpace(get("webhook-timestamp"))
	signatures := get("webhook-signature")
	if id == "" || stamp == "" || signatures == "" {
		return fail("missing webhook-id, webhook-timestamp or webhook-signature header")
	}
	for _, r := range stamp {
		if r < '0' || r > '9' {
			return fail("webhook-timestamp is not a Unix time: %q", stamp)
		}
	}
	sent, err := strconv.ParseFloat(stamp, 64)
	if err != nil {
		return fail("webhook-timestamp is not a Unix time: %q", stamp)
	}
	clock := float64(now.UnixNano()) / 1e9
	if math.Abs(clock-sent) > tolerance.Seconds() {
		return fail("webhook-timestamp is too far from now: the delivery is stale or the clock is off")
	}
	mac := hmac.New(sha256.New, webhookKey(secret))
	mac.Write([]byte(id + "." + stamp + "."))
	mac.Write(payload)
	expected := []byte(base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	matched := false
	for _, candidate := range strings.Fields(signatures) {
		version, sig, ok := strings.Cut(candidate, ",")
		if ok && version == "v1" && hmac.Equal([]byte(sig), expected) {
			matched = true
		}
	}
	if !matched {
		return fail("no webhook-signature matches: check the secret and verify the raw body")
	}
	data, ok := decodeJSON(payload)
	obj, isObject := data.(map[string]any)
	if !ok || !isObject {
		return fail("the signed body is not a JSON object")
	}
	var event WebhookEvent
	if err := json.Unmarshal(payload, &event); err != nil {
		return fail("the signed body is not a webhook event: %v", err)
	}
	event.Raw = obj
	return &event, nil
}
