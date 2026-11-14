package keenable

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"sync/atomic"
	"time"
)

const ndjsonContentType = "application/x-ndjson"

// FetchStreamItem is one page from [Client.FetchManyStream], as soon as it is
// read. Index is its position in the urls given, so Result is the entry for
// urls[Index]. Items arrive in the order pages finish, not in list order.
type FetchStreamItem struct {
	Index  int
	Result FetchResult
}

// FetchStreamSummary is the stream's final line: what [Client.FetchMany]
// returns besides its results.
type FetchStreamSummary struct {
	Warnings []FetchWarning
	// RequestID is the API's id for this request. Quote it when reporting a
	// problem.
	RequestID string
	LatencyMS *int
	SessionID *string
	// Usage is what the call cost, as the API sent it; nil without a key.
	Usage map[string]any
	Raw   map[string]any
}

// FetchStream reads the pages of [Client.FetchManyStream] as the API sends
// them. Use it like a bufio.Scanner:
//
//	stream, err := client.FetchManyStream(ctx, urls, nil)
//	if err != nil { ... }
//	defer stream.Close()
//	for stream.Next() {
//		item := stream.Item()
//		fmt.Println(item.Index, item.Result.URL)
//	}
//	if err := stream.Err(); err != nil { ... }
//	fmt.Println(stream.Summary().RequestID)
type FetchStream struct {
	body      io.ReadCloser
	lines     *bufio.Reader
	ctx       context.Context
	cancel    context.CancelFunc
	timer     *time.Timer
	timeout   time.Duration
	timedOut  *atomic.Bool
	status    int
	requestID string
	item      FetchStreamItem
	summary   *FetchStreamSummary
	err       error
	done      bool
}

// FetchManyStream is [Client.FetchMany] that hands over each page as soon as
// it is read, with Accept: application/x-ndjson.
//
// It returns once the API has answered with a stream; a failure of the whole
// call before then is returned as [Client.FetchMany] returns it, and is
// retried the same way. Then call Next until it returns false, and check Err:
// a failure after pages were sent is an *[APIError] there, and a stream cut
// off before its final line a *[ConnectionError]. Summary holds the final
// line once Next has returned false without an error. The timeout is how long
// to wait for each next line. Close releases the connection; call it when you
// stop early. Billing, limits and the deadline are the same as FetchMany.
func (c *Client) FetchManyStream(ctx context.Context, urls []string, opts *FetchManyOptions) (*FetchStream, error) {
	if err := requireClient(c); err != nil {
		return nil, err
	}
	if err := requireContext(ctx); err != nil {
		return nil, err
	}
	if len(urls) == 0 {
		return nil, &InvalidRequestError{msg: "FetchManyStream() needs a non-empty list of URLs"}
	}
	for _, u := range urls {
		if err := rejectPrivateFetchTarget(u); err != nil {
			return nil, err
		}
	}
	if err := checkCacheOnly(opts); err != nil {
		return nil, err
	}
	body, err := json.Marshal(fetchManyPayload(urls, opts))
	if err != nil {
		return nil, &InvalidRequestError{msg: "could not encode the fetch request: " + err.Error() + ". Pass JSON-encodable arguments."}
	}
	timeout := c.sdkTimeout
	retries := c.maxRetries
	var extra map[string]string
	if opts != nil {
		if opts.Timeout != nil {
			if *opts.Timeout <= 0 {
				return nil, &InvalidRequestError{msg: fmt.Sprintf("RequestOptions.Timeout must be more than zero, got %s. Leave it nil to keep the client's.", *opts.Timeout)}
			}
			timeout = *opts.Timeout
		}
		if opts.MaxRetries != nil {
			if *opts.MaxRetries < 0 {
				return nil, &InvalidRequestError{msg: fmt.Sprintf("MaxRetries must be zero or more, got %d", *opts.MaxRetries)}
			}
			retries = *opts.MaxRetries
		}
		if err := checkHeaders(opts.Headers); err != nil {
			return nil, err
		}
		extra = opts.Headers
	}
	timeout = min(timeout, maxTimeout)
	rawURL, err := c.endpointURL("fetch", nil)
	if err != nil {
		return nil, err
	}
	header := c.headers(true, extra)
	header.Set("Accept", ndjsonContentType)
	for retry := 0; ; retry++ {
		stream, err := c.openStream(ctx, rawURL, body, header, timeout)
		if err == nil {
			return stream, nil
		}
		if retry >= retries {
			return nil, err
		}
		wait, ok := retryDelay(err, retry, rand.Float64())
		if !ok {
			return nil, err
		}
		if deadline, has := ctx.Deadline(); has && time.Until(deadline) <= wait {
			return nil, err
		}
		if serr := sleep(ctx, wait); serr != nil {
			return nil, serr
		}
	}
}

