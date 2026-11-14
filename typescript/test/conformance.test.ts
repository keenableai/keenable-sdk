/**
 * The shared conformance cases (scripts/conformance), which the Python and Go
 * SDKs run too. Every case goes through the public client with a scripted
 * `fetch`, so a behaviour that differs between the SDKs fails here.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Keenable,
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableInsufficientCreditsError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
  runToolCall,
} from "../src/index.js";
import type {
  FetchManyOptions,
  FetchOptions,
  FetchResponse,
  FetchResult,
  FetchStreamItem,
  KeenableOptions,
  Page,
  SearchOptions,
  SearchResponse,
} from "../src/index.js";
import { backoffMs, retryAfterHeader } from "../src/client.js";
import { SEARCH_FILTERS } from "../src/filters.js";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

interface Fixture {
  fetch_url: { name: string; url: string; allowed: boolean }[];
  base_url: { name: string; base_url: string; valid: boolean }[];
  retry_after: { now: string; cases: { name: string; value: string; seconds: number | null }[] };
  retry: (Reply & {
    name: string;
    max_retries: number;
    retried: boolean;
    wait: number | "backoff" | null;
    kind: string | null;
  })[];
  errors: (Reply & { name: string; expect: Record<string, Json> })[];
  responses: (Reply & {
    name: string;
    endpoint: "search" | "fetch";
    arg: string;
    expect: Record<string, Json>;
  })[];
  options: {
    name: string;
    option: "max_retries" | "timeout" | "headers" | "query" | "url" | "disable_cards";
    scope: "client" | "call";
    value: Json;
    valid: boolean;
    skip: Record<string, string>;
  }[];
  search_body: {
    name: string;
    query: string;
    options: Record<string, Json>;
    sent: Json;
    skip: Record<string, string>;
  }[];
  fetch_params: {
    name: string;
    url: string;
    options: { max_chars?: number; live?: boolean; prompt?: string };
    sent: Record<string, string>;
    skip: Record<string, string>;
  }[];
  tool_call: { name: string; arguments: string; sent: Json; invalid: boolean }[];
  fetch_many_body: {
    name: string;
    urls: string | string[];
    options: Record<string, Json>;
    sent: Json;
    skip: Record<string, string>;
  }[];
  fetch_many_responses: (Reply & {
    name: string;
    urls: string | string[];
    expect: Record<string, Json>;
    skip: Record<string, string>;
  })[];
  fetch_many_stream: {
    name: string;
    urls: string | string[];
    headers: Record<string, string>;
    chunks: string[];
    expect: { items: Json[]; summary?: Json; error?: Record<string, Json> };
    skip: Record<string, string>;
  }[];
}

const FIXTURE: Fixture = JSON.parse(
  readFileSync(new URL("./fixtures/conformance.json", import.meta.url), "utf8"),
);

const KINDS: Record<string, abstract new (...args: never[]) => Error> = {
  api: KeenableAPIError,
  auth: KeenableAuthError,
  rate_limit: KeenableRateLimitError,
  insufficient_credits: KeenableInsufficientCreditsError,
  redirect: KeenableConnectionError,
};
const SEARCH_OK: Reply = {
  status: 200,
  headers: {},
  body: JSON.stringify({ query: "q", results: [] }),
};
const PAGE_OK: Reply = { status: 200, headers: {}, body: JSON.stringify({ content: "c" }) };
/** Fields the SDK reads from an error body but never exposes. */
const UNEXPOSED = ["docsUrl", "billingUrl", "autoTopUpUrl", "payPerRequest", "raw"];

/** A Response for a scripted reply; statuses that carry no body get none. */
function response(reply: Reply): Response {
  const empty = [101, 103, 204, 205, 304].includes(reply.status);
  return new Response(empty ? null : reply.body, {
    status: reply.status,
    headers: reply.headers,
  });
}

interface Outcome {
  result?: unknown;
  error?: unknown;
  requests: { url: string; init: RequestInit }[];
}

