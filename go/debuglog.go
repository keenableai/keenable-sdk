package keenable

import (
	"context"
	"errors"
	"log/slog"
	"net/url"
	"os"
	"strings"
	"time"
)

// Debug logging: one record per attempt with the method, the URL's path, the
// attempt number, the status (or what failed), the elapsed time, the retry
// decision and wait, and the request id. Never the API key, a header, the
// query string or a body. The fields are the same in every Keenable SDK:
// scripts/conformance/README.md.

// maxLoggedRequestID is the longest request id logged; a longer one is left out.
const maxLoggedRequestID = 128

// attemptLog is what one attempt did.
type attemptLog struct {
	method  string
	path    string
	attempt int // 1 for the first
	// status is the HTTP status, or 0 when none counts and failure says what
	// failed instead: timeout, redirect, canceled or connection.
	status    int
	failure   string
	elapsedMS int64
	retry     bool
	waitMS    int64 // only logged when retry is true
	requestID string
}

// debugEnabled reports whether a KEENABLE_LOG value turns debug logging on:
// "debug", trimmed, in any letter case.
func debugEnabled(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), "debug")
}

// resolveLogger is the logger a client uses: Options.Logger, else a stderr
// text handler at debug level when KEENABLE_LOG=debug, else none.
func resolveLogger(logger *slog.Logger) *slog.Logger {
	if logger != nil {
		return logger
	}
	if !debugEnabled(os.Getenv("KEENABLE_LOG")) {
		return nil
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelDebug}))
}

// loggableID is the request id when it is short printable ASCII, else "".
func loggableID(id string) string {
	if id == "" || len(id) > maxLoggedRequestID {
		return ""
	}
	for i := 0; i < len(id); i++ {
		if id[i] < 0x21 || id[i] > 0x7e {
			return ""
		}
	}
	return id
}

// attrs are the record's attributes, in the shared order.
func (a attemptLog) attrs() []slog.Attr {
	attrs := []slog.Attr{
		slog.String("method", a.method),
		slog.String("path", a.path),
		slog.Int("attempt", a.attempt),
	}
	if a.status != 0 {
		attrs = append(attrs, slog.Int("status", a.status))
	} else {
		attrs = append(attrs, slog.String("error", a.failure))
	}
	attrs = append(attrs, slog.Int64("elapsed_ms", a.elapsedMS), slog.Bool("retry", a.retry))
	if a.retry {
		attrs = append(attrs, slog.Int64("wait_ms", a.waitMS))
	}
	if id := loggableID(a.requestID); id != "" {
		attrs = append(attrs, slog.String("request_id", id))
	}
	return attrs
}

// failureOf is a failed attempt's status, or what failed instead, and its
// request id.
func failureOf(err error) (status int, failure, requestID string) {
	var api *APIError
	if errors.As(err, &api) {
		return api.StatusCode, "", api.RequestID
	}
	var conn *ConnectionError
	if errors.As(err, &conn) {
		switch {
		case conn.timeout:
			return 0, "timeout", ""
		case conn.redirect:
			return 0, "redirect", ""
		}
		return 0, "connection", ""
	}
	if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return 0, "canceled", ""
	}
	return 0, "connection", ""
}

// logAttempt logs one attempt at debug level when the client has a logger
// that takes it.
func (c *Client) logAttempt(ctx context.Context, rawURL string, a attemptLog, started time.Time) {
	if c.logger == nil || !c.logger.Enabled(ctx, slog.LevelDebug) {
		return
	}
	if u, err := url.Parse(rawURL); err == nil {
		a.path = u.EscapedPath()
	}
	a.elapsedMS = time.Since(started).Milliseconds()
	c.logger.LogAttrs(ctx, slog.LevelDebug, "keenable", a.attrs()...)
}
