package keenable

import "encoding/json"

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
		props[f.wire] = map[string]any{
			"type":        kind,
			"description": f.description,
		}
	}
	return props
}

// toolSearchOptions keeps only the filters the tool schema offers the model.
func toolSearchOptions(args map[string]any) *SearchOptions {
	opts := &SearchOptions{}
	if args == nil {
		return opts
	}
	for _, f := range searchFilters {
		if !f.toolExposed {
			continue
		}
		v, ok := args[f.wire]
		if !ok || !truthy(v) {
			continue
		}
		assignFilter(opts, f.wire, v)
	}
	return opts
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