/** Call search or fetch on a client whose fetch answers with `replies` in turn. */
async function call(
  replies: Reply[],
  options: KeenableOptions,
  invoke: (client: Keenable) => Promise<unknown>,
): Promise<Outcome> {
  const outcome: Outcome = { requests: [] };
  try {
    const client = new Keenable({
      apiKey: "k",
      ...options,
      fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
        outcome.requests.push({ url: String(input), init });
        const next = replies[Math.min(outcome.requests.length, replies.length) - 1];
        if (!next) throw new Error("no reply scripted");
        return response(next);
      }) as unknown as typeof globalThis.fetch,
    });
    outcome.result = await invoke(client);
  } catch (error) {
    outcome.error = error;
  }
  return outcome;
}

/** A fixture value as JavaScript: {"$float": "NaN"} is NaN, null is unset. */
function value(v: Json): unknown {
  if (v === null) return undefined;
  if (typeof v === "object" && !Array.isArray(v) && typeof v.$float === "string") {
    return Number(v.$float);
  }
  return v;
}

/** An error's own fields, in the fixture's names, with undefined as null. */
function errorFields(error: KeenableAPIError): Record<string, Json> {
  const limit = error.limit
    ? {
        scope: error.limit.scope ?? null,
        window: error.limit.window ?? null,
        max: error.limit.max ?? null,
        resets_at: error.limit.resetsAt ?? null,
      }
    : null;
  return {
    detail: error.body ?? null,
    code: error.code ?? null,
    type: error.type ?? null,
    error: error.error ?? null,
    fix: error.fix ?? null,
    retryable: error.retryable ?? null,
    retry_after_seconds: error.retryAfterSeconds ?? null,
    request_id: error.requestId ?? null,
    param: error.param ?? null,
    value: error.value ?? null,
    reason: error.reason ?? null,
    limit,
  };
}

describe("fetch targets", () => {
  it.each(FIXTURE.fetch_url.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await call([PAGE_OK], {}, (client) => client.fetch(c.url));
    if (c.allowed) {
      expect(outcome.error).toBeUndefined();
      expect(outcome.requests).toHaveLength(1);
    } else {
      expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
      expect(outcome.requests).toHaveLength(0);
    }
  });
});

describe("base URLs", () => {
  it.each(FIXTURE.base_url.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const build = () => new Keenable({ baseUrl: c.base_url, fetch: globalThis.fetch });
    if (c.valid) expect(build).not.toThrow();
    else expect(build).toThrow(KeenableInvalidRequestError);
  });
});

describe("Retry-After", () => {
  const now = Date.parse(FIXTURE.retry_after.now);
  it.each(FIXTURE.retry_after.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    expect(retryAfterHeader(c.value, now) ?? null).toBe(c.seconds);
  });
});

describe("the retry decision", () => {
  /** The client's per-attempt deadline here; any other timer is a retry wait. */
  const DEADLINE_MS = 123_456;
  let waits: number[] = [];

  beforeEach(() => {
    waits = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      if (ms === DEADLINE_MS) return real(fn, ms);
      waits.push(ms ?? 0);
      return real(fn, 0);
    }) as typeof setTimeout);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(FIXTURE.retry.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await call(
      [c, SEARCH_OK],
      { maxRetries: c.max_retries, timeoutMs: DEADLINE_MS },
      (client) => client.search("q"),
    );
    if (c.retried) {
      expect(outcome.error).toBeUndefined();
      expect(outcome.requests).toHaveLength(2);
      expect(waits).toHaveLength(1);
      if (c.wait === "backoff") {
        const base = backoffMs(0, 0);
        expect(waits[0]).toBeGreaterThanOrEqual(base * 0.75);
        expect(waits[0]).toBeLessThanOrEqual(base);
      } else {
        expect(waits[0]).toBe((c.wait ?? 0) * 1000);
      }
    } else {
      const kind = KINDS[c.kind ?? ""];
      if (!kind) throw new Error(`unknown kind ${c.kind}`);
      expect(outcome.error).toBeInstanceOf(kind);
      if (c.kind === "redirect") {
        expect(outcome.error).not.toBeInstanceOf(KeenableAPIError);
        expect((outcome.error as Error).message).toContain("redirect");
      } else {
        expect((outcome.error as Error).constructor).toBe(kind);
      }
      expect(outcome.requests).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  });
});

