import { describe, expect, it } from "vitest";

import {
  Keenable,
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
  runToolCall,
  SEARCH_TOOL,
} from "../src/index.js";

const SEARCH_BODY = {
  query: "wafer scale engine",
  mode: "pro",
  results: [
    {
      title: "How Cerebras works",
      url: "https://cerebras.ai/chip",
      description: "",
      snippet: "The WSE keeps the whole model\nin on-chip memory.",
      published_at: "2026-05-31T23:57:19Z",
      acquired_at: "2026-07-24T01:32:23Z",
    },
    {
      title: "MoE guide",
      url: "https://cerebras.ai/blog/moe-guide-scale",
      snippet: "Mixture-of-experts routing at scale.",
    },
  ],
};

const FETCH_BODY = {
  url: "https://example.com/",
  title: "Example Domain",
  content: "# Example Domain\n\nThis domain is for use in examples.",
  description: "",
};

/** A client whose transport records requests and replays canned responses. */
function mockClient(
  handler: (url: string, init: RequestInit) => Response,
  options: { apiKey?: string; clientSource?: string; timeoutMs?: number } = {},
) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const client = new Keenable({
    apiKey: options.apiKey,
    clientSource: options.clientSource,
    timeoutMs: options.timeoutMs,
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      seen.push({ url, init });
      return handler(url, init);
    }) as unknown as typeof globalThis.fetch,
  });
  return { client, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

/** Serve whichever endpoint was asked for. */
const routed = (url: string) =>
  url.includes("/v1/search") ? json(SEARCH_BODY) : json(FETCH_BODY);

/**
 * A 200 whose headers arrive at once but whose body lands after `delayMs`.
 *
 * Like a real fetch body, the stream fails with an AbortError as soon as the
 * request signal fires, so a client that keeps its deadline armed while reading
 * sees the abort, and one that drops it early sees the body succeed.
 */
function slowJson(body: unknown, delayMs: number, signal?: AbortSignal | null) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const deliver = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        controller.close();
      }, delayMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(deliver);
        controller.error(new DOMException("This operation was aborted", "AbortError"));
      });
    },
  });
  return new Response(stream, { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("search", () => {
  it("parses results and keeps snippet as the text field", async () => {
    const { client } = mockClient(() => json(SEARCH_BODY));
    const response = await client.search("wafer scale engine");

    expect(response.length).toBe(2);
    expect(response.results[0]?.title).toBe("How Cerebras works");
    expect(response.results[0]?.snippet).toContain("on-chip memory");
    // The API sends description="" for most pages; it must not survive as "".
    expect(response.results[0]?.description).toBeUndefined();
    expect(response.results[0]?.publishedAt).toBe("2026-05-31T23:57:19Z");
    expect([...response].map((r) => r.title)).toEqual(["How Cerebras works", "MoE guide"]);
  });

  it("sends filters snake_cased and defaults to pro mode", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    await client.search("wafer scale engine", {
      site: "cerebras.ai",
      publishedAfter: "2026-01-01",
      snippetMaxLength: 200,
    });

    expect(JSON.parse(String(seen[0]?.init.body))).toEqual({
      query: "wafer scale engine",
      mode: "pro",
      site: "cerebras.ai",
      published_after: "2026-01-01",
      snippet_max_length: 200,
    });
  });

  it("sends maxResults and queryTime", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    await client.search("un security council", { maxResults: 25, queryTime: "2026-05-01" });

    const payload = JSON.parse(String(seen[0]?.init.body));
    expect(payload.max_results).toBe(25);
    expect(payload.query_time).toBe("2026-05-01");
  });

  it("sends includeDomains and excludeDomains as arrays", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    await client.search("security council resolution", {
      includeDomains: ["press.un.org", "undocs.org", "usa.gov"],
    });
    await client.search("security council resolution", {
      excludeDomains: ["blogs.un.org"],
    });
    await client.search("security council resolution", {
      includeDomains: ["un.org"],
      excludeDomains: ["blogs.un.org"],
    });

    const payloads = seen.map((s) => JSON.parse(String(s.init.body)));
    expect(payloads[0].include_domains).toEqual(["press.un.org", "undocs.org", "usa.gov"]);
    expect(payloads[0]).not.toHaveProperty("exclude_domains");
    expect(payloads[1].exclude_domains).toEqual(["blogs.un.org"]);
    expect(payloads[1]).not.toHaveProperty("include_domains");
    expect(payloads[2]).toMatchObject({
      include_domains: ["un.org"],
      exclude_domains: ["blogs.un.org"],
    });
    expect(payloads[2]).not.toHaveProperty("site");
  });

  it("sends unnormalized domain entries verbatim for the API to clean up", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    const raw = [" https://WWW.UN.org/ ", "un.org", "un.org", "un.org/press", ".gov"];
    await client.search("q", { includeDomains: raw, excludeDomains: ["WWW.spam.com."] });

    const payload = JSON.parse(String(seen[0]?.init.body));
    expect(payload.include_domains).toEqual(raw);
    expect(payload.exclude_domains).toEqual(["WWW.spam.com."]);
  });

  it("sends site and includeDomains together for the API to reject", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    await client.search("q", { site: "un.org", includeDomains: ["press.un.org"] });

    const payload = JSON.parse(String(seen[0]?.init.body));
    expect(payload.site).toBe("un.org");
    expect(payload.include_domains).toEqual(["press.un.org"]);
  });

  it("keeps the API's filter warning in raw", async () => {
    const body = { ...SEARCH_BODY, warning: "3 results were removed by your domain filter" };
    const { client } = mockClient(() => json(body));
    const response = await client.search("q", { includeDomains: ["un.org"] });

    expect(response.raw.warning).toBe("3 results were removed by your domain filter");
    expect(response.raw.results).toEqual(SEARCH_BODY.results);
  });

  it("passes an empty list through so the API can reject it", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    await client.search("q", { includeDomains: [], excludeDomains: [] });

    const payload = JSON.parse(String(seen[0]?.init.body));
    expect(payload.include_domains).toEqual([]);
    expect(payload.exclude_domains).toEqual([]);
  });

  it("uses the public endpoint and identifies itself when keyless", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    await client.search("hello");

    expect(client.keyless).toBe(true);
    expect(seen[0]?.url).toBe("https://api.keenable.ai/v1/search/public");
    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["X-API-Key"]).toBeUndefined();
    // The public tier rejects requests without this header.
    expect(headers["X-Keenable-Title"]).toBe("Keenable SDK");
    expect(headers["Accept"]).toBe("application/json");
  });

  it("lets a wrapping integration set its own traffic source", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY), {
      clientSource: "Acme Agent",
    });
    await client.search("hello");

    const headers = seen[0]?.init.headers as Record<string, string>;
    expect(headers["X-Keenable-Title"]).toBe("Acme Agent");
  });

  it("switches to the keyed endpoint when an API key is set", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY), { apiKey: "keen_test" });
    await client.search("hello");

    expect(client.keyless).toBe(false);
    expect(seen[0]?.url).toBe("https://api.keenable.ai/v1/search");
    expect((seen[0]?.init.headers as Record<string, string>)["X-API-Key"]).toBe(
      "keen_test",
    );
  });

  it("rejects an empty query before sending", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    await expect(client.search("   ")).rejects.toBeInstanceOf(KeenableInvalidRequestError);
    expect(seen).toEqual([]);
  });
});

