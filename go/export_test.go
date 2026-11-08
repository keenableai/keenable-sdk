package keenable

import (
	"context"
	"os"
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