describe("errors", () => {
  it.each(FIXTURE.errors.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await call([c], { maxRetries: 0 }, (client) => client.search("q"));
    const kind = KINDS[c.expect.kind as string];
    if (!kind) throw new Error(`unknown kind ${String(c.expect.kind)}`);
    expect(outcome.error).toBeInstanceOf(kind);
    expect((outcome.error as Error).constructor).toBe(kind);
    const error = outcome.error as KeenableAPIError;
    expect(error.statusCode).toBe(c.status);

    const fields = errorFields(error);
    const { kind: _kind, message_contains, message_excludes, absent, ...want } = c.expect;
    expect(fields).toEqual(want);
    for (const text of message_contains as string[]) expect(error.message).toContain(text);
    for (const text of message_excludes as string[]) expect(error.message).not.toContain(text);

    for (const name of UNEXPOSED) expect(name in error).toBe(false);
    const exposed = Object.entries(error)
      .filter(([key]) => key !== "body" && key !== "fix")
      .map(([, v]) => JSON.stringify(v) ?? "");
    for (const text of absent as string[]) {
      expect(error.message).not.toContain(text);
      expect(String(error)).not.toContain(text);
      for (const field of exposed) expect(field).not.toContain(text);
    }
  });
});

describe("success bodies", () => {
  it.each(FIXTURE.responses.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await call([c, c], { maxRetries: 0 }, (client) =>
      c.endpoint === "search" ? client.search(c.arg) : client.fetch(c.arg),
    );
    expect(outcome.requests).toHaveLength(1);
    if (c.expect.error !== null) {
      const kind = KINDS[c.expect.error as string];
      if (!kind) throw new Error(`unknown kind ${String(c.expect.error)}`);
      expect(outcome.error).toBeInstanceOf(kind);
      return;
    }
    expect(outcome.error).toBeUndefined();
    const { error: _error, ...want } = c.expect;
    if (c.endpoint === "search") {
      const r = outcome.result as SearchResponse;
      expect({
        query: r.query,
        mode: r.mode ?? null,
        request_id: r.requestId ?? null,
        results: r.results.map((x) => ({
          title: x.title,
          url: x.url,
          snippet: x.snippet,
          description: x.description ?? null,
          published_at: x.publishedAt ?? null,
          acquired_at: x.acquiredAt ?? null,
        })),
      }).toEqual(want);
    } else {
      const p = outcome.result as Page;
      expect({
        url: p.url,
        title: p.title,
        content: p.content,
        description: p.description ?? null,
        author: p.author ?? null,
        published_at: p.publishedAt ?? null,
        request_id: p.requestId ?? null,
        truncated: p.truncated ?? null,
        total_chars: p.totalChars ?? null,
      }).toEqual(want);
    }
  });
});

describe("arguments", () => {
  const cases = FIXTURE.options.filter((c) => !("typescript" in c.skip));
  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const v = value(c.value);
    const client: Record<string, unknown> = {};
    const options: Record<string, unknown> = {};
    const target = c.scope === "client" ? client : options;
    let invoke = (k: Keenable): Promise<unknown> => k.search("q", options as SearchOptions);
    switch (c.option) {
      case "max_retries":
        target.maxRetries = v;
        break;
      case "timeout":
        target.timeoutMs = typeof v === "number" ? v * 1000 : v;
        break;
      case "headers":
        target[c.scope === "client" ? "defaultHeaders" : "headers"] = v;
        break;
      case "query":
        invoke = (k) => k.search(v as string);
        break;
      case "url":
        invoke = (k) => k.fetch(v as string);
        break;
      case "disable_cards":
        target.disableCards = v;
        break;
    }
    const outcome = await call([SEARCH_OK], client as KeenableOptions, invoke);
    if (c.valid) {
      expect(outcome.error).toBeUndefined();
      expect(outcome.requests).toHaveLength(1);
    } else {
      expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
      expect(outcome.requests).toHaveLength(0);
    }
  });
});

