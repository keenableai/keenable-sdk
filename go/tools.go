package keenable

import (
	"cmp"
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// ToolDefinition is an OpenAI-compatible function tool.
//
// Pass [Tools] straight into a chat completion that speaks that schema.
type ToolDefinition struct {
	Type     string       `json:"type"`
	Function ToolFunction `json:"function"`
}

// ToolFunction is the function half of a [ToolDefinition].
type ToolFunction struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Parameters  map[string]any `json:"parameters"`
}

// SearchTool is the keenable_search function definition.
var SearchTool = newSearchTool()

// FetchTool is the keenable_fetch function definition. It requires urls.
var FetchTool = ToolDefinition{
	Type: "function",
	Function: ToolFunction{
		Name: "keenable_fetch",
		Description: "Fetch up to 20 web pages and return each one's main content as markdown. " +
			"Use after keenable_search when a search snippet is not enough. Add a prompt " +
			"to get back only the part you need from long pages.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"urls": map[string]any{
					"type":        "array",
					"items":       map[string]any{"type": "string"},
					"minItems":    1,
					"maxItems":    20,
					"description": "The URLs of the pages to read, 1 to 20.",
				},
				"max_chars": map[string]any{
					"type":        "integer",
					"minimum":     1,
					"description": "The most characters of content to return for each page.",
				},
				"prompt": map[string]any{
					"type": "string",
					"description": "An instruction applied to every page; each page's content is then only " +
						"the answer to it. Use it to get one detail from long pages.",
				},
				"max_age_hours": map[string]any{
					"type":    "number",
					"minimum": -1,
					"maximum": 720,
					"description": "How old Keenable's stored copy may be, in hours; an older copy is read " +
						"again from the source. 0 reads every page live. -1 reads only the stored " +
						"copy, never the live page; other negative values are refused.",
				},
			},
			"required": []string{"urls"},
		},
	},
}

// Tools is keenable_search and keenable_fetch, in that order.
var Tools = []ToolDefinition{SearchTool, FetchTool}

func newSearchTool() ToolDefinition {
	props := map[string]any{
		"query": map[string]any{
			"type":        "string",
			"description": "What to look for, described in natural language rather than keywords.",
		},
	}
	for name, prop := range toolProperties() {
		props[name] = prop
	}
	return ToolDefinition{
		Type: "function",
		Function: ToolFunction{
			Name: "keenable_search",
			Description: "Search the web for current information. Returns ranked pages with " +
				"their title, URL and extracted page text. Use this whenever the " +
				"answer depends on recent events or facts you are unsure about.",
			Parameters: map[string]any{
				"type":       "object",
				"properties": props,
				"required":   []string{"query"},
			},
		},
	}
}

// RunToolCall executes one tool call and returns text for a role=tool message.
//
// arguments may be a JSON string, []byte, json.RawMessage, or map[string]any.
// Anything else, including invalid JSON, is an [InvalidRequestError].
// Both tools render the same numbered block, so a model can cite a fetched
// page the way it cites a search result. A URL that failed while others were
// read becomes an error block; if none was read, its error is returned.
func RunToolCall(ctx context.Context, client *Client, name string, arguments any) (string, error) {
	return RunToolCallWithOptions(ctx, client, name, arguments, nil)
}

// ToolCallOptions are the optional settings of [RunToolCallWithOptions].
type ToolCallOptions struct {
	// SessionID is the agent run this call belongs to, sent as the call's
	// SessionID over Options.SessionID. Empty keeps the client's.
	SessionID string
}

// RunToolCallWithOptions is [RunToolCall] with the settings in
// [ToolCallOptions]. opts may be nil.
func RunToolCallWithOptions(ctx context.Context, client *Client, name string, arguments any, opts *ToolCallOptions) (string, error) {
	var sessionID string
	if opts != nil {
		sessionID = opts.SessionID
	}
	if client == nil {
		return "", &InvalidRequestError{msg: "RunToolCall needs a client. Call keenable.New and pass that client."}
	}
	args, err := parseArguments(arguments)
	if err != nil {
		return "", err
	}
	switch name {
	case "keenable_search":
		query, err := requireString(args["query"], "keenable_search needs a 'query'. Pass a JSON object with a query string.")
		if err != nil {
			return "", err
		}
		opts, err := toolSearchOptions(args)
		if err != nil {
			return "", err
		}
		opts.SessionID = sessionID
		resp, err := client.Search(ctx, query, opts)
		if err != nil {
			return "", err
		}
		return resp.ToContext(nil), nil
	case "keenable_fetch":
		urls, err := toolFetchURLs(args)
		if err != nil {
			return "", err
		}
		opts, err := toolFetchOptions(args)
		if err != nil {
			return "", err
		}
		opts.SessionID = sessionID
		resp, err := client.FetchWithOptions(ctx, urls, opts)
		if err != nil {
			return "", err
		}
		return pagesContext(resp.Results, opts.MaxChars)
	default:
		return "", &InvalidRequestError{msg: fmt.Sprintf("unknown Keenable tool: %q. Use keenable_search or keenable_fetch.", name)}
	}
}