describe("toContext", () => {
  it("numbers results and respects the character budget", async () => {
    const { client } = mockClient(() => json(SEARCH_BODY));
    const response = await client.search("wafer scale engine");

    const context = response.toContext();
    expect(context.startsWith("[1] How Cerebras works (https://cerebras.ai/chip)")).toBe(
      true,
    );
    expect(context).toContain("[2] MoE guide");
    // Snippets are raw page text; their newlines would otherwise collide with
    // the blank line that separates one source from the next.
    expect(context).toContain("The WSE keeps the whole model in on-chip memory.");

    // A budget that only fits the first block drops the second one whole.
    const trimmed = response.toContext({ maxChars: 120 });
    expect(trimmed).toContain("[1]");
    expect(trimmed).not.toContain("[2]");
    expect(trimmed.endsWith("memory.")).toBe(true);

    expect(response.toContext({ maxResults: 1 })).toBe(trimmed);
  });

  // Citation numbers stay contiguous: no [1] followed by [3]. An oversized
  // middle result ends the block rather than being skipped over, because a gap
  // breaks the mapping from the model's citations back to the results.
  it("stops at the first result that does not fit", async () => {
    const body = {
      query: "q",
      results: [
        { title: "First", url: "https://example.com/1", snippet: "short" },
        { title: "Second", url: "https://example.com/2", snippet: "x".repeat(500) },
        { title: "Third", url: "https://example.com/3", snippet: "also short" },
      ],
    };
    const { client } = mockClient(() => json(body));
    const context = (await client.search("q")).toContext({ maxChars: 120 });

    expect(context).toContain("[1] First");
    expect(context).not.toContain("[2]");
    expect(context).not.toContain("Third");
  });

  it("reports which results were rendered, in citation order", async () => {
    const { client } = mockClient(() => json(SEARCH_BODY));
    const response = await client.search("wafer scale engine");

    expect(response.cited().map((r) => r.title)).toEqual([
      "How Cerebras works",
      "MoE guide",
    ]);
    expect(response.cited({ maxChars: 120 }).map((r) => r.title)).toEqual([
      "How Cerebras works",
    ]);
  });
});

