/**
 * Retries, timeouts, request ids, redirects and malformed bodies, end to end,
 * with the same scenarios as python/tests/test_transport.py and
 * go/transport_test.go. The retry decision for each code in the API's error
 * catalog is checked against the fixture the other SDKs test.
 */
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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
} from "../src/index.js";
import type { KeenableOptions, RequestOptions } from "../src/index.js";
import { backoffMs } from "../src/client.js";

interface Case {
  name: string;
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  expect: {
    kind: "auth" | "rate_limit" | "insufficient_credits" | "api";
    retryable: boolean | null;
    retry_after_seconds: number | null;
  };
}

const CASES: Case[] = JSON.parse(
  readFileSync(new URL("./fixtures/error_contract.json", import.meta.url), "utf8"),
).cases;

const KINDS = {
  auth: KeenableAuthError,
  rate_limit: KeenableRateLimitError,
  insufficient_credits: KeenableInsufficientCreditsError,
  api: KeenableAPIError,
} as const;

const YEAR = 365 * 24 * 60 * 60;
const SEARCH_BODY = { query: "q", results: [{ title: "t", url: "https://e.com", snippet: "s" }] };
const PAGE_BODY = { url: "https://e.com", content: "c" };
/** The client's per-attempt deadline in these tests; any other timer is a retry wait. */
const DEADLINE_MS = 123_456;

type Reply = () => Response | Promise<Response>;

const res =
  (status: number, body?: unknown, headers: Record<string, string> = {}): Reply =>
  () =>
    new Response(
      body === undefined ? null : typeof body === "string" ? body : JSON.stringify(body),
      { status, headers },
    );
const ok = (headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  res(200, { ...SEARCH_BODY, ...extra }, headers);
const page = (headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  res(200, { ...PAGE_BODY, ...extra }, headers);
const networkError: Reply = () => {
  throw new TypeError("fetch failed");
};

/** The retry waits, recorded instead of slept through. */
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

interface Outcome {
  result?: unknown;
  error?: unknown;
  requests: Array<{ url: string; init: RequestInit }>;
}

async function run(
  replies: Reply[],
  {
    method = "search",
    arg = "q",
    call = {},
    ...options
  }: KeenableOptions & { method?: "search" | "fetch"; arg?: string; call?: RequestOptions } = {},
): Promise<Outcome> {
  const outcome: Outcome = { requests: [] };
  const client = new Keenable({
    apiKey: "k",
    timeoutMs: DEADLINE_MS,
    ...options,
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      outcome.requests.push({ url: String(input), init });
      const next = replies[Math.min(outcome.requests.length, replies.length) - 1];
      if (!next) throw new Error("no reply scripted");
      return next();
    }) as unknown as typeof globalThis.fetch,
  });
  try {
    outcome.result =
      method === "search" ? await client.search(arg, call) : await client.fetch(arg, call);
  } catch (error) {
    outcome.error = error;
  }
  return outcome;
}

const inBackoff = (wait: number | undefined, retry: number) => {
  const base = backoffMs(retry, 0);
  return wait !== undefined && wait >= base * 0.75 && wait <= base;
};

describe("the retry decision for every code the API documents", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const outcome = await run([res(c.status, c.body, c.headers), ok()], { maxRetries: 1 });
    const retryable =
      c.expect.retryable ?? (c.status === 408 || c.status === 429 || c.status >= 500);
    const after = c.expect.retry_after_seconds;

    if (!retryable || (after !== null && after > 60)) {
      expect(outcome.error).toBeInstanceOf(KINDS[c.expect.kind]);
      expect((outcome.error as Error).constructor).toBe(KINDS[c.expect.kind]);
      expect(outcome.requests).toHaveLength(1);
      expect(waits).toEqual([]);
      return;
    }
    expect(outcome.error).toBeUndefined();
    expect(outcome.requests).toHaveLength(2);
    expect(waits).toHaveLength(1);
    if (after === null) expect(inBackoff(waits[0], 0)).toBe(true);
    else expect(waits[0]).toBe(after * 1000);
  });
});