func parseArguments(arguments any) (map[string]any, error) {
	switch v := arguments.(type) {
	case map[string]any:
		if v == nil {
			return map[string]any{}, nil
		}
		return v, nil
	case json.RawMessage:
		return decodeToolArgs(v)
	case []byte:
		return decodeToolArgs(v)
	case string:
		if v == "" {
			v = "{}"
		}
		return decodeToolArgs([]byte(v))
	default:
		return nil, &InvalidRequestError{msg: fmt.Sprintf(
			"tool call arguments must be a JSON string or an object, got %T. Pass the function arguments JSON.",
			arguments,
		)}
	}
}

func decodeToolArgs(raw []byte) (map[string]any, error) {
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, &InvalidRequestError{msg: fmt.Sprintf(
			"tool call arguments are not valid JSON: %q. Pass a JSON object such as {\"query\":\"...\"}.",
			string(raw),
		)}
	}
	obj, ok := parsed.(map[string]any)
	if !ok {
		return nil, &InvalidRequestError{msg: fmt.Sprintf(
			"tool call arguments must be a JSON object, got %q. Pass an object, not an array or a scalar.",
			string(raw),
		)}
	}
	return obj, nil
}

func requireString(v any, message string) (string, error) {
	s, ok := v.(string)
	if !ok || strings.TrimSpace(s) == "" {
		return "", &InvalidRequestError{msg: message}
	}
	return s, nil
}

// toolFetchURLs reads urls: 1 to 20 non-blank strings.
func toolFetchURLs(args map[string]any) ([]string, error) {
	raw := args["urls"]
	bad := &InvalidRequestError{msg: "keenable_fetch needs 'urls': a list of 1 to 20 URLs."}
	switch v := raw.(type) {
	case string:
		raw = []any{v}
	case []string:
		list := make([]any, len(v))
		for i, s := range v {
			list[i] = s
		}
		raw = list
	}
	list, ok := raw.([]any)
	if !ok || len(list) == 0 {
		return nil, bad
	}
	urls := make([]string, len(list))
	for i, v := range list {
		s, err := requireString(v, bad.msg)
		if err != nil {
			return nil, err
		}
		urls[i] = s
	}
	return urls, nil
}

// toolFetchOptions reads max_chars, prompt and max_age_hours; null and "" are unset.
func toolFetchOptions(args map[string]any) (*FetchOptions, error) {
	opts := &FetchOptions{}
	if v, ok := toolNumber(args["max_chars"]); ok {
		if v < 1 || v != float64(int(v)) {
			return nil, &InvalidRequestError{msg: fmt.Sprintf("max_chars must be a positive integer, got %v.", v)}
		}
		opts.MaxChars = int(v)
	} else if !toolUnset(args["max_chars"]) {
		return nil, &InvalidRequestError{msg: "max_chars must be a positive integer. Pass a JSON number."}
	}
	if s, ok := args["prompt"].(string); ok {
		opts.Prompt = s
	} else if !toolUnset(args["prompt"]) {
		return nil, &InvalidRequestError{msg: "prompt must be a string."}
	}
	if v, ok := toolNumber(args["max_age_hours"]); ok {
		opts.MaxAgeHours = &v
	} else if !toolUnset(args["max_age_hours"]) {
		return nil, &InvalidRequestError{msg: "max_age_hours must be a number of hours. Pass a JSON number."}
	}
	return opts, nil
}

func toolNumber(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	}
	return 0, false
}

func toolUnset(v any) bool {
	return v == nil || v == ""
}

// pagesContext renders each page as a numbered, citable block and a failed
// URL as an error block; it fails only when no URL could be read.
func pagesContext(pages []Page, maxChars int) (string, error) {
	if len(pages) == 0 {
		return "", &APIError{StatusCode: 200, msg: "the Keenable API returned no result for the URL"}
	}
	var firstErr *FetchError
	failed := 0
	for i := range pages {
		if e := pages[i].Error; e != nil {
			failed++
			if firstErr == nil {
				firstErr = e
			}
		}
	}
	if failed == len(pages) {
		e := firstErr
		return "", &APIError{StatusCode: e.Status, APICode: e.Code, Type: e.Type, Title: e.Error, Fix: e.Fix, Retryable: e.Retryable, msg: cmp.Or(e.Message, e.Error)}
	}
	// The API already cut each page to max_chars; leave room for its header.
	// Without max_chars, the default budget is split across the pages.
	ctxOpts := &ContextOptions{MaxChars: max(DefaultContextMaxChars/len(pages), 1_000)}
	if maxChars > 0 {
		ctxOpts.MaxChars = maxChars + 1_000
	}
	blocks := make([]string, len(pages))
	for i := range pages {
		page := &pages[i]
		if e := page.Error; e != nil {
			blocks[i] = fmt.Sprintf("[%d] %s - failed: %s", i+1, page.URL, cmp.Or(e.Message, e.Error, "the page could not be read"))
			continue
		}
		blocks[i] = fmt.Sprintf("[%d]%s", i+1, strings.TrimPrefix(page.ToContext(ctxOpts), "[1]"))
	}
	return strings.Join(blocks, "\n\n"), nil
}
