package keenable

import (
	"encoding/json"
	"reflect"
)

// The search filter set, declared once.
//
// The client builds its request body from this table, the tool schema builds
// its properties from the tool-exposed rows, and RunToolCall uses those same
// rows as its allow-list. Adding a filter is one row here plus the field on
// SearchOptions.

type filter struct {
	wire        string
	description string
	jsonType    string
	toolExposed bool
}

var searchFilters = []filter{
	{
		wire:        "site",
		description: "Optional. Restrict results to one domain, e.g. 'arxiv.org'.",
		toolExposed: true,
	},
	{
		wire: "exclude_domains",
		description: "Optional. Never return results from these hosts or their subdomains, " +
			"e.g. 'pinterest.com'. Hosts only, no paths or wildcards. Up to 1,000.",
		jsonType:    "array",
		toolExposed: true,
	},
	{
		wire:        "published_after",
		description: "Optional. Only pages published on or after this date (YYYY-MM-DD).",
		toolExposed: true,
	},
	{
		wire:        "published_before",
		description: "Optional. Only pages published on or before this date (YYYY-MM-DD).",
	},
	{
		wire:        "acquired_after",
		description: "Optional. Only pages indexed on or after this date (YYYY-MM-DD).",
	},
	{
		wire:        "acquired_before",
		description: "Optional. Only pages indexed on or before this date (YYYY-MM-DD).",
	},
	{
		wire:        "snippet_max_length",
		description: "Optional. Cap the characters of page text returned per result.",
		jsonType:    "integer",
	},
	{
		wire:        "max_results",
		description: "Optional. How many results to return, 1 to 50. The API default is 10.",
		jsonType:    "integer",
	},
	{
		wire: "query_time",
		description: "Optional. Search the index as it stood at this moment: pages newer than it are " +
			"excluded. Not a recency filter (use published_after for that). An ISO 8601 " +
			"datetime, YYYY-MM-DD, or an offset back from now such as '7d'.",
	},
}

func applyFilters(payload map[string]any, opts *SearchOptions) {
	if opts == nil {
		return
	}
	for _, f := range searchFilters {
		if v, ok := f.value(opts); ok {
			payload[f.wire] = v
		}
	}
}

func (f filter) value(opts *SearchOptions) (any, bool) {
	switch f.wire {
	case "site":
		if opts.Site == "" {
			return nil, false
		}
		return opts.Site, true
	case "exclude_domains":
		if opts.excludeDomainsJSON != nil {
			return opts.excludeDomainsJSON, true
		}
		if opts.ExcludeDomains == nil {
			return nil, false
		}
		return opts.ExcludeDomains, true
	case "published_after":
		if opts.PublishedAfter == "" {
			return nil, false
		}
		return opts.PublishedAfter, true
	case "published_before":
		if opts.PublishedBefore == "" {
			return nil, false
		}
		return opts.PublishedBefore, true
	case "acquired_after":
		if opts.AcquiredAfter == "" {
			return nil, false
		}
		return opts.AcquiredAfter, true
	case "acquired_before":
		if opts.AcquiredBefore == "" {
			return nil, false
		}
		return opts.AcquiredBefore, true
	case "snippet_max_length":
		if opts.SnippetMaxLength == nil {
			return nil, false
		}
		return *opts.SnippetMaxLength, true
	case "max_results":
		if opts.MaxResults == 0 {
			return nil, false
		}
		return opts.MaxResults, true
	case "query_time":
		if opts.QueryTime == "" {
			return nil, false
		}
		return opts.QueryTime, true
	default:
		return nil, false
	}
}

func toolProperties() map[string]any {
	props := make(map[string]any)
	for _, f := range searchFilters {
		if !f.toolExposed {
			continue
		}
		kind := f.jsonType
		if kind == "" {
			kind = "string"
		}
		prop := map[string]any{
			"type":        kind,
			"description": f.description,
		}
		if kind == "array" {
			prop["items"] = map[string]any{"type": "string"}
		}
		props[f.wire] = prop
	}
	return props
}

// toolSearchOptions keeps only the filters the tool schema offers the model.
// A list filter is sent as the model gave it, a lone string wrapped, so the
// API judges a malformed one; nil and "" are unset.
func toolSearchOptions(args map[string]any) (*SearchOptions, error) {
	opts := &SearchOptions{}
	for _, f := range searchFilters {
		if !f.toolExposed {
			continue
		}
		v, ok := args[f.wire]
		if !ok {
			continue
		}
		if f.jsonType == "array" {
			if s, isStr := v.(string); isStr {
				if s == "" {
					continue
				}
				v = []string{s}
			}
			if v == nil || isNilSlice(v) {
				continue
			}
			raw, err := json.Marshal(v)
			if err != nil {
				return nil, &InvalidRequestError{msg: "could not encode " + f.wire + ": " + err.Error() + ". Pass JSON-encodable arguments."}
			}
			assignList(opts, f.wire, raw)
			continue
		}
		if truthy(v) {
			assignFilter(opts, f.wire, v)
		}
	}
	return opts, nil
}

func isNilSlice(v any) bool {
	r := reflect.ValueOf(v)
	return r.Kind() == reflect.Slice && r.IsNil()
}

func assignList(opts *SearchOptions, wire string, raw json.RawMessage) {
	if wire == "exclude_domains" {
		opts.excludeDomainsJSON = raw
	}
}

func assignFilter(opts *SearchOptions, wire string, v any) {
	switch wire {
	case "site", "published_after", "published_before", "acquired_after", "acquired_before":
		s, ok := v.(string)
		if !ok || s == "" {
			return
		}
		switch wire {
		case "site":
			opts.Site = s
		case "published_after":
			opts.PublishedAfter = s
		case "published_before":
			opts.PublishedBefore = s
		case "acquired_after":
			opts.AcquiredAfter = s
		case "acquired_before":
			opts.AcquiredBefore = s
		}
	case "snippet_max_length":
		n, ok := asInt(v)
		if !ok {
			return
		}
		opts.SnippetMaxLength = &n
	}
}

func truthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	case int:
		return t != 0
	case float64:
		return t != 0
	case json.Number:
		return t != "" && t != "0"
	default:
		return true
	}
}

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case float64:
		if n != float64(int(n)) {
			return 0, false
		}
		return int(n), true
	case json.Number:
		i, err := n.Int64()
		if err != nil {
			return 0, false
		}
		return int(i), true
	default:
		return 0, false
	}
}
