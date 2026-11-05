import { describe, expect, it } from "vitest";

import { Page, SearchResponse } from "../src/index.js";
import { cleanContextText } from "../src/internal.js";

const BASE = "https://example.com/docs/guide?x=1";

describe("cleanContextText", () => {
  it("removes an image", () => {
    const text = 'Intro ![logo](https://cdn.example.com/a.png "Logo") text';
    expect(cleanContextText(text, BASE)).toBe("Intro text");
  });

  it("removes an image inside a table cell", () => {
    const row =
      "| $0.44 | $1.32 | " +
      "![](https://cdn-avatars.huggingface.co/v1/production/uploads/x.png) " +
      "| [fireworks-ai](/fireworks-ai) fastest |";
    expect(cleanContextText(row, "https://huggingface.co/models")).toBe(
      "| $0.44 | $1.32 | | [fireworks-ai](https://huggingface.co/fireworks-ai) fastest |",
    );
  });

  it("drops HTML images and lines left with only images", () => {
    const text = 'a\n![](x.png)\n<IMG src="y.png" alt=y>\n| ![](z.png) |\nb';
    expect(cleanContextText(text, BASE)).toBe("a\nb");
  });

  it("leaves nothing of a linked image", () => {
    expect(cleanContextText("see [![badge](b.svg)](/ci) now", BASE)).toBe("see now");
  });

  it("resolves a relative link against the base", () => {
    expect(cleanContextText("Read [intro](intro) and [api](/api/v1).", BASE)).toBe(
      "Read [intro](https://example.com/docs/intro) and [api](https://example.com/api/v1).",
    );
  });

  it("resolves a fragment link against the base", () => {
    expect(cleanContextText("[Install](#install)", BASE)).toBe(
      "[Install](https://example.com/docs/guide?x=1#install)",
    );
  });

  it("keeps only the text when there is no usable base", () => {
    expect(cleanContextText("[home](/home)", "")).toBe("home");
    expect(cleanContextText("[home](/home)", "not a url")).toBe("home");
  });

  it("leaves an absolute link unchanged", () => {
    const text = 'See [docs](https://other.org/z "Title") or [mail](mailto:a@b.c).';
    expect(cleanContextText(text, BASE)).toBe(text);
  });

  it("returns text without markup unchanged byte for byte", () => {
    const text = "Plain  text\n\n|  a | b |\n|---|---|\n  indented\r\ntrailing  \n";
    expect(cleanContextText(text, BASE)).toBe(text);
  });

  it("leaves code that looks like a link unchanged", () => {
    const text = "Call fns[i]() or handlers[name](event).";
    expect(cleanContextText(text, BASE)).toBe(text);
  });

  it("leaves inline code alone but resolves a link whose text is code", () => {
    const text = "See [`foo()`](/api/foo), not `![x](y)` ![a](b.png)";
    expect(cleanContextText(text, BASE)).toBe(
      "See [`foo()`](https://example.com/api/foo), not `![x](y)`",
    );
  });

  it("leaves fenced code blocks alone", () => {
    const text = "```md\n![x](y.png)\n[a](b)\n```\n~~~\nf[i](x)\n~~~\nok ![c](d.png)";
    expect(cleanContextText(text, BASE)).toBe(
      "```md\n![x](y.png)\n[a](b)\n```\n~~~\nf[i](x)\n~~~\nok",
    );
  });

  it("does not treat four-space-indented backticks as a fence opener", () => {
    // Four spaces make indented code in CommonMark, not a fence opener.
    const text = "    ```\n![x](y.png)\nlater";
    expect(cleanContextText(text, BASE)).toBe("    ```\nlater");
  });

  it("leaves blockquoted fenced code alone", () => {
    const text = "> ```md\n> ![x](y.png)\n> [a](/rel)\n> ```\nok ![c](d.png)";
    expect(cleanContextText(text, BASE)).toBe(
      "> ```md\n> ![x](y.png)\n> [a](/rel)\n> ```\nok",
    );
  });

  it("protects a code span that contains a shorter backtick run", () => {
    const text = "See ``a ` ![x](y.png)`` and more ![z](w.png)";
    expect(cleanContextText(text, BASE)).toBe("See ``a ` ![x](y.png)`` and more");
  });

  it("resolves an adjacent path link but leaves callable code alone", () => {
    const text = "See docs[API](/api) or call handlers[name](event).";
    expect(cleanContextText(text, BASE)).toBe(
      "See docs[API](https://example.com/api) or call handlers[name](event).",
    );
  });

  it("keeps a table header row of images", () => {
    const text = "| ![a](x.png) | b |\n|---|---|\n| ![c](y.png) | |\n| 1 | 2 |";
    expect(cleanContextText(text, BASE)).toBe("| | b |\n|---|---|\n| 1 | 2 |");
  });

  it("handles brackets in alt text and parentheses in URLs", () => {
    const text = 'A ![a [b] c](File_(1).png "t (x)") x [Foo](/wiki/Foo_(bar))';
    expect(cleanContextText(text, BASE)).toBe("A x [Foo](https://example.com/wiki/Foo_(bar))");
  });

  it("cleans hostile input in linear time", () => {
    const started = Date.now();
    for (const text of ["![".repeat(50_000), "![a](".repeat(20_000), "<img ".repeat(20_000)]) {
      cleanContextText(text, BASE);
    }
    // Quadratic patterns took seconds on these.
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("toContext budget counts cleaned text", () => {
  const noise = "![](https://cdn.example.com/" + "a".repeat(500) + ".png)";

  it("for search results", () => {
    const response = new SearchResponse({
      query: "q",
      results: [
        { title: "One", url: "https://one.example", snippet: `First. ${noise}`, raw: {} },
        { title: "Two", url: "https://two.example", snippet: "Second.", raw: {} },
      ],
      raw: {},
    });
    const expected =
      "[1] One (https://one.example)\nFirst.\n\n[2] Two (https://two.example)\nSecond.";
    // The raw snippet alone is over this budget; the cleaned one fits.
    expect(response.toContext({ maxChars: expected.length })).toBe(expected);
    expect(response.cited({ maxChars: expected.length }).map((r) => r.title)).toEqual([
      "One",
      "Two",
    ]);
    expect(response.results[0]!.snippet).toContain(noise);
  });

  it("for a fetched page", () => {
    const page = new Page({
      url: "https://example.com/p",
      title: "T",
      content: `${noise}\nReal text. See [more](/more).`,
      raw: {},
    });
    const expected = "[1] T (https://example.com/p)\nReal text. See [more](https://example.com/more).";
    expect(page.toContext({ maxChars: expected.length })).toBe(expected);
    expect(page.content.startsWith(noise)).toBe(true);
  });
});
