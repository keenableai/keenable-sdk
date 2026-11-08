import { describe, expect, it } from "vitest";

import {
  Keenable,
  KeenableAPIError,
  KeenableConnectionError,
  KeenableInsufficientCreditsError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
  KeenableTimeoutError,
} from "../src/index.js";
import type { KeenableOptions } from "../src/index.js";
import { backoffMs, retryDelayMs } from "../src/client.js";

const SEARCH_BODY = { query: "q", results: [{ title: "t", url: "https://e.com", snippet: "s" }] };

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** A client that answers each attempt with the next response in `replies`. */
function scripted(replies: Array<() => Response | Promise<Response>>, options: KeenableOptions = {}) {
  const seen: RequestInit[] = [];
  const client = new Keenable({
    apiKey: "k",
    ...options,
    fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push(init);
      const next = replies[Math.min(seen.length - 1, replies.length - 1)];
      if (!next) throw new Error("no reply scripted");
      return next();
    }) as unknown as typeof globalThis.fetch,
  });
  return { client, seen };
}

// Retry-After: 0 keeps these tests instant while still going through the loop.
const busy = () => json({ code: "search_overloaded", retryable: true }, 529, { "Retry-After": "0" });

describe("retries", () => {
  it("retries a retryable error and returns the later success", async () => {
    const { client, seen } = scripted([busy, busy, () => json(SEARCH_BODY)]);
    const response = await client.search("q");
    expect(response.results).toHaveLength(1);
    expect(seen).toHaveLength(3);
  });

  it("gives up after maxRetries and throws the last error", async () => {
    const { client, seen } = scripted([busy], { maxRetries: 1 });
    await expect(client.search("q")).rejects.toBeInstanceOf(KeenableAPIError);
    expect(seen).toHaveLength(2);
  });

  it("does not retry when maxRetries is 0, per client or per call", async () => {
    const perClient = scripted([busy], { maxRetries: 0 });
    await expect(perClient.client.search("q")).rejects.toBeInstanceOf(KeenableAPIError);
    expect(perClient.seen).toHaveLength(1);

    const perCall = scripted([busy]);
    await expect(perCall.client.search("q", { maxRetries: 0 })).rejects.toBeInstanceOf(
      KeenableAPIError,
    );
    expect(perCall.seen).toHaveLength(1);
  });

  it("never retries an error the API marks not retryable", async () => {
    const { client, seen } = scripted([
      () => json({ code: "insufficient_credits", retryable: false }, 402),
    ]);
    await expect(client.search("q")).rejects.toBeInstanceOf(KeenableInsufficientCreditsError);
    expect(seen).toHaveLength(1);
  });

  it("trusts retryable: false even on a 5xx", async () => {
    const { client, seen } = scripted([() => json({ retryable: false }, 503)]);
    await expect(client.search("q")).rejects.toBeInstanceOf(KeenableAPIError);
    expect(seen).toHaveLength(1);
  });

  it("does not wait out a Retry-After over a minute, such as the keyless hourly cap", async () => {
    const { client, seen } = scripted([
      () => json({ code: "public_rate_limit_hourly", retryable: true, retry_after_seconds: 1800 }, 429),
    ]);
    const error = await client.search("q").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeenableRateLimitError);
    expect((error as KeenableRateLimitError).retryAfterSeconds).toBe(1800);
    expect(seen).toHaveLength(1);
  });

  it("retries a connection failure", async () => {
    const { client, seen } = scripted(
      [
        () => {
          throw new TypeError("fetch failed");
        },
        () => json(SEARCH_BODY),
      ],
    );
    // The first backoff is at most 500 ms.
    await expect(client.search("q")).resolves.toBeDefined();
    expect(seen).toHaveLength(2);
  });

  it("throws KeenableTimeoutError, a KeenableConnectionError, after the last timed-out attempt", async () => {
    const hang = (_: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const client = new Keenable({
      apiKey: "k",
      timeoutMs: 20,
      maxRetries: 0,
      fetch: hang as unknown as typeof globalThis.fetch,
    });
    const error = await client.search("q").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeenableTimeoutError);
    expect(error).toBeInstanceOf(KeenableConnectionError);
  });

  it("stops waiting for a retry when the caller aborts", async () => {
    const slow = () => json({ retryable: true }, 503, { "Retry-After": "30" });
    const { client, seen } = scripted([slow]);
    const controller = new AbortController();
    const pending = client.search("q", { signal: controller.signal });
    setTimeout(() => controller.abort(new Error("stop")), 20);
    await expect(pending).rejects.toThrow("stop");
    expect(seen).toHaveLength(1);
  });

  it("rejects a bad maxRetries or timeoutMs", () => {
    expect(() => new Keenable({ maxRetries: -1 })).toThrow(KeenableInvalidRequestError);
    expect(() => new Keenable({ maxRetries: 1.5 })).toThrow(KeenableInvalidRequestError);
    expect(() => new Keenable({ timeoutMs: 0 })).toThrow(KeenableInvalidRequestError);
  });
});

