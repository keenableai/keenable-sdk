/**
 * The shared conformance cases (scripts/conformance), which the Python and Go
 * SDKs run too. Every case goes through the public client with a scripted
 * `fetch`, so a behaviour that differs between the SDKs fails here.
 */
import { readFileSync } from "node:fs";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  Keenable,
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableInsufficientCreditsError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
  KeenableTimeoutError,
  runToolCall,
  verifyWebhook,
  WebhookVerificationError,
} from "../src/index.js";
import type { Billing, KeenableOptions, Money, SearchOptions, SearchResponse } from "../src/index.js";
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
    endpoint: "search";
    arg: string;
    expect: Record<string, Json>;
  })[];
  billing: (Reply & {
    name: string;
    keyed: boolean;
    expect: { path: string; error: string | null; request_id: string | null; billing: Json };
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
  tool_call: { name: string; arguments: string; sent: Json; invalid: boolean }[];
  deadline: {
    slack: number;
    cases: {
      name: string;
      phase: "headers" | "body" | "terminator" | "none";
      timeout: number;
      interval: number;
      pieces: number;
      outcome: "timeout" | "success";
      skip: Record<string, string>;
    }[];
  };
  webhook: {
    name: string;
    secret: string;
    headers: Record<string, string>;
    body: string;
    now: number;
    tolerance: number;
    valid: boolean;
    type: string | null;
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
const PAGE_OK: Reply = { status: 200, headers: {}, body: JSON.stringify({ results: [] }) };
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
      client.search(c.arg),
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
      warnings: r.warnings.map((w) => ({ code: w.code, path: w.path, message: w.message })),
      usage: r.usage
        ? {
            sku: r.usage.sku,
            amount: r.usage.amount,
            credits: r.usage.credits,
            paid: r.usage.paid,
            credits_remaining: r.usage.credits_remaining ?? null,
            cost: r.usage.cost ? { amount: r.usage.cost.amount, currency: r.usage.cost.currency } : null,
            balance: r.usage.balance ? { amount: r.usage.balance.amount, currency: r.usage.balance.currency } : null,
          }
        : null,
    }).toEqual(want);
  });
});

describe("billing", () => {
  const money = (m: Money) => ({
    amount: m.amount,
    amount_decimal: m.amountDecimal,
    currency: m.currency,
  });
  it.each(FIXTURE.billing.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await call([c], { apiKey: c.keyed ? "k" : "", maxRetries: 0 }, (client) =>
      client.billing(),
    );
    expect(outcome.requests).toHaveLength(1);
    const { url, init } = outcome.requests[0]!;
    const sent = new URL(url);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(sent.pathname).toBe(c.expect.path);
    expect(sent.search).toBe("");
    expect(new Headers(init.headers).get("X-API-Key")).toBe(c.keyed ? "k" : null);
    if (c.expect.error !== null) {
      const kind = KINDS[c.expect.error];
      if (!kind) throw new Error(`unknown kind ${c.expect.error}`);
      expect(outcome.error).toBeInstanceOf(kind);
      return;
    }
    expect(outcome.error).toBeUndefined();
    const b = outcome.result as Billing;
    expect(b.requestId ?? null).toBe(c.expect.request_id);
    expect({
      prices: b.prices.map((p) => ({
        sku: p.sku,
        unit: p.unit,
        unit_price: money(p.unitPrice),
        list_unit_price: p.listUnitPrice ? money(p.listUnitPrice) : null,
        source: p.source ?? null,
      })),
      account: b.account && {
        balance: {
          available: money(b.account.balance.available),
        },
        billing_url: b.account.billingUrl,
        as_of: b.account.asOf,
      },
    }).toEqual(c.expect.billing);
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

describe("the fetch body", () => {
  it("a refused URL sends nothing, whatever the options", async () => {
    const outcome = await call([PAGE_OK], {}, (client) =>
      client.fetch("http://127.0.0.1/", { maxChars: 10, maxAgeHours: 0 }),
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

describe("the whole-attempt deadline", () => {
  const DEADLINE_JSON = '{"results": []}';
  type DeadlineCase = Fixture["deadline"]["cases"][number];
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /** Answers as the case says (scripts/conformance/cases/deadline.json). */
  async function servePhase(socket: Socket, c: DeadlineCase): Promise<void> {
    const write = (text: string) => {
      if (!socket.destroyed) socket.write(text);
    };
    const trickle = async (unit: string) => {
      for (let i = 0; i < c.pieces; i++) {
        await sleep(c.interval * 1000);
        write(unit);
      }
    };
    const rest = `Content-Type: application/json\r\nContent-Length: ${DEADLINE_JSON.length}\r\n\r\n${DEADLINE_JSON}`;
    if (c.phase === "headers") {
      write("HTTP/1.1 200 OK\r\nX-Slow: ");
      await trickle("a");
      write(`\r\n${rest}`);
    } else if (c.phase === "body") {
      write(
        `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${c.pieces + DEADLINE_JSON.length}\r\n\r\n`,
      );
      await trickle(" ");
      write(DEADLINE_JSON);
    } else if (c.phase === "terminator") {
      write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n");
      await sleep(c.interval * 1000);
      write(`${DEADLINE_JSON.length.toString(16)}\r\n${DEADLINE_JSON}\r\n`);
      await trickle("0\r\n\r\n");
    } else {
      write(`HTTP/1.1 200 OK\r\n${rest}`);
    }
  }

  /** A raw HTTP/1.1 server on 127.0.0.1; resolves to its base URL. */
  async function deadlineServer(c: DeadlineCase): Promise<{ base: string; server: Server }> {
    const server = createServer((socket) => {
      socket.on("error", () => {});
      let seen = "";
      let answered = false;
      socket.on("data", (chunk) => {
        seen += chunk.toString("latin1");
        const end = seen.indexOf("\r\n\r\n");
        if (answered || end < 0) return;
        const length = Number(/content-length:\s*(\d+)/i.exec(seen.slice(0, end))?.[1] ?? 0);
        if (seen.length - end - 4 < length) return;
        answered = true;
        void servePhase(socket, c).then(() => setTimeout(() => socket.destroy(), 200));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, server };
  }

  const cases = FIXTURE.deadline.cases.filter((c) => !("typescript" in c.skip));
  it.each(cases.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const { base, server } = await deadlineServer(c);
    try {
      const keenable = new Keenable({
        apiKey: "",
        baseUrl: base,
        timeoutMs: c.timeout * 1000,
        maxRetries: 0,
      });
      const started = performance.now();
      let error: unknown;
      let result: SearchResponse | undefined;
      try {
        result = await keenable.search("q");
      } catch (caught) {
        error = caught;
      }
      const elapsed = (performance.now() - started) / 1000;
      if (c.outcome === "timeout") {
        expect(error).toBeInstanceOf(KeenableTimeoutError);
        expect(elapsed).toBeGreaterThanOrEqual(c.timeout - 0.05);
        expect(elapsed).toBeLessThanOrEqual(c.timeout + FIXTURE.deadline.slack);
      } else {
        expect(error).toBeUndefined();
        expect(result?.results).toEqual([]);
        expect(elapsed).toBeLessThan(c.timeout);
      }
    } finally {
      server.close();
    }
  });
});

describe("webhook", () => {
  it.each(FIXTURE.webhook.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const verify = verifyWebhook(new TextEncoder().encode(c.body), c.headers, c.secret, {
      toleranceSeconds: c.tolerance,
      now: c.now,
    });
    if (c.valid) {
      expect((await verify).type).toBe(c.type);
    } else {
      await expect(verify).rejects.toBeInstanceOf(WebhookVerificationError);
    }
  });
});
