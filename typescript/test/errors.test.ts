/**
 * The API's agent-ready error contract, parsed into typed errors.
 *
 * Fixtures in `fixtures/error_contract.json` are the bodies and headers the
 * backend sends (keenable-backend-ts PRs #663 and #666), generated from its
 * own error constructors.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  Keenable,
  KeenableAPIError,
  KeenableAuthError,
  KeenableCreditsError,
  KeenableInsufficientCreditsError,
  KeenableRateLimitError,
} from "../src/index.js";

interface Case {
  name: string;
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  expect: {
    kind: "auth" | "rate_limit" | "insufficient_credits" | "api";
    code: string | null;
    retryable: boolean | null;
    retry_after_seconds: number | null;
    request_id: string | null;
    param: string | null;
    docs_url: string | null;
    fix: string | null;
    limit: { scope: string; window: string; max: number; resets_at: string } | null;
    billing_url: string | null;
    auto_top_up_url: string | null;
    pay_per_request: string | null;
    message_contains: string;
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

const orUndefined = <T>(value: T | null): T | undefined => (value === null ? undefined : value);

async function errorFor(response: () => Response, call: "search" | "fetch" = "search") {
  const client = new Keenable({
    apiKey: "k",
    fetch: (async () => response()) as unknown as typeof globalThis.fetch,
  });
  const pending = call === "search" ? client.search("q") : client.fetch("https://example.com");
  const error = await pending.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(KeenableAPIError);
  return error as KeenableAPIError;
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) => () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("backend error bodies", () => {
  it.each(CASES.map((c) => [c.name, c] as const))("%s parses into a typed error", async (_name, c) => {
    const error = await errorFor(reply(c.status, c.body, c.headers));
    const want = c.expect;

    expect(error.constructor).toBe(KINDS[want.kind]);
    expect(error.statusCode).toBe(c.status);
    expect(error.code).toBe(orUndefined(want.code));
    expect(error.error).toBe(c.body.error);
    expect(error.fix).toBe(orUndefined(want.fix));
    expect(error.docsUrl).toBe(orUndefined(want.docs_url));
    expect(error.retryable).toBe(orUndefined(want.retryable));
    expect(error.retryAfterSeconds).toBe(orUndefined(want.retry_after_seconds));
    expect(error.requestId).toBe(orUndefined(want.request_id));
    expect(error.param).toBe(orUndefined(want.param));
    expect(error.billingUrl).toBe(orUndefined(want.billing_url));
    expect(error.autoTopUpUrl).toBe(orUndefined(want.auto_top_up_url));
    expect(error.payPerRequest).toBe(orUndefined(want.pay_per_request));
    expect(error.raw).toEqual(c.body);
    expect(error.message).toContain(want.message_contains);
    if (want.limit === null) {
      expect(error.limit).toBeUndefined();
    } else {
      expect(error.limit).toEqual({
        scope: want.limit.scope,
        window: want.limit.window,
        max: want.limit.max,
        resetsAt: want.limit.resets_at,
      });
    }
  });

  it("does not report a blocked fetch target as an auth failure", async () => {
    const c = CASES.find((x) => x.name === "target_blocked")!;
    const error = await errorFor(reply(403, c.body), "fetch");

    expect(error).not.toBeInstanceOf(KeenableAuthError);
    expect(error.message.startsWith("Keenable API error (403): ")).toBe(true);
  });
});

describe("compatibility with today's API", () => {
  it("keeps the 402 message and makes it an InsufficientCredits error", async () => {
    const error = await errorFor(reply(402, { detail: "no credits" }));

    expect(error).toBeInstanceOf(KeenableInsufficientCreditsError);
    expect(error).toBeInstanceOf(KeenableCreditsError);
    expect(error.message).toBe("Keenable: insufficient credits (402): no credits");
    expect(error.billingUrl).toBeUndefined();
  });

  it("leaves every new field undefined when the API does not send it", async () => {
    const error = await errorFor(reply(429, { message: "hourly cap reached" }));

    expect(error).toBeInstanceOf(KeenableRateLimitError);
    expect(error.message).toBe("Keenable rate limit exceeded (429): hourly cap reached");
    expect(error.body).toBe("hourly cap reached");
    for (const field of [
      "code",
      "fix",
      "docsUrl",
      "retryable",
      "retryAfterSeconds",
      "requestId",
      "param",
      "limit",
      "billingUrl",
      "autoTopUpUrl",
      "payPerRequest",
    ] as const) {
      expect(error[field], field).toBeUndefined();
    }
  });

  it("keeps raw undefined for a non-JSON body", async () => {
    const error = await errorFor(reply(502, "upstream exploded"));

    expect(error.raw).toBeUndefined();
    expect(error.message).toBe("Keenable API error (502): upstream exploded");
  });
});

describe("retry hints", () => {
  it("uses the Retry-After header and X-Request-Id when the body has none", async () => {
    const error = await errorFor(
      reply(429, { message: "slow down" }, { "Retry-After": "7", "X-Request-Id": "req-h" }),
    );

    expect(error.retryAfterSeconds).toBe(7);
    expect(error.requestId).toBe("req-h");
  });

  it("turns a Retry-After HTTP date into seconds from now", async () => {
    const when = new Date(Date.now() + 30_000).toUTCString();
    const error = await errorFor(reply(503, { error: "x" }, { "Retry-After": when }));

    expect(error.retryAfterSeconds).toBeGreaterThanOrEqual(25);
    expect(error.retryAfterSeconds).toBeLessThanOrEqual(31);
  });

  it("caps an oversized Retry-After header instead of returning Infinity", async () => {
    const error = await errorFor(reply(429, { message: "m" }, { "Retry-After": "9".repeat(400) }));

    expect(error.retryAfterSeconds).toBe(365 * 24 * 60 * 60);
  });

  it("keeps a zero-padded Retry-After header's value", async () => {
    const error = await errorFor(reply(429, { message: "m" }, { "Retry-After": "0000000001" }));

    expect(error.retryAfterSeconds).toBe(1);
  });

  it("ends the message with the API's fix", async () => {
    const error = await errorFor(reply(403, { error: "Forbidden", fix: "Create a new key." }));

    expect(error.message).toBe("Keenable authentication failed (403): Forbidden. Create a new key.");
  });

  it("falls back to the older retryAfter body field", async () => {
    const error = await errorFor(reply(429, { message: "m", retryAfter: 3 }));

    expect(error.retryAfterSeconds).toBe(3);
  });

  it("prefers the body over the header and ignores malformed values", async () => {
    const preferred = await errorFor(
      reply(429, { retry_after_seconds: 4, retryable: "yes", limit: "nope" }, { "Retry-After": "9" }),
    );
    expect(preferred.retryAfterSeconds).toBe(4);
    expect(preferred.retryable).toBeUndefined();
    expect(preferred.limit).toBeUndefined();

    const malformed = await errorFor(
      reply(429, { retry_after_seconds: -1 }, { "Retry-After": "soon" }),
    );
    expect(malformed.retryAfterSeconds).toBeUndefined();
  });
});
