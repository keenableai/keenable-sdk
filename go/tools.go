package keenable

import (
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

// FetchTool is the keenable_fetch function definition.
var FetchTool = ToolDefinition{
	Type: "function",
	Function: ToolFunction{
		Name: "keenable_fetch",
		Description: "Fetch one web page and return its main content as markdown. Use " +
			"after keenable_search when a search snippet is not enough.",
		Parameters: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"url": map[string]any{
					"type":        "string",
					"description": "The URL of the page to read.",
				},
			},
			"required": []string{"url"},
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
// page the way it cites a search result.
func RunToolCall(ctx context.Context, client *Client, name string, arguments any) (string, error) {
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
		resp, err := client.Search(ctx, query, toolSearchOptions(args))
		if err != nil {
			return "", err
		}
		return resp.ToContext(nil), nil
	case "keenable_fetch":
		pageURL, err := requireString(args["url"], "keenable_fetch needs a 'url'. Pass a JSON object with an https URL.")
		if err != nil {
			return "", err
		}
		page, err := client.Fetch(ctx, pageURL)
		if err != nil {
			return "", err
		}
		return page.ToContext(nil), nil
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