describe("the search body", () => {
  const byWire = new Map(SEARCH_FILTERS.map((f) => [f.wire, f.option]));
  const cases = FIXTURE.search_body.filter((c) => !("typescript" in (c.skip ?? {})));
  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const options: Record<string, unknown> = {};
    for (const [wire, v] of Object.entries(c.options)) options[byWire.get(wire) ?? wire] = v;
    const outcome = await call([SEARCH_OK], {}, (client) =>
      client.search(c.query, options as SearchOptions),
    );
    expect(outcome.error).toBeUndefined();
    expect(JSON.parse(String(outcome.requests[0]?.init.body))).toEqual(c.sent);
  });
});

describe("the fetch parameters", () => {
  const cases = FIXTURE.fetch_params.filter((c) => !("typescript" in c.skip));
  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const options: FetchOptions = {};
    if ("max_chars" in c.options) options.maxChars = c.options.max_chars;
    if ("live" in c.options) options.live = c.options.live;
    if ("prompt" in c.options) options.prompt = c.options.prompt;
    const outcome = await call([PAGE_OK], {}, (client) => client.fetch(c.url, options));
    expect(outcome.error).toBeUndefined();
    expect(outcome.requests).toHaveLength(1);
    const sent = new URL(outcome.requests[0]!.url);
    expect(sent.pathname).toBe("/v1/fetch");
    expect([...sent.searchParams.entries()].sort()).toEqual(Object.entries(c.sent).sort());
  });

  it("a refused URL sends nothing, whatever the options", async () => {
    const outcome = await call([PAGE_OK], {}, (client) =>
      client.fetch("http://127.0.0.1/", { maxChars: 10, live: true, prompt: "p" }),
    );
    expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
    expect(outcome.requests).toHaveLength(0);
  });
});

describe("tool calls", () => {
  it.each(FIXTURE.tool_call.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await call([SEARCH_OK], {}, (client) =>
      runToolCall(client, "keenable_search", c.arguments),
    );
    if (c.invalid) {
      expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
      expect(outcome.requests).toHaveLength(0);
    } else {
      expect(outcome.error).toBeUndefined();
      expect(JSON.parse(String(outcome.requests[0]?.init.body))).toEqual(c.sent);
    }
  });
});

/** The case's option names, as fetchMany() spells them. */
const FETCH_MANY_NAMES: Record<string, string> = {
  text: "text",
  max_chars: "maxChars",
  offset: "offset",
  include_sections: "includeSections",
  exclude_sections: "excludeSections",
  verbosity: "verbosity",
  summary: "summary",
  output_schema: "outputSchema",
  highlights: "highlights",
  highlights_query: "highlightsQuery",
  highlights_max_chars: "highlightsMaxChars",
  links: "links",
  images: "images",
  subpages: "subpages",
  subpages_target: "subpagesTarget",
  max_age: "maxAge",
  cache_only: "cacheOnly",
  page_timeout: "pageTimeout",
  session_id: "sessionId",
  end_user_id: "endUserId",
};

