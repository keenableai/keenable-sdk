package keenable

import (
	"strings"
	"testing"
)

const cleanBase = "https://example.com/docs/guide?x=1"

func TestCleanContextText(t *testing.T) {
	cases := []struct {
		name, text, base, want string
	}{
		{
			name: "image removed",
			text: `Intro ![logo](https://cdn.example.com/a.png "Logo") text`,
			base: cleanBase,
			want: "Intro text",
		},
		{
			name: "image inside table cell removed",
			text: "| $0.44 | $1.32 | " +
				"![](https://cdn-avatars.huggingface.co/v1/production/uploads/x.png) " +
				"| [fireworks-ai](/fireworks-ai) fastest |",
			base: "https://huggingface.co/models",
			want: "| $0.44 | $1.32 | | [fireworks-ai](https://huggingface.co/fireworks-ai) fastest |",
		},
		{
			name: "html image and image-only lines dropped",
			text: "a\n![](x.png)\n<IMG src=\"y.png\" alt=y>\n| ![](z.png) |\nb",
			base: cleanBase,
			want: "a\nb",
		},
		{
			name: "linked image leaves nothing",
			text: "see [![badge](b.svg)](/ci) now",
			base: cleanBase,
			want: "see now",
		},
		{
			name: "relative link resolved against base",
			text: "Read [intro](intro) and [api](/api/v1).",
			base: cleanBase,
			want: "Read [intro](https://example.com/docs/intro) and [api](https://example.com/api/v1).",
		},
		{
			name: "fragment link resolved against base",
			text: "[Install](#install)",
			base: cleanBase,
			want: "[Install](https://example.com/docs/guide?x=1#install)",
		},
		{
			name: "no base keeps link text",
			text: "[home](/home)",
			base: "",
			want: "home",
		},
		{
			name: "unusable base keeps link text",
			text: "[home](/home)",
			base: "not a url",
			want: "home",
		},
		{
			name: "absolute link unchanged",
			text: `See [docs](https://other.org/z "Title") or [mail](mailto:a@b.c).`,
			base: cleanBase,
			want: `See [docs](https://other.org/z "Title") or [mail](mailto:a@b.c).`,
		},
		{
			name: "text without markup unchanged byte for byte",
			text: "Plain  text\n\n|  a | b |\n|---|---|\n  indented\r\ntrailing  \n",
			base: cleanBase,
			want: "Plain  text\n\n|  a | b |\n|---|---|\n  indented\r\ntrailing  \n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := cleanContextText(tc.text, tc.base); got != tc.want {
				t.Fatalf("got  %q\nwant %q", got, tc.want)
			}
		})
	}
}

func TestContextBudgetCountsCleanedText(t *testing.T) {
	noise := "![](https://cdn.example.com/" + strings.Repeat("a", 500) + ".png)"

	resp := &SearchResponse{Results: []SearchResult{
		{Title: "One", URL: "https://one.example", Snippet: "First. " + noise},
		{Title: "Two", URL: "https://two.example", Snippet: "Second."},
	}}
	want := "[1] One (https://one.example)\nFirst.\n\n[2] Two (https://two.example)\nSecond."
	// The raw snippet alone is over this budget; the cleaned one fits.
	opts := &ContextOptions{MaxChars: len(want)}
	if got := resp.ToContext(opts); got != want {
		t.Fatalf("got  %q\nwant %q", got, want)
	}
	if n := len(resp.Cited(opts)); n != 2 {
		t.Fatalf("cited %d results, want 2", n)
	}
	if !strings.Contains(resp.Results[0].Snippet, noise) {
		t.Fatal("Snippet was modified")
	}

	page := &Page{URL: "https://example.com/p", Title: "T", Content: noise + "\nReal text. See [more](/more)."}
	wantPage := "[1] T (https://example.com/p)\nReal text. See [more](https://example.com/more)."
	if got := page.ToContext(&ContextOptions{MaxChars: len(wantPage)}); got != wantPage {
		t.Fatalf("got  %q\nwant %q", got, wantPage)
	}
	if !strings.HasPrefix(page.Content, noise) {
		t.Fatal("Content was modified")
	}
}
