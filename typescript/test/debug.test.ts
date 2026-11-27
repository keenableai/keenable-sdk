import { afterEach, describe, expect, it, vi } from "vitest";

import { Keenable, KeenableAPIError, KeenableConnectionError } from "../src/index.js";
import type { KeenableOptions } from "../src/index.js";

const SECRET = "sk-secret-key-must-not-appear";
const SECRET_HEADER = "header-secret-must-not-appear";
const SECRET_QUERY = "query-text-must-not-appear";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

// Retry-After: 0 keeps the retry instant.
const busy = () => json({ message: "busy" }, 503, { "Retry-After": "0", "X-Request-Id": "req-1" });
const ok = () => json({ query: "q", results: [] }, 200, { "X-Request-Id": "req-2" });

function scripted(
  replies: Array<() => Response | Promise<Response>>,
  options: KeenableOptions = {},
) {
  let calls = 0;
  return new Keenable({
    apiKey: SECRET,
    defaultHeaders: { "X-Proxy-Token": SECRET_HEADER },
    ...options,
    fetch: (async () => {
      const next = replies[Math.min(calls, replies.length - 1)];
      calls += 1;
      if (!next) throw new Error("no reply scripted");
      return next();
    }) as unknown as typeof globalThis.fetch,
  });
}

function capture() {
  const lines: string[] = [];
  return { lines, logger: { debug: (message: string) => lines.push(message) } };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("debug logging", () => {
  it("logs one line per attempt, never the key, headers or body", async () => {
    const { lines, logger } = capture();
    await scripted([busy, ok], { logger }).search(SECRET_QUERY);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^keenable: method=POST path=\/v1\/search attempt=1 status=503 elapsed_ms=\d+ retry=true wait_ms=0 request_id=req-1$/,
    );
    expect(lines[1]).toMatch(
      /^keenable: method=POST path=\/v1\/search attempt=2 status=200 elapsed_ms=\d+ retry=false request_id=req-2$/,
    );
    const text = lines.join("\n");
    for (const secret of [SECRET, SECRET_HEADER, SECRET_QUERY]) expect(text).not.toContain(secret);
  });

  it("logs a failure that is not retried", async () => {
    const { lines, logger } = capture();
    await expect(
      scripted([busy], { logger, maxRetries: 0 }).search("q"),
    ).rejects.toBeInstanceOf(KeenableAPIError);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/ attempt=1 status=503 elapsed_ms=\d+ retry=false request_id=req-1$/);
  });

  it("logs a connection error and a redirect by what failed", async () => {
    for (const [reply, error] of [
      [() => Promise.reject(new TypeError("fetch failed")), "connection"],
      [() => new Response(null, { status: 302, headers: { Location: "https://elsewhere.example/" } }), "redirect"],
    ] as const) {
      const { lines, logger } = capture();
      await expect(
        scripted([reply], { logger, maxRetries: 0 }).billing(),
      ).rejects.toBeInstanceOf(KeenableConnectionError);
      expect(lines).toEqual([
        expect.stringMatching(
          new RegExp(`^keenable: method=GET path=/v1/billing attempt=1 error=${error} elapsed_ms=\\d+ retry=false$`),
        ),
      ]);
    }
  });

  it("logs a call the caller aborts as canceled", async () => {
    const { lines, logger } = capture();
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      scripted([ok], { logger }).search("q", { signal: controller.signal }),
    ).rejects.toThrow("stop");
    expect(lines).toEqual([expect.stringMatching(/ attempt=1 error=canceled elapsed_ms=\d+ retry=false$/)]);
  });

  it("KEENABLE_LOG=debug sends the lines to console.debug", async () => {
    vi.stubEnv("KEENABLE_LOG", "debug");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    await scripted([ok]).search(SECRET_QUERY);
    expect(debug).toHaveBeenCalledTimes(1);
    const line = String(debug.mock.calls[0]?.[0]);
    expect(line).toMatch(/^keenable: method=POST path=\/v1\/search attempt=1 status=200 /);
    expect(line).not.toContain(SECRET);
  });

  it("logs nothing without KEENABLE_LOG or a logger", async () => {
    vi.stubEnv("KEENABLE_LOG", "");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await scripted([busy, ok]).search("q");
    expect(debug).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("a logger passed wins over KEENABLE_LOG", async () => {
    vi.stubEnv("KEENABLE_LOG", "debug");
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const { lines, logger } = capture();
    await scripted([ok], { logger }).search("q");
    expect(lines).toHaveLength(1);
    expect(debug).not.toHaveBeenCalled();
  });
});