describe("retry by status, when the API sends no retryable", () => {
  it.each([400, 401, 402, 403, 404, 409, 413, 422, 451])("does not retry %i", async (status) => {
    const outcome = await run([res(status, { message: "no" }), ok()]);
    expect(outcome.error).toBeInstanceOf(KeenableAPIError);
    expect((outcome.error as KeenableAPIError).statusCode).toBe(status);
    expect(outcome.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it.each([408, 429, 500, 502, 503, 504, 529])("retries %i with backoff", async (status) => {
    const outcome = await run([res(status, { message: "busy" }), ok()]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.requests).toHaveLength(2);
    expect(inBackoff(waits[0], 0)).toBe(true);
  });

  it("lets the API's retryable override the status and a Retry-After", async () => {
    let outcome = await run([res(400, { retryable: true }), ok()]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.requests).toHaveLength(2);

    outcome = await run([res(429, { retryable: false, retry_after_seconds: 1 }), ok()]);
    expect(outcome.error).toBeInstanceOf(KeenableRateLimitError);
    expect(outcome.requests).toHaveLength(1);
  });

  it("retries a network failure", async () => {
    const outcome = await run([networkError, ok()]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.requests).toHaveLength(2);
    expect(inBackoff(waits[0], 0)).toBe(true);
  });

  it("retries search and fetch alike, resending the same search body", async () => {
    let outcome = await run([res(503), page()], { method: "fetch", arg: "https://e.com" });
    expect(outcome.error).toBeUndefined();
    expect(outcome.requests.map((r) => r.init.method)).toEqual(["GET", "GET"]);

    outcome = await run([res(503), ok()]);
    expect(outcome.requests.map((r) => r.init.method)).toEqual(["POST", "POST"]);
    expect(outcome.requests[1]?.init.body).toBe(outcome.requests[0]?.init.body);
  });
});

describe("the retry budget", () => {
  it("is two retries by default", async () => {
    const outcome = await run([res(503)]);
    expect(outcome.error).toBeInstanceOf(KeenableAPIError);
    expect(outcome.requests).toHaveLength(3);
    expect(inBackoff(waits[0], 0) && inBackoff(waits[1], 1)).toBe(true);
  });

  it.each([
    [0, undefined, 1],
    [0, 3, 4],
    [5, 1, 2],
    [5, 0, 1],
    [1, undefined, 2],
  ])("client %i, call %s: %i attempts", async (client, call, attempts) => {
    const outcome = await run([res(503)], { maxRetries: client, call: { maxRetries: call } });
    expect(outcome.error).toBeInstanceOf(KeenableAPIError);
    expect(outcome.requests).toHaveLength(attempts);
    expect(waits).toHaveLength(attempts - 1);
  });

  it("throws the last error when it runs out", async () => {
    const outcome = await run(
      [res(503, { code: "first" }), res(502, { code: "last" }, { "X-Request-Id": "r2" })],
      { maxRetries: 1 },
    );
    expect((outcome.error as KeenableAPIError).code).toBe("last");
    expect((outcome.error as KeenableAPIError).requestId).toBe("r2");
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a per-call maxRetries of %s before sending",
    async (bad) => {
      const outcome = await run([ok()], { call: { maxRetries: bad } });
      expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
      expect(outcome.requests).toHaveLength(0);
      expect(() => new Keenable({ maxRetries: bad })).toThrow(KeenableInvalidRequestError);
    },
  );
});

describe("backoff and jitter", () => {
  it("doubles from 0.5 s to 8 s and jitter shortens it by at most a quarter", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map((n) => backoffMs(n, 0))).toEqual([
      500, 1000, 2000, 4000, 8000, 8000, 8000,
    ]);
    for (let retry = 0; retry < 8; retry += 1) {
      const base = backoffMs(retry, 0);
      expect(backoffMs(retry, 1)).toBe(base * 0.75);
      for (let i = 0; i < 200; i += 1) {
        const wait = backoffMs(retry);
        expect(wait).toBeGreaterThanOrEqual(base * 0.75);
        expect(wait).toBeLessThanOrEqual(base);
      }
    }
    expect(backoffMs(10_000, 0.5)).toBe(7000);
  });

  it("takes its jitter from Math.random", async () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    const outcome = await run([res(503), res(503), ok()]);
    expect(outcome.error).toBeUndefined();
    expect(waits).toEqual([500, 875]);
  });
});

describe("Retry-After", () => {
  const limited = (headers: Record<string, string> = {}, body: Record<string, unknown> = {}) =>
    res(429, JSON.stringify({ message: "slow", ...body }).replace('"__big__"', "1e400"), headers);

  it.each([
    ["header 0", limited({ "Retry-After": "0" }), 0],
    ["header 60", limited({ "Retry-After": "60" }), 60],
    ["padded header", limited({ "Retry-After": " 7 " }), 7],
    ["zero-padded header", limited({ "Retry-After": "007" }), 7],
    ["body fraction", limited({}, { retry_after_seconds: 0.25 }), 0.25],
    ["body 60", limited({}, { retry_after_seconds: 60 }), 60],
    ["body over header", limited({ "Retry-After": "30" }, { retry_after_seconds: 1 }), 1],
    ["header over legacy", limited({ "Retry-After": "4" }, { retryAfter: 9 }), 4],
    ["legacy", limited({}, { retryAfter: 3 }), 3],
    ["negative body", limited({ "Retry-After": "2" }, { retry_after_seconds: -5 }), 2],
    ["string body", limited({ "Retry-After": "2" }, { retry_after_seconds: "5" }), 2],
    ["bool body", limited({ "Retry-After": "2" }, { retry_after_seconds: true }), 2],
    ["overflowing body", limited({ "Retry-After": "2" }, { retry_after_seconds: "__big__" }), 2],
    ["past date", limited({ "Retry-After": "Wed, 21 Oct 2015 07:28:00 GMT" }), 0],
  ] as const)("%s", async (_name, reply, seconds) => {
    const outcome = await run([reply, ok()]);
    expect(outcome.error).toBeUndefined();
    expect(waits).toEqual([seconds * 1000]);
  });

  it.each([
    ["IMF-fixdate", (d: Date) => d.toUTCString()],
    ["no zone, read as GMT", (d: Date) => d.toUTCString().replace(" GMT", "")],
    [
      "asctime",
      (d: Date) => {
        const [day, date, month, year, time] = d.toUTCString().replace(",", "").split(" ");
        return `${day} ${month} ${date?.replace(/^0/, " ")} ${time} ${year}`;
      },
    ],
  ])("waits until a %s date", async (_name, format) => {
    const when = new Date(Date.now() + 30_000);
    const outcome = await run([limited({ "Retry-After": format(when) }), ok()]);
    expect(outcome.error).toBeUndefined();
    expect(waits[0]).toBeGreaterThanOrEqual(28_000);
    expect(waits[0]).toBeLessThanOrEqual(31_000);
  });

  // Bug: Date.parse read these as dates in the past, so a malformed delay
  // became an immediate retry. Python and Go fall back to backoff.
  it.each(["1.5", "-1", "+5", "5s", "soon", "Jan 1", "1 2", "2015-10-21"])(
    "falls back to backoff for a malformed %j",
    async (header) => {
      const outcome = await run([limited({ "Retry-After": header }), ok()]);
      expect(outcome.error).toBeUndefined();
      expect(inBackoff(waits[0], 0)).toBe(true);
    },
  );

  it.each([
    ["header 61", limited({ "Retry-After": "61" }), 61],
    ["body 60.5", limited({}, { retry_after_seconds: 60.5 }), 60.5],
    ["the hourly cap", limited({}, { retry_after_seconds: 1800 }), 1800],
    // The clamps from #48: a huge delay is a year, not Infinity.
    ["a huge header", limited({ "Retry-After": "9".repeat(400) }), YEAR],
    ["a far date", limited({ "Retry-After": "Fri, 31 Dec 9999 23:59:59 GMT" }), YEAR],
    ["a huge body", limited({}, { retry_after_seconds: 1e300 }), YEAR],
    ["a huge legacy field", limited({}, { retryAfter: 1e30 }), YEAR],
  ] as const)("does not wait out %s", async (_name, reply, reported) => {
    const outcome = await run([reply, ok()]);
    expect(outcome.error).toBeInstanceOf(KeenableRateLimitError);
    expect((outcome.error as KeenableRateLimitError).retryAfterSeconds).toBe(reported);
    expect(outcome.requests).toHaveLength(1);
    expect(waits).toEqual([]);
  });
});

describe("timeouts", () => {
  /** A fetch that never answers until its signal aborts. */
  const hang: Reply = () => new Promise<Response>(() => {});
  const hangUntilAbort = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("aborted", "AbortError")),
      );
    });

  function timed(replies: Array<Reply | "hang">, options: KeenableOptions = {}) {
    const seen: RequestInit[] = [];
    const client = new Keenable({
      apiKey: "k",
      ...options,
      fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        seen.push(init);
        const next = replies[Math.min(seen.length, replies.length) - 1];
        return next === "hang" ? hangUntilAbort(init) : next!();
      }) as unknown as typeof globalThis.fetch,
    });
    return { client, seen };
  }

  beforeEach(() => {
    // These tests need the real deadline timers.
    vi.restoreAllMocks();
  });

  it("throws KeenableTimeoutError naming the deadline, after every attempt timed out", async () => {
    const { client, seen } = timed(["hang"], { timeoutMs: 20, maxRetries: 1 });
    const error = await client.search("q").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeenableTimeoutError);
    expect(error).toBeInstanceOf(KeenableConnectionError);
    expect(String(error)).toContain("within 20 ms");
    expect(seen).toHaveLength(2);
  });

  it("recovers from a timeout during the retries", async () => {
    const { client, seen } = timed(["hang", res(503, {}, { "Retry-After": "0" }), ok()], {
      timeoutMs: 20,
    });
    await expect(client.search("q")).resolves.toBeDefined();
    expect(seen).toHaveLength(3);
  });

  it("does not retry a timeout with retries off", async () => {
    const { client, seen } = timed(["hang", ok()], { timeoutMs: 20, maxRetries: 0 });
    await expect(client.search("q")).rejects.toBeInstanceOf(KeenableTimeoutError);
    expect(seen).toHaveLength(1);
  });

  it("applies a per-call deadline shorter than the client's", async () => {
    const { client } = timed(["hang"], { timeoutMs: 60_000, maxRetries: 0 });
    const error = await client.search("q", { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(String(error)).toContain("within 20 ms");
  });

  it("keeps the client's deadline when the call sets none", async () => {
    const { client } = timed(["hang"], { timeoutMs: 20, maxRetries: 0 });
    const error = await client.search("q", { timeoutMs: undefined }).catch((e: unknown) => e);
    expect(String(error)).toContain("within 20 ms");
  });

  it("gives each attempt a fresh deadline", async () => {
    const slow: Reply = () => new Promise((resolve) => setTimeout(() => resolve(ok()()), 40));
    const { client, seen } = timed(["hang", slow], { timeoutMs: 25, maxRetries: 1 });
    // The second attempt takes longer than the first's deadline would leave.
    await expect(client.search("q", { timeoutMs: 100 })).resolves.toBeDefined();
    expect(seen).toHaveLength(2);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects a timeoutMs of %s before sending",
    async (bad) => {
      const { client, seen } = timed([hang]);
      await expect(client.search("q", { timeoutMs: bad })).rejects.toBeInstanceOf(
        KeenableInvalidRequestError,
      );
      expect(seen).toHaveLength(0);
      expect(() => new Keenable({ timeoutMs: bad })).toThrow(KeenableInvalidRequestError);
    },
  );

  it("rejects with the caller's reason when the signal is already aborted", async () => {
    const { client, seen } = timed([ok()]);
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(client.search("q", { signal: controller.signal })).rejects.toThrow("gone");
    // Bug: a fetch that ignores the signal was still called, and the call
    // resolved. Nothing is sent now.
    expect(seen).toHaveLength(0);
  });
});

describe("request ids", () => {
  it.each([
    ["search", ok({ "X-Request-Id": "h" }), "h"],
    ["search", ok({ "X-Request-Id": "h" }, { request_id: "b" }), "b"],
    ["search", ok({ "X-Request-Id": "  " }), undefined],
    ["search", ok({ "X-Request-Id": "h" }, { request_id: "" }), "h"],
    ["search", ok({ "X-Request-Id": "h" }, { request_id: 7 }), "h"],
    ["search", ok(), undefined],
    ["fetch", page({ "X-Request-Id": "h" }), "h"],
    ["fetch", page({ "X-Request-Id": "h" }, { request_id: "b" }), "b"],
    ["fetch", page(), undefined],
  ] as const)("%s success: %#", async (method, reply, id) => {
    const outcome = await run([reply], { method, arg: method === "fetch" ? "https://e.com" : "q" });
    expect(outcome.error).toBeUndefined();
    expect((outcome.result as { requestId?: string }).requestId).toBe(id);
  });

  it.each([
    [res(400, { message: "m" }, { "X-Request-Id": "h" }), "h"],
    [res(400, { request_id: "b" }, { "X-Request-Id": "h" }), "b"],
    [res(400, "<html>", { "X-Request-Id": "h" }), "h"],
    [res(400, { message: "m" }), undefined],
  ] as const)("error %#", async (reply, id) => {
    const outcome = await run([reply]);
    const error = outcome.error as KeenableAPIError;
    expect(error.requestId).toBe(id);
    if (id) expect(error.message.endsWith(`(request_id: ${id})`)).toBe(true);
    else expect(error.message).not.toContain("request_id");
  });

  it("is the answering attempt's", async () => {
    const outcome = await run([res(503, undefined, { "X-Request-Id": "first" }), ok({ "X-Request-Id": "second" })]);
    expect((outcome.result as { requestId?: string }).requestId).toBe("second");
  });
});

describe("redirects: the API key never leaves the configured host", () => {
  const locations = [
    "https://evil.example/v1/search", // another host
    "https://api.keenable.ai.evil.example/v1/search", // a lookalike
    "https://user@evil.example/v1/search",
    "https://api.keenable.ai:8443/v1/search", // same host, another port
    "http://api.keenable.ai/v1/search", // a scheme downgrade
    "https://api.keenable.ai/v1/search/elsewhere", // the same host
    "/v1/elsewhere",
    undefined,
  ];
  const cases = [300, 301, 302, 303, 304, 307, 308].flatMap((status) =>
    locations.map((location) => [status, location] as const),
  );

  it.each(cases)("%i to %s is refused and not retried", async (status, location) => {
    const outcome = await run([res(status, undefined, location ? { Location: location } : {}), ok()], {
      apiKey: "keen_secret",
    });
    expect(outcome.error).toBeInstanceOf(KeenableConnectionError);
    expect(outcome.error).not.toBeInstanceOf(KeenableTimeoutError);
    expect(outcome.error).not.toBeInstanceOf(KeenableAPIError);
    expect(outcome.requests).toHaveLength(1);
    expect(waits).toEqual([]);
    expect(new URL(outcome.requests[0]!.url).host).toBe("api.keenable.ai");
    expect(outcome.requests[0]!.init.redirect).toBe("manual");
    const message = String(outcome.error);
    expect(message).not.toContain("keen_secret");
    expect(message).toContain("KEENABLE_API_URL");
    if (location) expect(message).toContain(location);
  });

  it("refuses an opaque redirect, as a browser's fetch reports it", async () => {
    const opaque = () =>
      ({ type: "opaqueredirect", status: 0, ok: false, headers: new Headers(), text: async () => "" }) as unknown as Response;
    const outcome = await run([opaque, ok()]);
    expect(outcome.error).toBeInstanceOf(KeenableConnectionError);
    expect(outcome.requests).toHaveLength(1);
  });

  it("with the real fetch, the other host gets no request and no key", async () => {
    vi.restoreAllMocks();
    let otherHits = 0;
    let otherKeys = 0;
    const other = createServer((req, response) => {
      otherHits += 1;
      if (req.headers["x-api-key"]) otherKeys += 1;
      response.end(JSON.stringify(SEARCH_BODY));
    });
    await new Promise<void>((resolve) => other.listen(0, "127.0.0.1", resolve));
    const otherPort = (other.address() as AddressInfo).port;
    let apiHits = 0;
    const api = createServer((req, response) => {
      apiHits += 1;
      const target =
        apiHits === 1
          ? `http://127.0.0.1:${otherPort}/stolen` // same IP, another port
          : `http://localhost:${otherPort}/stolen`; // another name, same machine
      response.writeHead(307, { Location: target, Connection: "close" }).end();
    });
    await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
    const apiPort = (api.address() as AddressInfo).port;
    try {
      const client = new Keenable({
        apiKey: "keen_secret",
        baseUrl: `http://127.0.0.1:${apiPort}`,
        maxRetries: 2,
      });
      for (let i = 0; i < 2; i += 1) {
        await expect(client.search("q")).rejects.toBeInstanceOf(KeenableConnectionError);
      }
      expect(apiHits).toBe(2);
      expect(otherHits).toBe(0);
      expect(otherKeys).toBe(0);
    } finally {
      // Node 18's close() waits for idle keep-alive sockets; drop them first.
      for (const server of [api, other]) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
});

describe("malformed and empty bodies", () => {
  it.each([
    [400, undefined, undefined, undefined, "invalid_request_error"],
    [400, "   ", undefined, undefined, "invalid_request_error"],
    [400, '{"code": "x"', '{"code": "x"', undefined, "invalid_request_error"],
    [400, "[1, 2]", undefined, undefined, "invalid_request_error"],
    [403, "<h1>Forbidden</h1>", "<h1>Forbidden</h1>", undefined, "permission_error"],
    [
      400,
      { message: " ", error: "Bad", detail: "d" },
      "Bad",
      { message: " ", error: "Bad", detail: "d" },
      "invalid_request_error",
    ],
    [400, { detail: "only" }, "only", { detail: "only" }, "invalid_request_error"],
    [400, {}, undefined, {}, "invalid_request_error"],
    [451, {}, undefined, {}, "billing_error"],
  ] as const)("%i %j still maps by status", async (status, body, detail, raw, type) => {
    const outcome = await run([res(status, body)]);
    const error = outcome.error as KeenableAPIError;
    expect(error).toBeInstanceOf(KeenableAPIError);
    expect(error.statusCode).toBe(status);
    expect(error.body).toBe(detail);
    expect(error.raw).toEqual(raw);
    expect(error.type).toBe(type);
    expect(error.code).toBeUndefined();
    if (detail) expect(error.message).toContain(detail);
    expect(outcome.requests).toHaveLength(1);
  });

  it("retries a 5xx HTML page from a proxy", async () => {
    let outcome = await run([res(502, "<html>Bad Gateway</html>"), ok()]);
    expect(outcome.error).toBeUndefined();
    expect(outcome.requests).toHaveLength(2);

    outcome = await run([res(502, "<html>Bad Gateway</html>")]);
    expect((outcome.error as KeenableAPIError).body).toBe("<html>Bad Gateway</html>");
    expect((outcome.error as KeenableAPIError).type).toBe("api_error");
  });

  it.each([
    ["", "non-JSON"],
    ["<html>", "non-JSON"],
    ['{"results": [', "non-JSON"],
    ["[]", "unexpected response"],
    ['"text"', "unexpected response"],
    ["null", "unexpected response"],
  ])("a success body of %j is an error, not retried", async (text, message) => {
    const outcome = await run([res(200, text, { "X-Request-Id": "r" }), ok()]);
    const error = outcome.error as KeenableAPIError;
    expect(error).toBeInstanceOf(KeenableAPIError);
    expect(error.message.toLowerCase()).toContain(message.toLowerCase());
    expect(error.statusCode).toBe(200);
    expect(error.requestId).toBe("r");
    expect(outcome.requests).toHaveLength(1);
  });

  it("parses a lenient success body", async () => {
    let outcome = await run([res(200, { query: "  ", results: [null, 3, { title: "t", url: "u" }] })]);
    const search = outcome.result as { query: string; results: Array<{ title: string }> };
    expect(search.query).toBe("q");
    expect(search.results.map((r) => r.title)).toEqual(["t"]);

    outcome = await run([res(200, { query: 5, results: "x" })]);
    expect((outcome.result as { query: string }).query).toBe("q");

    // Bug: an empty url replaced the one asked for; Python and Go fall back.
    outcome = await run([res(200, { url: "", title: null })], { method: "fetch", arg: "https://e.com/a" });
    expect((outcome.result as { url: string; title: string }).url).toBe("https://e.com/a");
    expect((outcome.result as { title: string }).title).toBe("");
  });
});

describe("fetch targets", () => {
  it.each([
    "http://2130706433/",
    "http://0x7f.0.0.1/",
    "http://0x7F000001/",
    "http://017700000001/",
    "http://0177.0.0.1/",
    "http://127.1/",
    "http://10.1/",
    "http://0/",
    "http://１２７.０.０.１/",
    "http://127。0。0。1/",
    "http://ｌｏｃａｌｈｏｓｔ/",
    "https://user:pass@127.0.0.1/",
    "https://example.com@10.0.0.1/",
    "http://127.0.0.1:8080/",
    "http://[::]/",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://[ff02::1]/",
    "http://224.0.0.1/",
    "http://240.0.0.1/",
    "http://255.255.255.255/",
    "http://0.0.0.0/",
    "http://METADATA.google.internal./",
    "ftp://example.com/",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s before sending", async (url) => {
    const outcome = await run([page()], { method: "fetch", arg: url });
    expect(outcome.error).toBeInstanceOf(KeenableInvalidRequestError);
    expect(outcome.requests).toHaveLength(0);
  });

  it.each([
    "https://fdic.gov/",
    "https://fcbarcelona.com/",
    "https://febreze.com/",
    "https://ff02.example/",
    "https://localhost.example.com/",
    "https://127.0.0.1.nip.io.example/",
    "https://127.0.0.1@example.com/",
    "https://example.com:8443/x",
    "https://1e100.net/",
    "https://0x7f.example/",
    "https://8.8.8.8/",
    "https://134744072/",
    "https://172.32.0.1/",
    "https://例え.jp/",
    "https://xn--r8jz45g.jp/",
  ])("allows %s and sends it unchanged", async (url) => {
    const outcome = await run([page()], { method: "fetch", arg: url });
    expect(outcome.error).toBeUndefined();
    expect(new URL(outcome.requests[0]!.url).searchParams.get("url")).toBe(url);
  });
});