// openStream sends the request and checks the status before any line is read.
func (c *Client) openStream(ctx context.Context, rawURL string, body []byte, header http.Header, timeout time.Duration) (*FetchStream, error) {
	reqCtx, cancel := context.WithCancel(ctx)
	timedOut := &atomic.Bool{}
	var timer *time.Timer
	if timeout > 0 {
		timer = time.AfterFunc(timeout, func() {
			timedOut.Store(true)
			cancel()
		})
	}
	stop := func() {
		if timer != nil {
			timer.Stop()
		}
		cancel()
	}
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, rawURL, bytes.NewReader(body))
	if err != nil {
		stop()
		return nil, &InvalidRequestError{msg: "could not build the request: " + err.Error() + ". Check Options.BaseURL or KEENABLE_API_URL."}
	}
	req.Header = header.Clone()
	resp, err := c.requestClient().Do(req)
	if err != nil {
		stop()
		return nil, streamFailure(ctx, timedOut, err, timeout)
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		resp.Body.Close()
		stop()
		where := ""
		if loc := headerValue(resp.Header, "Location"); loc != "" {
			where = " to " + loc
		}
		return nil, &ConnectionError{redirect: true, msg: fmt.Sprintf(
			"the Keenable API redirected%s. The redirect was not followed, so the API key was not sent. Check KEENABLE_API_URL.",
			where,
		)}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		raw, rerr := io.ReadAll(resp.Body)
		resp.Body.Close()
		stop()
		if rerr != nil {
			return nil, streamFailure(ctx, timedOut, rerr, timeout)
		}
		return nil, toAPIError(resp.StatusCode, raw, resp.Header, c.Keyless())
	}
	return &FetchStream{
		body:      resp.Body,
		lines:     bufio.NewReader(resp.Body),
		ctx:       ctx,
		cancel:    cancel,
		timer:     timer,
		timeout:   timeout,
		timedOut:  timedOut,
		status:    resp.StatusCode,
		requestID: headerValue(resp.Header, "X-Request-Id"),
	}, nil
}

// streamFailure is the error for a failed read: the caller's own context
// error, a timeout, or a connection error.
func streamFailure(caller context.Context, timedOut *atomic.Bool, err error, timeout time.Duration) error {
	if caller.Err() != nil {
		return caller.Err()
	}
	if timedOut.Load() {
		return &ConnectionError{timeout: true, msg: fmt.Sprintf(
			"the Keenable API sent nothing for %s. Raise Options.Timeout.",
			timeout,
		)}
	}
	return &ConnectionError{msg: fmt.Sprintf("could not read from the Keenable API: %v. Retry the URLs that have no item.", err)}
}

// Next reads the next page. It returns false at the end of the stream or on
// an error; check Err.
func (s *FetchStream) Next() bool {
	if s == nil || s.done {
		return false
	}
	for {
		if s.timer != nil {
			s.timer.Reset(s.timeout)
		}
		line, err := s.lines.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			item, ok, lerr := s.readLine(line)
			if lerr != nil {
				return s.fail(lerr)
			}
			if s.summary != nil {
				s.finish()
				return false
			}
			if ok {
				s.item = item
				return true
			}
		}
		if err == io.EOF {
			return s.fail(&ConnectionError{msg: "the Keenable API stream ended before its final line. Retry the URLs that have no item."})
		}
		if err != nil {
			return s.fail(streamFailure(s.ctx, s.timedOut, err, s.timeout))
		}
	}
}