describe("fetch", () => {
  it("returns markdown", async () => {
    const { client, seen } = mockClient(() => json(FETCH_BODY));
    const page = await client.fetch("https://example.com");

    expect(seen[0]?.url).toBe(
      "https://api.keenable.ai/v1/fetch/public?url=https%3A%2F%2Fexample.com",
    );
    expect(page.title).toBe("Example Domain");
    expect(page.content.startsWith("# Example Domain")).toBe(true);
  });

  it("renders a citable block like search results do", async () => {
    const { client } = mockClient(() => json(FETCH_BODY));
    const page = await client.fetch("https://example.com");

    expect(page.toContext().startsWith("[1] Example Domain (https://example.com/)")).toBe(
      true,
    );
    expect(page.toContext()).toContain("This domain is for use in examples.");
    // One document, so an oversized page is cut rather than dropped entirely.
    expect(page.toContext({ maxChars: 60 }).startsWith("[1] Example Domain")).toBe(true);
  });

  it.each([
    "http://localhost:8080/admin",
    "http://127.0.0.1/",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/",
    "https://192.168.1.1/",
    "file:///etc/passwd",
    "https://metadata.google.internal/",
    // A trailing dot resolves to the same host without matching it as a
    // string, and IPv4-mapped IPv6 reaches the same address as the bare v4
    // form. Both are ways past a naive blocklist.
    "https://localhost./",
    "https://metadata.google.internal./",
    "https://[::ffff:169.254.169.254]/latest/meta-data/",
    "https://[::ffff:127.0.0.1]/",
    "https://[::ffff:10.0.0.1]/",
    "https://[0:0:0:0:0:ffff:169.254.169.254]/",
  ])("refuses the internal target %s before sending", async (url) => {
    const { client, seen } = mockClient(() => json(FETCH_BODY));
    await expect(client.fetch(url)).rejects.toBeInstanceOf(KeenableInvalidRequestError);
    expect(seen).toEqual([]);
  });
});