/** A fetch result in the fixture's snake_case shape. */
function plainResult(x: FetchResult): Record<string, unknown> {
  return {
    url: x.url,
    title: x.title ?? null,
    published_at: x.publishedAt ?? null,
    image: x.image ?? null,
    favicon: x.favicon ?? null,
    text: x.text ?? null,
    next_offset: x.nextOffset ?? null,
    summary: x.summary ?? null,
    highlights: x.highlights,
    links: x.links.map((l) => ({ url: l.url, text: l.text ?? null })),
    images: x.images.map((i) => ({ url: i.url, alt: i.alt ?? null })),
    error: x.error
      ? { code: x.error.code, message: x.error.message, retryable: x.error.retryable, http_status: x.error.httpStatus ?? null }
      : null,
    subpages: x.subpages.map(plainResult),
  };
}

const FETCH_MANY_OK: Reply = { status: 200, headers: {}, body: JSON.stringify({ results: [] }) };

describe("the fetchMany body", () => {
  const cases = FIXTURE.fetch_many_body.filter((c) => !("typescript" in c.skip));
  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const options: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(c.options)) {
      const mapped = FETCH_MANY_NAMES[name];
      if (!mapped) throw new Error(`unknown option ${name}`);
      options[mapped] = v;
    }
    const outcome = await call([FETCH_MANY_OK], {}, (client) =>
      client.fetchMany(c.urls, options as FetchManyOptions),
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.requests[0]?.init.method).toBe("POST");
    expect(new URL(outcome.requests[0]!.url).pathname).toBe("/v1/fetch");
    expect(JSON.parse(String(outcome.requests[0]?.init.body))).toEqual(c.sent);
  });

  it("a private URL anywhere in the list sends nothing", async () => {
    const outcome = await call([FETCH_MANY_OK], {}, (client) =>
      client.fetchMany(["https://example.com/", "http://127.0.0.1/"]),
    );
    expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
    expect(outcome.requests).toHaveLength(0);
  });

  it("an empty list sends nothing", async () => {
    const outcome = await call([FETCH_MANY_OK], {}, (client) => client.fetchMany([]));
    expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
    expect(outcome.requests).toHaveLength(0);
  });

  it("cacheOnly with maxAge 0s sends nothing", async () => {
    const outcome = await call([FETCH_MANY_OK], {}, (client) =>
      client.fetchMany(["https://example.com/"], { cacheOnly: true, maxAge: "0s" }),
    );
    expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
    expect(outcome.requests).toHaveLength(0);
  });

  it("includeSections with excludeSections sends nothing", async () => {
    const outcome = await call([FETCH_MANY_OK], {}, (client) =>
      client.fetchMany(["https://example.com/"], { includeSections: ["body"], excludeSections: ["footer"] }),
    );
    expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
    expect(outcome.requests).toHaveLength(0);
  });
});

describe("fetchMany success bodies", () => {
  const cases = FIXTURE.fetch_many_responses.filter((c) => !("typescript" in c.skip));
  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await call([c], { maxRetries: 0 }, (client) => client.fetchMany(c.urls));
    expect(outcome.error).toBeUndefined();
    const r = outcome.result as FetchResponse;
    expect({
      request_id: r.requestId ?? null,
      latency_ms: r.latencyMs ?? null,
      session_id: r.sessionId ?? null,
      results: r.results.map(plainResult),
      warnings: r.warnings.map((w) => ({ code: w.code, path: w.path, message: w.message })),
    }).toEqual(c.expect);
  });
});

/** A Response whose body arrives in the given chunks. */
function chunked(chunks: string[], headers: Record<string, string> = {}, status = 200): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, { status, headers: { "Content-Type": "application/x-ndjson", ...headers } });
}

async function drain(
  replies: (() => Response)[],
  urls: string | string[],
  maxRetries = 0,
): Promise<{ items: FetchStreamItem[]; summary: unknown; error: unknown; requests: RequestInit[] }> {
  const requests: RequestInit[] = [];
  const client = new Keenable({
    apiKey: "k",
    maxRetries,
    fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      requests.push(init);
      const next = replies[requests.length - 1];
      if (!next) throw new Error("no reply scripted");
      return next();
    }) as unknown as typeof globalThis.fetch,
  });
  const items: FetchStreamItem[] = [];
  let error: unknown;
  const stream = client.fetchManyStream(urls);
  try {
    for await (const item of stream) items.push(item);
  } catch (caught) {
    error = caught;
  }
  return { items, summary: stream.summary, error, requests };
}

