/**
 * Verify the webhooks Keenable Monitors send (Standard Webhooks).
 *
 * ```ts
 * const event = await verifyWebhook(rawBody, request.headers, process.env.KEENABLE_WEBHOOK_SECRET!);
 * if (event.type === "monitor.hit") console.log(event.data.result?.url);
 * ```
 */

import { WebhookVerificationError } from "./errors.js";
import { toMonitor, toMonitorResult, toMonitorRun } from "./monitors.js";
import type { Monitor, MonitorResult, MonitorRun } from "./monitors.js";

/** How far, in seconds, a delivery's timestamp may be from now by default. */
export const DEFAULT_WEBHOOK_TOLERANCE_SECONDS = 300;

export interface WebhookEventData {
  monitorId: string;
  /** On monitor.created, updated, deleted and disabled. */
  monitor?: Monitor;
  /** On monitor.run.created, completed and failed. */
  run?: MonitorRun;
  /** On monitor.hit and monitor.update. */
  result?: MonitorResult;
  /** Why, on monitor.disabled. */
  reason?: string;
  raw: Record<string, unknown>;
}

export interface WebhookEvent {
  /** The delivery's id, the same across retries: use it to drop repeats. */
  id: string;
  type: string;
  createdAt: string;
  data: WebhookEventData;
  /** The monitor's metadata. */
  metadata: Record<string, string> | null;
  raw: Record<string, unknown>;
}

export interface VerifyWebhookOptions {
  /** How far, in seconds, the timestamp may be from now. Default 300. */
  toleranceSeconds?: number;
  /** The current time in Unix seconds; tests pin it. Defaults to the clock. */
  now?: number;
}

/** Request headers as a `Headers` object, a plain record (Node's `IncomingHttpHeaders`) or a `Map`. */
export type WebhookHeaders =
  | Headers
  | Map<string, string>
  | Record<string, string | string[] | undefined>;

type Subtle = {
  importKey(
    format: "raw",
    key: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: false,
    usages: ["sign"],
  ): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
};

async function subtle(): Promise<Subtle> {
  const global = (globalThis as { crypto?: { subtle?: Subtle } }).crypto?.subtle;
  if (global) return global;
  const nodeCrypto = (await import("node:crypto")) as unknown as { webcrypto: { subtle: Subtle } };
  return nodeCrypto.webcrypto.subtle;
}

function header(headers: WebhookHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") {
    const value = (headers as Headers | Map<string, string>).get(name);
    if (typeof value === "string") return value;
    if (headers instanceof Map) {
      for (const [key, v] of headers) if (key.toLowerCase() === name) return v;
    }
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    if (Array.isArray(value) && typeof value[0] === "string") return value.join(" ");
  }
  return undefined;
}

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    value = (value << 6) | ALPHABET.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    const n = (a << 16) | (b << 8) | c;
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? ALPHABET[(n >> 6) & 63]! : "=";
    out += i + 2 < bytes.length ? ALPHABET[n & 63]! : "=";
  }
  return out;
}

const MAX_STAMP_DIGITS = 12;

function secretKey(secret: string): Uint8Array {
  const text = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  const key = text.length > 0 && BASE64.test(text) ? fromBase64(text) : new TextEncoder().encode(text);
  if (key.length === 0) {
    throw new WebhookVerificationError("the webhook secret has no key after whsec_: pass the monitor's webhook.secret");
  }
  return key;
}

function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toEvent(raw: Record<string, unknown>): WebhookEvent {
  const inner = isObject(raw.data) ? raw.data : {};
  const data: WebhookEventData = {
    monitorId: typeof inner.monitor_id === "string" ? inner.monitor_id : "",
    raw: inner,
  };
  if (isObject(inner.monitor)) data.monitor = toMonitor(inner.monitor);
  if (isObject(inner.run)) data.run = toMonitorRun(inner.run);
  if (isObject(inner.result)) data.result = toMonitorResult(inner.result);
  if (typeof inner.reason === "string") data.reason = inner.reason;
  let metadata: Record<string, string> | null = null;
  if (isObject(raw.metadata)) {
    metadata = {};
    for (const [k, v] of Object.entries(raw.metadata)) if (typeof v === "string") metadata[k] = v;
  }
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    type: typeof raw.type === "string" ? raw.type : "",
    createdAt: typeof raw.created_at === "string" ? raw.created_at : "",
    data,
    metadata,
    raw,
  };
}

/**
 * Check a webhook delivery's signature and return the event it carries.
 *
 * Pass the body exactly as received (a string or bytes), before any JSON
 * parsing: re-encoding changes the bytes and breaks the signature. Throws
 * `WebhookVerificationError` when the delivery is not authentic or not fresh.
 */
export async function verifyWebhook(
  payload: string | Uint8Array | ArrayBuffer,
  headers: WebhookHeaders,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent> {
  if (typeof secret !== "string" || secret.trim() === "") {
    throw new WebhookVerificationError("the webhook secret is empty: pass the monitor's webhook.secret");
  }
  const tolerance = options.toleranceSeconds ?? DEFAULT_WEBHOOK_TOLERANCE_SECONDS;
  if (typeof tolerance !== "number" || !Number.isFinite(tolerance) || !(tolerance > 0)) {
    throw new WebhookVerificationError("toleranceSeconds must be a positive, finite number");
  }
  const body =
    typeof payload === "string"
      ? new TextEncoder().encode(payload)
      : payload instanceof Uint8Array
        ? payload
        : new Uint8Array(payload);
  const id = header(headers, "webhook-id");
  const stamp = header(headers, "webhook-timestamp")?.trim();
  const signatures = header(headers, "webhook-signature");
  if (!id || !stamp || !signatures) {
    throw new WebhookVerificationError("missing webhook-id, webhook-timestamp or webhook-signature header");
  }
  if (!/^[0-9]+$/.test(stamp) || stamp.length > MAX_STAMP_DIGITS) {
    throw new WebhookVerificationError(`webhook-timestamp is not a Unix time: ${JSON.stringify(stamp)}`);
  }
  const now = options.now ?? Date.now() / 1000;
  if (!Number.isFinite(now) || Math.abs(now - Number(stamp)) > tolerance) {
    throw new WebhookVerificationError(
      "webhook-timestamp is too far from now: the delivery is stale or the clock is off",
    );
  }
  const prefix = new TextEncoder().encode(`${id}.${stamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix);
  signed.set(body, prefix.length);
  const crypto = await subtle();
  const key = await crypto.importKey("raw", secretKey(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const expected = toBase64(new Uint8Array(await crypto.sign("HMAC", key, signed)));
  let matched = false;
  for (const candidate of signatures.split(/\s+/)) {
    const comma = candidate.indexOf(",");
    if (comma < 0) continue;
    if (candidate.slice(0, comma) === "v1" && sameText(candidate.slice(comma + 1), expected)) matched = true;
  }
  if (!matched) {
    throw new WebhookVerificationError("no webhook-signature matches: check the secret and verify the raw body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new WebhookVerificationError("the signed body is not JSON");
  }
  if (!isObject(parsed)) throw new WebhookVerificationError("the signed body is not a JSON object");
  return toEvent(parsed);
}
