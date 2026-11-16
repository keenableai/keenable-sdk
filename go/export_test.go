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
//
// It also points the config directory at a temporary one: a keyless client
// reads and writes <config dir>/keenable/client-id, and no test may use the
// real home directory.
func TestMain(m *testing.M) {
	config, err := os.MkdirTemp("", "keenable-test-config-")
	if err != nil {
		panic(err)
	}
	os.Setenv("XDG_CONFIG_HOME", config)
	os.Unsetenv("KEENABLE_NO_CLIENT_ID")
	sleep = func(ctx context.Context, d time.Duration) error {
		waitsMu.Lock()
		waits = append(waits, d)
		waitsMu.Unlock()
		return ctx.Err()
	}
	code := m.Run()
	os.RemoveAll(config)
	os.Exit(code)
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

var (
	ValidClientID = validClientID
	ClientIDPath  = clientIDPath
)