describe("fetchManyStream", () => {
  const cases = FIXTURE.fetch_many_stream.filter((c) => !("typescript" in c.skip));
  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await drain([() => chunked(c.chunks, c.headers)], c.urls);
    const sent = outcome.requests[0]!;
    expect((sent.headers as Record<string, string>).Accept).toBe("application/x-ndjson");
    expect(JSON.parse(String(sent.body)).urls).toEqual(Array.isArray(c.urls) ? c.urls : [c.urls]);
    expect(outcome.items.map((item) => ({ index: item.index, result: plainResult(item.result) }))).toEqual(
      c.expect.items,
    );
    if (c.expect.summary !== undefined) {
      expect(outcome.error).toBeUndefined();
      const s = outcome.summary as {
        requestId?: string;
        latencyMs?: number;
        sessionId?: string;
        warnings: { code: string; path: string; message: string }[];
        usage?: Record<string, unknown>;
      };
      expect({
        request_id: s.requestId ?? null,
        latency_ms: s.latencyMs ?? null,
        session_id: s.sessionId ?? null,
        warnings: s.warnings,
        usage: s.usage ?? null,
      }).toEqual(c.expect.summary);
      return;
    }
    const want = c.expect.error!;
    if (want.kind === "connection") {
      expect(outcome.error).toBeInstanceOf(KeenableConnectionError);
      expect(outcome.error).not.toBeInstanceOf(KeenableAPIError);
      return;
    }
    expect(outcome.error).toBeInstanceOf(KeenableAPIError);
    const error = outcome.error as KeenableAPIError;
    if ("code" in want) expect(error.code).toBe(want.code);
    if ("retryable" in want) expect(error.retryable).toBe(want.retryable);
    if ("request_id" in want) expect(error.requestId).toBe(want.request_id);
    if ("message" in want) expect(error.message).toContain(want.message);
  });

  it("throws an error status before any line, typed as in fetchMany", async () => {
    const outcome = await drain(
      [() => new Response(JSON.stringify({ code: "insufficient_credits", error: "Insufficient credits" }), { status: 402 })],
      ["https://e.com/a"],
    );
    expect(outcome.items).toEqual([]);
    expect(outcome.summary).toBeUndefined();
    expect(outcome.error).toBeInstanceOf(KeenableInsufficientCreditsError);
  });

  it("retries a 429 before the stream opens", async () => {
    const outcome = await drain(
      [
        () => new Response(JSON.stringify({ code: "x" }), { status: 429, headers: { "Retry-After": "0" } }),
        () => chunked(['{"index":0,"url":"https://e.com/a"}\n{"done":true}\n']),
      ],
      ["https://e.com/a"],
      1,
    );
    expect(outcome.error).toBeUndefined();
    expect(outcome.items.map((item) => item.index)).toEqual([0]);
    expect(outcome.requests).toHaveLength(2);
  });

  it("refuses a private URL before sending", () => {
    const client = new Keenable({ apiKey: "k", fetch: (() => Promise.reject(new Error("sent"))) as unknown as typeof globalThis.fetch });
    expect(() => client.fetchManyStream(["http://127.0.0.1/"])).toThrow(KeenableInvalidRequestError);
  });

  it("closes the connection when the loop stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"index":0,"url":"https://e.com/a"}\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new Keenable({
      apiKey: "k",
      fetch: (async () => new Response(body, { status: 200 })) as unknown as typeof globalThis.fetch,
    });
    for await (const item of client.fetchManyStream(["https://e.com/a"])) {
      expect(item.index).toBe(0);
      break;
    }
    expect(cancelled).toBe(true);
  });
});
