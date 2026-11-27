package keenable

import (
	"context"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

var (
	waitsMu sync.Mutex
	waits   []time.Duration
)

// TestMain records retry waits instead of sleeping through them.
func TestMain(m *testing.M) {
	sleep = func(ctx context.Context, d time.Duration) error {
		waitsMu.Lock()
		waits = append(waits, d)
		waitsMu.Unlock()
		return ctx.Err()
	}
	os.Exit(m.Run())
}

// TakeWaits returns and clears the waits recorded since the last call.
func TakeWaits() []time.Duration {
	waitsMu.Lock()
	defer waitsMu.Unlock()
	out := waits
	waits = nil
	return out
}

var (
	Backoff    = backoff
	RetryDelay = retryDelay
)

var RetryAfterAt = retryAfterAt

var DebugEnabled = debugEnabled

// DebugLine is an attempt's slog attributes as "keenable: key=value ...", for
// the conformance cases. A status of 0 means failure says what failed.
func DebugLine(method, path string, attempt, status int, failure string, elapsedMS int64, retry bool, waitMS int64, requestID string) string {
	a := attemptLog{
		method: method, path: path, attempt: attempt, status: status, failure: failure,
		elapsedMS: elapsedMS, retry: retry, waitMS: waitMS, requestID: requestID,
	}
	parts := []string{}
	for _, attr := range a.attrs() {
		parts = append(parts, attr.Key+"="+attr.Value.String())
	}
	return "keenable: " + strings.Join(parts, " ")
}
