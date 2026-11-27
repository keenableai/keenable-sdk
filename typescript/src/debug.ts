/**
 * Opt-in debug logging: one line per attempt with the method, the URL's path,
 * the attempt number, the status (or what failed), the elapsed time, the retry
 * decision and wait, and the request id. Never the API key, a header, the
 * query string or a body. The format is the same in every Keenable SDK:
 * scripts/conformance/README.md.
 */

import type { KeenableLogger } from "./types.js";
import { readEnv } from "./internal.js";

/** What one attempt did, as the debug line reports it. */
export interface AttemptLog {
  method: string;
  path: string;
  /** 1 for the first attempt. */
  attempt: number;
  /** The HTTP status, when one counts. */
  status: number | null;
  /** What failed when there is no status: timeout, redirect, canceled or connection. */
  error: string | null;
  elapsedMs: number;
  retry: boolean;
  /** The wait before the next attempt, when `retry` is true. */
  waitMs: number | null;
  requestId: string | null;
}

const MAX_REQUEST_ID = 128;
const PRINTABLE = /^[\x21-\x7e]+$/;

/** Whether a `KEENABLE_LOG` value turns debug logging on: `debug`, in any case. */
export function debugEnabled(value: string | undefined): boolean {
  return value !== undefined && value.trim().toLowerCase() === "debug";
}

/**
 * The logger a client uses: the one passed, else `console.error` (stderr, as
 * in the other SDKs, so stdout stays free for a program's own output) when
 * `KEENABLE_LOG=debug`, else none.
 */
export function resolveLogger(logger: KeenableLogger | undefined): KeenableLogger | undefined {
  if (logger !== undefined) return logger;
  if (!debugEnabled(readEnv("KEENABLE_LOG"))) return undefined;
  return { debug: (message: string) => console.error(message) };
}

function loggableId(id: string | null): string | null {
  if (!id || id.length > MAX_REQUEST_ID || !PRINTABLE.test(id)) return null;
  return id;
}

/** One attempt's debug line. */
export function attemptLine(log: AttemptLog): string {
  const parts = [`method=${log.method}`, `path=${log.path}`, `attempt=${log.attempt}`];
  parts.push(log.status !== null ? `status=${log.status}` : `error=${log.error}`);
  parts.push(`elapsed_ms=${Math.trunc(log.elapsedMs)}`);
  parts.push(`retry=${log.retry}`);
  if (log.retry && log.waitMs !== null) parts.push(`wait_ms=${Math.trunc(log.waitMs)}`);
  const id = loggableId(log.requestId);
  if (id !== null) parts.push(`request_id=${id}`);
  return `keenable: ${parts.join(" ")}`;
}