describe("deadline", () => {
  it("applies the timeout to a body that arrives after the headers", async () => {
    const { client } = mockClient(
      (_url, init) => slowJson(SEARCH_BODY, 100, init.signal),
      { timeoutMs: 10 },
    );
    const error = await client.search("q").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeenableConnectionError);
    expect((error as KeenableConnectionError).message).toContain("10 ms");
  });

  it("honours a caller abort that fires after the headers", async () => {
    const { client } = mockClient((_url, init) => slowJson(FETCH_BODY, 100, init.signal));
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 5);
    const error = await client
      .fetch("https://example.com/", { signal: caller.signal })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });

  it("returns a slow body that lands inside the deadline", async () => {
    const { client } = mockClient(
      (_url, init) => slowJson(SEARCH_BODY, 5, init.signal),
      { timeoutMs: 1000 },
    );
    const response = await client.search("q");
    expect(response.results).toHaveLength(2);
  });
});

describe("errors", () => {
  it("maps 429 and 401 and carries the API message", async () => {
    const rateLimited = mockClient(() => json({ message: "hourly cap reached" }, 429));
    const error = await rateLimited.client.search("q").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeenableRateLimitError);
    expect((error as KeenableRateLimitError).statusCode).toBe(429);
    expect((error as KeenableRateLimitError).message).toContain("hourly cap reached");
    expect((error as KeenableRateLimitError).data).toEqual({ message: "hourly cap reached" });

    const unauthorized = mockClient(() => json({ error: "bad key" }, 401));
    const authError = await unauthorized.client.search("q").catch((e: unknown) => e);
    expect(authError).toBeInstanceOf(KeenableAuthError);
    expect((authError as KeenableAuthError).data).toEqual({ error: "bad key" });
  });

  it.each([
    ["a JSON array", 400, '["invalid_filter"]', undefined],
    ["plain text", 502, "Bad Gateway", "Bad Gateway"],
  ])("leaves data unset for %s error body", async (_label, status, text, body) => {
    const { client } = mockClient(() => new Response(text, { status }));
    const error = (await client.search("q").catch((e: unknown) => e)) as KeenableAPIError;
    expect(error).toBeInstanceOf(KeenableAPIError);
    expect(error.statusCode).toBe(status);
    expect(error.data).toBeUndefined();
    expect(error.body).toBe(body);
    expect(error.field).toBeUndefined();
  });

  it("names the field, entry and reason of a rejected domain filter", async () => {
    const body = {
      error: "invalid_filter",
      message: 'Invalid include_domains value "un.org/press": paths are not supported; use the host un.org',
      field: "include_domains",
      value: "un.org/press",
      reason: "paths are not supported; use the host un.org",
    };
    const { client } = mockClient(() => json(body, 400));
    const error = await client
      .search("q", { includeDomains: ["un.org/press"] })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(KeenableAPIError);
    const apiError = error as KeenableAPIError;
    expect(apiError.statusCode).toBe(400);
    expect(apiError.message).toBe(
      'Keenable API error (400): Invalid include_domains value "un.org/press": paths are not supported; use the host un.org',
    );
    expect(apiError.body).toBe(body.message);
    expect(apiError.data).toEqual(body);
    expect(apiError.field).toBe("include_domains");
    expect(apiError.value).toBe("un.org/press");
    expect(apiError.reason).toBe("paths are not supported; use the host un.org");
  });

  it("leaves value unset when an invalid_filter body names no entry", async () => {
    const body = {
      error: "invalid_filter",
      message: "Invalid include_domains value: must not be empty",
      field: "include_domains",
      reason: "must not be empty",
    };
    const { client } = mockClient(() => json(body, 400));
    const error = (await client
      .search("q", { includeDomains: [] })
      .catch((e: unknown) => e)) as KeenableAPIError;
    expect(error.field).toBe("include_domains");
    expect(error.value).toBeUndefined();
    expect(error.reason).toBe("must not be empty");
  });

  it.each([
    ["a list", ["a.com", "b.com"], '["a.com","b.com"]'],
    ["a number", 5, "5"],
    ["an object", { host: "a.com" }, '{"host":"a.com"}'],
    ["null", null, undefined],
  ])("re-encodes %s in an invalid_filter body as JSON text", async (_label, raw, expected) => {
    const body = { error: "invalid_filter", field: raw, value: raw, reason: raw };
    const { client } = mockClient(() => json(body, 400));
    const error = (await client.search("q").catch((e: unknown) => e)) as KeenableAPIError;
    expect(error.field).toBe(expected);
    expect(error.value).toBe(expected);
    expect(error.reason).toBe(expected);
  });

  it.each([
    [401, KeenableAuthError],
    [429, KeenableRateLimitError],
  ])("ignores an invalid_filter body on a %s subclass error", async (status, cls) => {
    const body = {
      error: "invalid_filter",
      field: "include_domains",
      value: "un.org/press",
      reason: "paths are not supported; use the host un.org",
    };
    const { client } = mockClient(() => json(body, status));
    const error = (await client.search("q").catch((e: unknown) => e)) as KeenableAPIError;
    expect(error).toBeInstanceOf(cls);
    expect(error.statusCode).toBe(status);
    expect(error.data).toEqual(body);
    expect(error.field).toBeUndefined();
    expect(error.value).toBeUndefined();
    expect(error.reason).toBeUndefined();
  });

  it.each([422, 500])("ignores an invalid_filter body on a %s", async (status) => {
    const body = {
      error: "invalid_filter",
      field: "include_domains",
      value: "un.org/press",
      reason: "paths are not supported; use the host un.org",
    };
    const { client } = mockClient(() => json(body, status));
    const error = (await client.search("q").catch((e: unknown) => e)) as KeenableAPIError;
    expect(error.statusCode).toBe(status);
    expect(error.data).toEqual(body);
    expect(error.field).toBeUndefined();
    expect(error.value).toBeUndefined();
    expect(error.reason).toBeUndefined();
  });

  it("keeps other 400s as they were, with no filter detail", async () => {
    const body = { error: "Bad request", message: "query is required", field: "query" };
    const { client } = mockClient(() => json(body, 400));
    const error = (await client.search("q").catch((e: unknown) => e)) as KeenableAPIError;
    expect(error.body).toBe("query is required");
    expect(error.data).toEqual(body);
    expect(error.field).toBeUndefined();
    expect(error.value).toBeUndefined();
    expect(error.reason).toBeUndefined();
  });

  it("rejects a non-https base URL", () => {
    expect(() => new Keenable({ baseUrl: "ftp://api.keenable.ai" })).toThrow(
      KeenableInvalidRequestError,
    );
    expect(() => new Keenable({ baseUrl: "http://api.keenable.ai" })).toThrow(
      KeenableInvalidRequestError,
    );
    // Plain http is allowed against localhost for local development.
    expect(() => new Keenable({ baseUrl: "http://localhost:8000" })).not.toThrow();
  });
});

