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
