import { describe, expect, it } from "vitest";

import {
  Keenable,
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableCreditsError,
  KeenableForbiddenError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
  KeenableValidationError,
  TOOLS,
  runToolCall,
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

  it("sends realtime mode, enableWizards and sessionId", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    await client.search("q", { mode: "realtime", enableWizards: false, sessionId: "agent-run-7" });
    const payload = JSON.parse(String(seen[0]?.init.body));
    expect(payload.mode).toBe("realtime");
    expect(payload.enable_wizards).toBe(false);
    expect(payload.session_id).toBe("agent-run-7");
  });

  it("passes a mode it does not name through", async () => {
    const { client, seen } = mockClient(() => json(SEARCH_BODY));
    await client.search("q", { mode: "some-future-mode" });
    expect(JSON.parse(String(seen[0]?.init.body)).mode).toBe("some-future-mode");
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

  it("sends only the fetch options that were set", async () => {
    const { client, seen } = mockClient(() => json(FETCH_BODY));
    await client.fetch("https://example.com/");
    expect(Object.fromEntries(new URL(seen[0]!.url).searchParams)).toEqual({
      url: "https://example.com/",
    });

    await client.fetch("https://example.com/", {
      maxChars: 300,
      live: true,
      prompt: "What is this domain for?",
      sessionId: "agent-run-7",
    });
    expect(Object.fromEntries(new URL(seen[1]!.url).searchParams)).toEqual({
      url: "https://example.com/",
      max_chars: "300",
      live: "true",
      prompt: "What is this domain for?",
      session_id: "agent-run-7",
    });

    await client.fetch("https://example.com/", { live: false });
    expect(new URL(seen[2]!.url).searchParams.get("live")).toBe("false");
  });

  it("rejects a non-integer maxChars before sending", async () => {
    const { client, seen } = mockClient(() => json(FETCH_BODY));
    await expect(client.fetch("https://example.com/", { maxChars: 1.5 })).rejects.toThrow(
      KeenableInvalidRequestError,
    );
    expect(seen).toHaveLength(0);
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

    const unauthorized = mockClient(() => json({ error: "bad key" }, 401));
    await expect(unauthorized.client.search("q")).rejects.toBeInstanceOf(
      KeenableAuthError,
    );
  });

  const withHeaders = (body: unknown, status: number, headers: Record<string, string>) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", ...headers },
    });

  const thrown = async (promise: Promise<unknown>) => {
    try {
      await promise;
    } catch (error) {
      return error as KeenableAPIError;
    }
    throw new Error("expected the call to throw");
  };

  it.each([
    [400, "Invalid parameter", KeenableValidationError, "retrying unchanged fails"],
    [422, "Unprocessable", KeenableValidationError, "Fix the"],
    [401, "Authentication failed", KeenableAuthError, "KEENABLE_API_KEY"],
    [402, "Payment required", KeenableCreditsError, "Add credits"],
    [403, "Forbidden", KeenableForbiddenError, "This needs an API key"],
    [503, "Unavailable", KeenableAPIError, "safe to repeat"],
  ] as const)(
    "maps %i to the right error and carries the API fields",
    async (status, apiError, expected, hintPart) => {
      const body = { error: apiError, message: "the api message", details: { param: "x" } };
      const { client } = mockClient(() =>
        withHeaders(body, status, { "X-Request-Id": "req-123" }),
      );
      const error = await thrown(client.search("q"));
      expect(error.constructor).toBe(expected);
      expect(error.statusCode).toBe(status);
      expect(error.body).toBe("the api message");
      expect(error.apiError).toBe(apiError);
      expect(error.details).toEqual({ param: "x" });
      expect(error.requestId).toBe("req-123");
      expect(error.hint).toContain(hintPart);
      expect(error.message).toContain("(request_id: req-123)");
      expect(error.message.endsWith(error.hint ?? "")).toBe(true);
    },
  );

  it("tells a missing page to check the URL, without a double period", async () => {
    const { client } = mockClient(() =>
      json({ error: "Not found", message: "The page does not exist at this URL." }, 404),
    );
    const error = await thrown(client.fetch("https://example.com/missing"));
    expect(error.hint).toBe("Check the URL; retrying unchanged fails the same way.");
    expect(error.message).toBe(
      "Keenable API error (404): The page does not exist at this URL. " +
        "Check the URL; retrying unchanged fails the same way.",
    );
    expect(error.body).toBe("The page does not exist at this URL.");
  });

  it("keeps 403 an auth error for existing instanceof checks", async () => {
    const { client } = mockClient(() => json({ error: "Forbidden", message: "no" }, 403));
    const error = await thrown(client.search("q"));
    expect(error).toBeInstanceOf(KeenableAuthError);
    expect(error).toBeInstanceOf(KeenableForbiddenError);
    expect(error.message).not.toContain("authentication failed");
  });

  it("tells keyed callers about their plan, not about setting a key", async () => {
    const { client } = mockClient(() => json({ message: "no" }, 403), { apiKey: "keen_x" });
    const error = await thrown(client.search("q"));
    expect(error.hint).not.toContain("KEENABLE_API_KEY");
    expect(error.hint).toContain("plan");
  });

  it("reads the rate-limit headers and words the hint by key state", async () => {
    const headers = {
      "X-RateLimit-Limit": "1000",
      "X-RateLimit-Remaining": "0",
      "X-RateLimit-Reset": "2026-11-02T19:48:53.100Z",
    };
    const keyless = mockClient(() => withHeaders({ message: "cap" }, 429, headers)).client;
    const error = (await thrown(keyless.search("q"))) as KeenableRateLimitError;
    expect([error.limit, error.remaining, error.reset]).toEqual([
      1000,
      0,
      "2026-11-02T19:48:53.100Z",
    ]);
    expect(error.message).toContain("Retry after 2026-11-02T19:48:53.100Z");
    expect(error.message).toContain("KEENABLE_API_KEY");

    const keyed = mockClient(() => withHeaders({ message: "cap" }, 429, headers), {
      apiKey: "keen_x",
    }).client;
    const keyedError = await thrown(keyed.search("q"));
    expect(keyedError.message).not.toContain("KEENABLE_API_KEY");
  });

  it("never puts the API key in an error message", async () => {
    const { client } = mockClient(() => json({ message: "bad" }, 401), {
      apiKey: "keen_secret",
    });
    const error = await thrown(client.search("q"));
    expect(error.message).not.toContain("keen_secret");
  });

  it("puts the request id on successful responses", async () => {
    const { client } = mockClient((url) =>
      withHeaders(url.includes("/v1/search") ? SEARCH_BODY : FETCH_BODY, 200, {
        "X-Request-Id": "req-ok",
      }),
    );
    expect((await client.search("q")).requestId).toBe("req-ok");
    expect((await client.fetch("https://example.com/")).requestId).toBe("req-ok");
  });

  it("keeps the request id in the message of an undecodable 2xx reply", async () => {
    const { client } = mockClient(
      () => new Response("<html>", { status: 200, headers: { "X-Request-Id": "req-bad" } }),
    );
    const error = await thrown(client.search("q"));
    expect(error.message).toContain("(request_id: req-bad)");
    expect(error.requestId).toBe("req-bad");
  });

  it("says a failed connection is safe to retry", async () => {
    const client = new Keenable({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof globalThis.fetch,
    });
    await expect(client.search("q")).rejects.toThrow(KeenableConnectionError);
    await expect(client.search("q")).rejects.toThrow(/Retrying is safe/);
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

describe("tool schemas", () => {
  // Pinned on purpose: a model chooses worse among many knobs, so new search
  // parameters stay SDK-only unless deliberately exposed here.
  it("offer the model exactly these arguments", () => {
    const props = Object.fromEntries(
      TOOLS.map((t) => [
        t.function.name,
        Object.keys((t.function.parameters as { properties: object }).properties).sort(),
      ]),
    );
    expect(props).toEqual({
      keenable_search: ["published_after", "query", "site"],
      keenable_fetch: ["url"],
    });
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