describe("runToolCall", () => {
  it("dispatches search and fetch, and rejects unknown tools", async () => {
    const { client, seen } = mockClient(routed);

    const searched = await runToolCall(
      client,
      "keenable_search",
      '{"query": "wafer scale", "site": "cerebras.ai"}',
    );
    expect(searched.startsWith("[1] How Cerebras works")).toBe(true);
    expect(JSON.parse(String(seen[0]?.init.body)).site).toBe("cerebras.ai");

    const fetched = await runToolCall(client, "keenable_fetch", {
      url: "https://example.com",
    });
    // Both tools render the same citable shape, so a model can cite either.
    expect(fetched.startsWith("[1] Example Domain (https://example.com/)")).toBe(true);

    await expect(runToolCall(client, "keenable_search", "not json")).rejects.toBeInstanceOf(
      KeenableInvalidRequestError,
    );
    await expect(runToolCall(client, "nope", "{}")).rejects.toBeInstanceOf(
      KeenableInvalidRequestError,
    );
  });

  // A caller catching KeenableError should never see a raw TypeError.
  it.each([123, null, [], true])(
    "rejects %s arguments inside the error contract",
    async (arguments_) => {
      const { client } = mockClient(routed);
      await expect(
        runToolCall(client, "keenable_search", arguments_ as never),
      ).rejects.toBeInstanceOf(KeenableInvalidRequestError);
    },
  );

  it("offers site and both domain lists in the search tool schema", () => {
    const properties = SEARCH_TOOL.function.parameters.properties as Record<
      string,
      { type: string; items?: unknown; description: string }
    >;
    expect(properties.include_domains).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(properties.exclude_domains).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(properties.site?.type).toBe("string");
    expect(properties.site?.description).toContain("include_domains");
  });

  it("forwards domain lists from a tool call, keeping empty ones", async () => {
    const { client, seen } = mockClient(routed);
    await runToolCall(client, "keenable_search", {
      query: "q",
      include_domains: ["press.un.org", "undocs.org"],
      exclude_domains: [],
    });
    await runToolCall(client, "keenable_search", {
      query: "q",
      include_domains: "press.un.org",
      exclude_domains: "",
    });
    await runToolCall(client, "keenable_search", { query: "q", include_domains: [] });
    await runToolCall(client, "keenable_search", { query: "q" });
    await runToolCall(client, "keenable_search", {
      query: "q",
      include_domains: "   ",
      exclude_domains: " a.com,b.com ",
    });

    const [first, second, emptyInclude, absent, padded] = seen.map((s) =>
      JSON.parse(String(s.init.body)),
    );
    expect(first.include_domains).toEqual(["press.un.org", "undocs.org"]);
    expect(first.exclude_domains).toEqual([]);
    expect(emptyInclude.include_domains).toEqual([]);
    expect(second.include_domains).toEqual(["press.un.org"]);
    expect(second).not.toHaveProperty("exclude_domains");
    expect(absent).not.toHaveProperty("include_domains");
    expect(absent).not.toHaveProperty("exclude_domains");
    expect(padded).not.toHaveProperty("include_domains");
    expect(padded.exclude_domains).toEqual([" a.com,b.com "]);
  });

  it("sends site and include_domains from a tool call together", async () => {
    const { client, seen } = mockClient(routed);
    await runToolCall(client, "keenable_search", {
      query: "q",
      site: "un.org",
      include_domains: ["press.un.org"],
    });

    const payload = JSON.parse(String(seen[0]?.init.body));
    expect(payload.site).toBe("un.org");
    expect(payload.include_domains).toEqual(["press.un.org"]);
  });

  it("sends a malformed domain-list argument to the API instead of dropping it", async () => {
    const { client, seen } = mockClient(routed);
    await runToolCall(client, "keenable_search", {
      query: "q",
      include_domains: null,
      exclude_domains: 5,
    });
    await runToolCall(client, "keenable_search", {
      query: "q",
      exclude_domains: ["a.com", 7],
    });

    const [first, second] = seen.map((s) => JSON.parse(String(s.init.body)));
    expect(first).not.toHaveProperty("include_domains");
    expect(first.exclude_domains).toBe(5);
    expect(second.exclude_domains).toEqual(["a.com", 7]);
  });

  it("forwards only the filters the schema offers the model", async () => {
    const { client, seen } = mockClient(routed);
    await runToolCall(client, "keenable_search", {
      query: "q",
      site: "cerebras.ai",
      acquired_after: "2026-01-01",
    });

    const payload = JSON.parse(String(seen[0]?.init.body));
    expect(payload.site).toBe("cerebras.ai");
    // acquired_after is a real client filter but is not in the tool schema, so
    // a model cannot reach past the subset it was offered.
    expect(payload.acquired_after).toBeUndefined();
  });
});
