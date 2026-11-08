package keenable

import (
	"strconv"
	"strings"
	"testing"
	"unicode/utf8"
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
			want: "$0.44 · $1.32 · [fireworks-ai](https://huggingface.co/fireworks-ai) fastest;",
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
			text: "Plain  text\n\n  indented\r\ntrailing  \nCost | value, said nobody\n",
			base: cleanBase,
			want: "Plain  text\n\n  indented\r\ntrailing  \nCost | value, said nobody\n",
		},
		{
			name: "code that looks like a link unchanged",
			text: "Call fns[i]() or handlers[name](event).",
			base: cleanBase,
			want: "Call fns[i]() or handlers[name](event).",
		},
		{
			name: "inline code left alone, code link text resolves",
			text: "See [`foo()`](/api/foo), not `![x](y)` ![a](b.png)",
			base: cleanBase,
			want: "See [`foo()`](https://example.com/api/foo), not `![x](y)`",
		},
		{
			name: "fenced code block left alone",
			text: "```md\n![x](y.png)\n[a](b)\n```\n~~~\nf[i](x)\n~~~\nok ![c](d.png)",
			base: cleanBase,
			want: "```md\n![x](y.png)\n[a](b)\n```\n~~~\nf[i](x)\n~~~\nok",
		},
		{
			name: "indented backticks do not open a fence",
			text: "    ```\n![x](y.png)\nlater",
			base: cleanBase,
			want: "    ```\nlater",
		},
		{
			name: "blockquoted fenced code left alone",
			text: "> ```md\n> ![x](y.png)\n> [a](/rel)\n> ```\nok ![c](d.png)",
			base: cleanBase,
			want: "> ```md\n> ![x](y.png)\n> [a](/rel)\n> ```\nok",
		},
		{
			name: "code span with shorter inner backticks protected",
			text: "See ``a ` ![x](y.png)`` and more ![z](w.png)",
			base: cleanBase,
			want: "See ``a ` ![x](y.png)`` and more",
		},
		{
			name: "adjacent path link resolved, callable code left alone",
			text: "See docs[API](/api) or call handlers[name](event).",
			base: cleanBase,
			want: "See docs[API](https://example.com/api) or call handlers[name](event).",
		},
		{
			name: "table rows flattened, delimiter rows dropped",
			text: "| ![a](x.png) | b |\n|---|:--:|\n| ![c](y.png) | |\n|  1 |  2  |\nafter",
			base: cleanBase,
			want: "b;\n1 · 2;\nafter",
		},
		{
			name: "Hugging Face leaderboard table flattened",
			text: "Open LLM leaderboard\n\n" +
				"| Rank | Model | Provider | Score |\n" +
				"|---:|:---|---|:-:|\n" +
				"| 1 | ![avatar](https://cdn-avatars.huggingface.co/v1/production/uploads/a.png) [Llama-3](/meta/llama) " +
				"| ![avatar](https://cdn-avatars.huggingface.co/v1/production/uploads/b.png) meta | 90.1 |\n" +
				"| ![](https://cdn-avatars.huggingface.co/v1/production/uploads/c.png) " +
				"| ![](https://cdn-avatars.huggingface.co/v1/production/uploads/d.png) | | |\n" +
				"| 2 | Qwen2 | ![](https://cdn-avatars.huggingface.co/e.png) qwen | 88 |",
			base: "https://huggingface.co/spaces/lb",
			want: "Open LLM leaderboard\n\n" +
				"Rank · Model · Provider · Score;\n" +
				"1 · [Llama-3](https://huggingface.co/meta/llama) · meta · 90.1;\n" +
				"2 · Qwen2 · qwen · 88;",
		},
		{
			name: "table without outer pipes flattened",
			text: "Name | Price\n--- | ---:\nA | $1\nB | $2\n\nprose",
			base: cleanBase,
			want: "Name · Price;\nA · $1;\nB · $2;\n\nprose",
		},
		{
			name: "escaped pipe in a cell is a literal pipe",
			text: `| op | meaning |` + "\n|---|---|\n" + `| a \| b | either |`,
			base: cleanBase,
			want: "op · meaning;\na | b · either;",
		},
		{
			name: "pipe inside inline code is not a cell separator",
			text: "| flag | use |\n|---|---|\n| `a|b` | union |",
			base: cleanBase,
			want: "flag · use;\n`a|b` · union;",
		},
		{
			name: "table inside a fence left alone",
			text: "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\n| c | d |",
			base: cleanBase,
			want: "```\n| a | b |\n|---|---|\n| 1 | 2 |\n```\nc · d;",
		},
		{
			name: "row already ending in a semicolon gets no second one",
			text: "| a | b; |\n|---|---|\n| `x;` | y |\n| c | `d;` |",
			base: cleanBase,
			want: "a · b;\n`x;` · y;\nc · `d;`;",
		},
		{
			name: "only an odd backslash run escapes a pipe",
			text: "| x |\n|---|\n" + `| a \| b |` + "\n" + `| a \\| b |` + "\n" + `| a \\\| b |`,
			base: cleanBase,
			want: "x;\n" + `a | b;` + "\n" + `a \\ · b;` + "\n" + `a \\| b;`,
		},
		{
			name: "prose that starts with a pipe left alone",
			text: "|x| is the absolute value of x\n| Warning: a | b\n|x|\n" + `| a \| b |`,
			base: cleanBase,
			want: "|x| is the absolute value of x\n| Warning: a | b\n|x|\n" + `| a \| b |`,
		},
		{
			name: "row-shaped line without a header flattened",
			text: "...leaderboard\n| 1 | Llama | 90 |\n| 2 | Qwen | 88 |",
			base: cleanBase,
			want: "...leaderboard\n1 · Llama · 90;\n2 · Qwen · 88;",
		},
		{
			name: "prose with a single pipe left alone",
			text: "Home | About us\nUse a | b to pipe.\n`x | y`",
			base: cleanBase,
			want: "Home | About us\nUse a | b to pipe.\n`x | y`",
		},
		{
			name: "brackets in alt and parentheses in URLs",
			text: `A ![a [b] c](File_(1).png "t (x)") x [Foo](/wiki/Foo_(bar))`,
			base: cleanBase,
			want: "A x [Foo](https://example.com/wiki/Foo_(bar))",
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

func responseOf(snippets ...string) *SearchResponse {
	resp := &SearchResponse{}
	for i, s := range snippets {
		n := strconv.Itoa(i + 1)
		resp.Results = append(resp.Results, SearchResult{Title: "T" + n, URL: "https://e.com/" + n, Snippet: s})
	}
	return resp
}

func TestContextMaxSnippetChars(t *testing.T) {
	words := strings.TrimSuffix(strings.Repeat("word ", 1000), " ") // 4,999 characters

	t.Run("default caps at a word boundary", func(t *testing.T) {
		resp := responseOf(words)
		body := strings.SplitN(resp.ToContext(nil), "\n", 2)[1]
		if !strings.HasSuffix(body, "word…") {
			t.Fatalf("body ends %q", body[len(body)-20:])
		}
		// The last space at or before 2,000 sits at 1,999; the cut drops it.
		if n := utf8.RuneCountInString(body); n != 1999+1 {
			t.Fatalf("body is %d characters, want 2000", n)
		}
		if resp.Results[0].Snippet != words {
			t.Fatal("Snippet was modified")
		}
	})

	t.Run("cuts at a space exactly at the limit", func(t *testing.T) {
		resp := responseOf("aaaa bbbb cccc")
		for limit, want := range map[int]string{4: "\naaaa…", 7: "\naaaa…", 9: "\naaaa bbbb…"} {
			if got := resp.ToContext(&ContextOptions{MaxSnippetChars: limit}); !strings.HasSuffix(got, want) {
				t.Fatalf("limit %d: got %q, want suffix %q", limit, got, want)
			}
		}
	})

	t.Run("hard cuts text without spaces", func(t *testing.T) {
		got := responseOf(strings.Repeat("é", 50)).ToContext(&ContextOptions{MaxSnippetChars: 10})
		if want := "\n" + strings.Repeat("é", 10) + "…"; !strings.HasSuffix(got, want) {
			t.Fatalf("got %q, want suffix %q", got, want)
		}
	})

	t.Run("leaves text at or under the cap untouched", func(t *testing.T) {
		got := responseOf("aaaa bbbb").ToContext(&ContextOptions{MaxSnippetChars: 9})
		if !strings.HasSuffix(got, "\naaaa bbbb") {
			t.Fatalf("got %q", got)
		}
	})

	t.Run("negative disables the cap", func(t *testing.T) {
		long := strings.Repeat("y ", 3000)
		got := responseOf(long).ToContext(&ContextOptions{MaxSnippetChars: -1, MaxChars: 100_000})
		if !strings.HasSuffix(got, strings.TrimSpace(long)) {
			t.Fatal("snippet was capped")
		}
	})

	t.Run("budget counts the capped text", func(t *testing.T) {
		resp := responseOf(words, words, words)
		// Uncapped, the first result alone is over budget; capped, all three fit.
		if n := len(resp.Cited(&ContextOptions{MaxChars: 6200})); n != 3 {
			t.Fatalf("cited %d, want 3", n)
		}
		if n := len(resp.Cited(&ContextOptions{MaxChars: 6200, MaxSnippetChars: -1})); n != 1 {
			t.Fatalf("cited %d uncapped, want 1", n)
		}
		if n := strings.Count(resp.ToContext(&ContextOptions{MaxChars: 6200}), "…"); n != 3 {
			t.Fatalf("%d ellipses, want 3", n)
		}
	})

	t.Run("first result kept even over the budget", func(t *testing.T) {
		cited := responseOf(strings.Repeat("a ", 100), "b").Cited(&ContextOptions{MaxChars: 10, MaxSnippetChars: -1})
		if len(cited) != 1 || cited[0].Title != "T1" {
			t.Fatalf("cited %v", cited)
		}
	})
}