// readLine reads one non-blank line: an item (ok), the final line (which sets
// summary), or a line to skip.
func (s *FetchStream) readLine(line []byte) (FetchStreamItem, bool, error) {
	parsed, ok := decodeJSON(bytes.TrimSpace(line))
	data, isObject := parsed.(map[string]any)
	if !ok || !isObject {
		snippet := bytes.TrimSpace(line)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return FetchStreamItem{}, false, &APIError{
			StatusCode: s.status,
			RequestID:  s.requestID,
			code:       CodeAPI,
			msg:        fmt.Sprintf("Keenable API sent a stream line that is not a JSON object: %q. Retry the URLs that have no item.", string(snippet)),
		}
	}
	if data["done"] == true {
		return FetchStreamItem{}, false, s.readFinal(data)
	}
	index := count(data["index"])
	if index == nil {
		return FetchStreamItem{}, false, nil
	}
	entry := make(map[string]any, len(data))
	for k, v := range data {
		if k != "index" {
			entry[k] = v
		}
	}
	return FetchStreamItem{Index: *index, Result: fetchResultFromJSON(entry)}, true, nil
}

func (s *FetchStream) readFinal(data map[string]any) error {
	id := s.requestID
	if v := nonEmptyString(data["request_id"]); v != nil {
		id = *v
	}
	if e, ok := data["error"].(map[string]any); ok {
		code := asString(e["code"])
		msg := asString(e["message"])
		if msg == "" {
			msg = "the call failed"
		}
		api := &APIError{
			StatusCode: s.status,
			Body:       msg,
			RequestID:  id,
			APICode:    code,
			Type:       deriveType(s.status, code),
			Title:      msg,
			code:       CodeAPI,
			msg:        msg,
		}
		if r, ok := e["retryable"].(bool); ok {
			api.Retryable = &r
		}
		return api
	}
	summary := &FetchStreamSummary{
		Warnings:  []FetchWarning{},
		RequestID: id,
		LatencyMS: count(data["latency_ms"]),
		SessionID: nonEmptyString(data["session_id"]),
		Raw:       data,
	}
	if usage, ok := data["usage"].(map[string]any); ok {
		summary.Usage = usage
	}
	for _, item := range objects(data["warnings"]) {
		summary.Warnings = append(summary.Warnings, FetchWarning{
			Code:    asString(item["code"]),
			Path:    asString(item["path"]),
			Message: asString(item["message"]),
		})
	}
	s.summary = summary
	return nil
}

func (s *FetchStream) fail(err error) bool {
	s.err = err
	s.finish()
	return false
}

func (s *FetchStream) finish() {
	s.done = true
	s.release()
}

func (s *FetchStream) release() {
	if s.timer != nil {
		s.timer.Stop()
	}
	if s.body != nil {
		s.body.Close()
	}
	if s.cancel != nil {
		s.cancel()
	}
}

// Item is the page the last call to Next read.
func (s *FetchStream) Item() FetchStreamItem { return s.item }

// Err is why the stream stopped early; nil when it ended with its final line.
func (s *FetchStream) Err() error {
	if s == nil {
		return nil
	}
	return s.err
}

// Summary is the final line, once Next has returned false without an error;
// nil until then.
func (s *FetchStream) Summary() *FetchStreamSummary {
	if s == nil {
		return nil
	}
	return s.summary
}

// Close stops reading and releases the connection. Safe to call more than
// once and after the stream ended.
func (s *FetchStream) Close() error {
	if s == nil {
		return nil
	}
	s.done = true
	s.release()
	return nil
}