describe("retry policy", () => {
  const apiError = (status: number, details: ConstructorParameters<typeof KeenableAPIError>[3] = {}) =>
    new KeenableAPIError("x", status, undefined, details);

  it("retries 408, 429 and 5xx by status when the API did not say", () => {
    for (const status of [408, 429, 500, 502, 503, 504, 529]) {
      expect(retryDelayMs(apiError(status), 0)).toBeDefined();
    }
    for (const status of [400, 401, 402, 403, 404, 409, 422]) {
      expect(retryDelayMs(apiError(status), 0)).toBeUndefined();
    }
  });

  it("lets the API's retryable override the status", () => {
    expect(retryDelayMs(apiError(422, { retryable: true }), 0)).toBeDefined();
    expect(retryDelayMs(apiError(500, { retryable: false }), 0)).toBeUndefined();
  });

  it("waits the API's retry-after when it is a minute or less", () => {
    expect(retryDelayMs(apiError(429, { retryAfterSeconds: 2 }), 0)).toBe(2000);
    expect(retryDelayMs(apiError(429, { retryAfterSeconds: 60 }), 0)).toBe(60_000);
    expect(retryDelayMs(apiError(429, { retryAfterSeconds: 61 }), 0)).toBeUndefined();
  });

  it("backs off exponentially from 0.5 s to 8 s with up to 25% jitter", () => {
    expect([0, 1, 2, 3, 4, 5].map((n) => backoffMs(n, 0))).toEqual([500, 1000, 2000, 4000, 8000, 8000]);
    expect(backoffMs(0, 1)).toBe(375);
  });

  it("does not retry local argument errors", () => {
    expect(retryDelayMs(new KeenableInvalidRequestError("bad"), 0)).toBeUndefined();
  });
});

describe("headers", () => {
  it("sends defaultHeaders and per-call headers, call winning, key untouchable", async () => {
    const { client, seen } = scripted([() => json(SEARCH_BODY)], {
      defaultHeaders: { "X-Gateway": "a", "X-Team": "search" },
    });
    await client.search("q", {
      headers: { "x-gateway": "b", "X-API-Key": "stolen" },
    });
    const sent = seen[0]?.headers as Record<string, string>;
    expect(sent["x-gateway"]).toBe("b");
    expect(sent["X-Gateway"]).toBeUndefined();
    expect(sent["X-Team"]).toBe("search");
    expect(sent["X-API-Key"]).toBe("k");
  });

  it("cannot make a keyless client send a key", async () => {
    const { client, seen } = scripted([() => json(SEARCH_BODY)], {
      apiKey: "",
      defaultHeaders: { "X-API-Key": "nope" },
    });
    await client.search("q");
    const sent = seen[0]?.headers as Record<string, string>;
    expect(Object.keys(sent).map((h) => h.toLowerCase())).not.toContain("x-api-key");
  });
});

describe("request id", () => {
  it("is read from X-Request-Id on search and fetch", async () => {
    const { client } = scripted([
      () => json(SEARCH_BODY, 200, { "X-Request-Id": "req-1" }),
      () => json({ url: "https://e.com", content: "c" }, 200, { "X-Request-Id": "req-2" }),
    ]);
    expect((await client.search("q")).requestId).toBe("req-1");
    expect((await client.fetch("https://e.com")).requestId).toBe("req-2");
  });

  it("prefers the body's request_id", async () => {
    const { client } = scripted([
      () => json({ ...SEARCH_BODY, request_id: "body" }, 200, { "X-Request-Id": "header" }),
    ]);
    expect((await client.search("q")).requestId).toBe("body");
  });
});

describe("redirects", () => {
  it("are not followed, so the API key never reaches another host", async () => {
    const { client, seen } = scripted([
      () => new Response(null, { status: 302, headers: { Location: "https://evil.example/" } }),
    ]);
    const error = await client.search("q").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(KeenableConnectionError);
    expect(String(error)).toContain("evil.example");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe("manual");
  });
});

describe("fetch target check", () => {
  const ok = () => json({ url: "https://e.com", content: "c" });

  it("allows public hostnames that merely start like an IPv6 range", async () => {
    const { client } = scripted([ok]);
    for (const url of ["https://fdic.gov/", "https://fcbarcelona.com/", "https://febreze.com/", "https://ff.io/"]) {
      await expect(client.fetch(url)).resolves.toBeDefined();
    }
  });

  it("refuses private, link-local, multicast and loopback IPv6 and IPv4 literals", async () => {
    const { client } = scripted([ok]);
    for (const url of [
      "https://[fd00::1]/",
      "https://[fe80::1]/",
      "https://[ff02::1]/",
      "https://[::1]/",
      "https://224.0.0.1/",
      "https://255.255.255.255/",
    ]) {
      await expect(client.fetch(url)).rejects.toBeInstanceOf(KeenableInvalidRequestError);
    }
  });

  it("allows global IPv6 literals and refuses 00fc::1, which is outside 2000::/3", async () => {
    const { client } = scripted([ok]);
    await expect(client.fetch("https://[fc::1]/")).rejects.toBeInstanceOf(
      KeenableInvalidRequestError,
    );
    await expect(client.fetch("https://[2606:4700::1111]/")).resolves.toBeDefined();
  });
});
