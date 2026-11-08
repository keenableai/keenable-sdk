import {
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableInsufficientCreditsError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
  KeenableTimeoutError,
} from "./errors.js";
import type { KeenableAPIErrorDetails, KeenableErrorType, RateLimitInfo } from "./errors.js";
import { SEARCH_FILTERS } from "./filters.js";
import { cleanContextText, collapse, nonEmpty, normalizeHost, readEnv } from "./internal.js";
import type {
  KeenableOptions,
  RequestOptions,
  SearchOptions,
  SearchResult,
  ToContextOptions,
} from "./types.js";

// Replaced at build time with the version from package.json, so a release
// cannot ship a User-Agent that disagrees with the published package.
declare const __VERSION__: string;
const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

export const DEFAULT_BASE_URL = "https://api.keenable.ai";
export const DEFAULT_CONTEXT_MAX_CHARS = 12_000;
const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;

// Retry timing, the same in the Python and Go SDKs.
const INITIAL_RETRY_DELAY_MS = 500;
const MAX_RETRY_DELAY_MS = 8_000;
/** A server-requested wait longer than this is not waited out. */
const MAX_RETRY_AFTER_WAIT_SECONDS = 60;

// Endpoints are named once; the keyless variant of each is the same path with a
// `/public` suffix, so a new endpoint is one name rather than two constants.
type Endpoint = "search" | "fetch";

/** Hosts that must never be fetched, whatever the backend would do. */
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const STATUS_LABELS: Record<number, string> = {
  401: "Keenable authentication failed (401)",
  403: "Keenable authentication failed (403)",
  402: "Keenable: insufficient credits (402)",
  429: "Keenable rate limit exceeded (429)",
};

function resolveBaseUrl(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? readEnv("KEENABLE_API_URL") ?? DEFAULT_BASE_URL).replace(
    /\/+$/,
    "",
  );
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new KeenableInvalidRequestError(
      `baseUrl must be an absolute https:// URL, got ${JSON.stringify(raw)}`,
    );
  }
  const isLocal = LOCAL_HOSTS.has(normalizeHost(parsed));
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocal)) {
    return raw;
  }
  throw new KeenableInvalidRequestError(
    `baseUrl must use https, got ${JSON.stringify(raw)}`,
  );
}

/**
 * Refuse obviously internal fetch targets before a request leaves the process.
 *
 * The backend enforces this too; stopping here keeps an internal hostname out
 * of an outbound request in the first place.
 */
function rejectPrivateFetchTarget(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new KeenableInvalidRequestError(
      `fetch() needs an absolute URL, got ${JSON.stringify(url)}`,
    );
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new KeenableInvalidRequestError(
      `fetch() needs an http(s) URL, got ${JSON.stringify(url)}`,
    );
  }

  const host = normalizeHost(parsed);
  if (BLOCKED_HOSTS.has(host)) {
    throw new KeenableInvalidRequestError(
      `refusing to fetch internal host ${JSON.stringify(host)}`,
    );
  }
  if (isPrivateAddress(host)) {
    throw new KeenableInvalidRequestError(
      `refusing to fetch private address ${JSON.stringify(host)}`,
    );
  }
}

/**
 * The IPv4 address embedded in an IPv4-mapped IPv6 host, if there is one.
 *
 * `::ffff:127.0.0.1` reaches the same machine as `127.0.0.1`, so it has to be
 * classified as that address. Note the hex form: `new URL()` rewrites the
 * dotted tail into two 16-bit groups (`::ffff:7f00:1`), so a check that only
 * knows the dotted spelling never fires on a real URL.
 */
function mappedIPv4(host: string): string | undefined {
  const dotted = /^(?:0*:)*ffff:((?:\d{1,3}\.){3}\d{1,3})$/i.exec(host);
  if (dotted?.[1]) return dotted[1];

  const hex = /^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(host);
  if (!hex?.[1] || !hex[2]) return undefined;
  const high = parseInt(hex[1], 16);
  const low = parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isPrivateAddress(host: string): boolean {
  const candidate = mappedIPv4(host) ?? host;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(candidate);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
    if (a >= 224) return true; // multicast, reserved and broadcast
    return false;
  }
  // Only an IPv6 literal from here on: a hostname such as fdic.gov or
  // fcbarcelona.com starts with the same letters as fc00::/7 and must not match.
  if (!host.includes(":")) return false;
  // Loopback and unspecified.
  if (/^(?:0*:)*:?0*1?$/.test(host)) return true;
  // Unique-local (fc00::/7), link-local (fe80::/10), multicast (ff00::/8).
  // The first group has all four digits: `fc::1` is 00fc::1, a public address.
  return /^(?:f[cd][0-9a-f]{2}|fe[89ab][0-9a-f]|ff[0-9a-f]{2}):/i.test(host);
}

function sourceHeader(index: number, title: string, url: string, date?: string): string {
  const header = `[${index}] ${title} (${url})`;
  return date ? `${header} - published ${date}` : header;
}

/** The text rendered under a search result's header, as budgeted. */
function resultBody(result: SearchResult): string {
  return collapse(cleanContextText(result.snippet || result.description || "", result.url));
}

/** One rendered source: its header line, then its text. */
function contextBlock(header: string, body: string): string {
  return body ? `${header}\n${body}` : header;
}

/** The result set for one `search()` call. */
export class SearchResponse {
  readonly query: string;
  readonly mode?: string;
  readonly results: SearchResult[];
  /** The API's id for this request. Quote it when reporting a problem. */
  readonly requestId?: string;
  readonly raw: Record<string, unknown>;

  constructor(init: {
    query: string;
    mode?: string;
    results: SearchResult[];
    requestId?: string;
    raw: Record<string, unknown>;
  }) {
    this.query = init.query;
    this.mode = init.mode;
    this.results = init.results;
    this.requestId = init.requestId;
    this.raw = init.raw;
  }

  [Symbol.iterator](): Iterator<SearchResult> {
    return this.results[Symbol.iterator]();
  }

  get length(): number {
    return this.results.length;
  }

  /**
   * The results `toContext()` would render, in citation order.
   *
   * Use this to print a source list that matches the citations in a model's
   * answer: index 0 here is the source the model cites as `[1]`. Without it, a
   * caller listing every result would number sources the model never saw once
   * the budget trimmed them.
   */
  cited(options: ToContextOptions = {}): SearchResult[] {
    const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
    const includeDates = options.includeDates ?? true;
    const selected =
      options.maxResults === undefined
        ? this.results
        : this.results.slice(0, options.maxResults);

    const kept: SearchResult[] = [];
    let used = 0;

    for (const [index, result] of selected.entries()) {
      const header = sourceHeader(
        index + 1,
        result.title,
        result.url,
        includeDates ? result.publishedAt : undefined,
      );
      const body = resultBody(result);
      // Measure before building: past the budget the block is discarded, and
      // each discarded snippet would be kilobytes of throwaway string.
      const blockLength = header.length + (body ? body.length + 1 : 0);
      const cost = blockLength + (kept.length > 0 ? 2 : 0); // +2 for the blank line
      if (kept.length > 0 && used + cost > maxChars) break;
      kept.push(result);
      used += cost;
    }

    return kept;
  }

  /**
   * Render the results as a numbered, citable block for a prompt.
   *
   * Each result becomes a `[n] title (url)` header followed by its page text,
   * which lets the model cite sources by number. Results are added whole until
   * the budget is reached, so a trimmed context never ends mid-sentence.
   * Snippets are cleaned first (images dropped, relative links resolved),
   * and the budget counts the cleaned text; `snippet` itself is left
   * untouched.
   */
  toContext(options: ToContextOptions = {}): string {
    const includeDates = options.includeDates ?? true;
    return this.cited(options)
      .map((result, index) =>
        contextBlock(
          sourceHeader(
            index + 1,
            result.title,
            result.url,
            includeDates ? result.publishedAt : undefined,
          ),
          resultBody(result),
        ),
      )
      .join("\n\n");
  }
}

/** A web page fetched by `fetch()`, extracted as markdown. */
export class Page {
  readonly url: string;
  readonly title: string;
  /** The page's main content as markdown, with boilerplate stripped. */
  readonly content: string;
  /**
   * @deprecated Always empty: the API no longer fills it. Read `content`.
   * Kept for compatibility; see https://docs.keenable.ai/versioning.
   */
  readonly description?: string;
  readonly author?: string;
  readonly publishedAt?: string;
  /** The API's id for this request. Quote it when reporting a problem. */
  readonly requestId?: string;
  readonly raw: Record<string, unknown>;

  constructor(init: {
    url: string;
    title: string;
    content: string;
    description?: string;
    author?: string;
    publishedAt?: string;
    requestId?: string;
    raw: Record<string, unknown>;
  }) {
    this.url = init.url;
    this.title = init.title;
    this.content = init.content;
    this.description = init.description;
    this.author = init.author;
    this.publishedAt = init.publishedAt;
    this.requestId = init.requestId;
    this.raw = init.raw;
  }

  /**
   * Render the page as a citable block for a prompt.
   *
   * Same shape as `SearchResponse.toContext()`, so a model can cite a fetched
   * page the way it cites a search result instead of receiving anonymous
   * markdown. Unlike search results the content is one document, so an
   * oversized page is cut at the budget rather than dropped. The content is
   * cleaned the same way before the cut; `content` itself is left untouched.
   */
  toContext(options: { maxChars?: number } = {}): string {
    const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
    const header = sourceHeader(1, this.title, this.url, this.publishedAt);
    const budget = maxChars - header.length - 1;
    if (budget <= 0) return header;
    const content = cleanContextText(this.content, this.url);
    return contextBlock(header, content.slice(0, budget).trimEnd());
  }
}

function toSearchResult(data: Record<string, unknown>): SearchResult {
  return {
    title: String(data.title ?? ""),
    url: String(data.url ?? ""),
    snippet: String(data.snippet ?? ""),
    description: nonEmpty(data.description),
    publishedAt: nonEmpty(data.published_at),
    acquiredAt: nonEmpty(data.acquired_at),
    raw: data,
  };
}

function toPage(data: Record<string, unknown>, url: string, requestId?: string): Page {
  return new Page({
    url: String(data.url ?? url),
    title: String(data.title ?? ""),
    content: String(data.content ?? ""),
    description: nonEmpty(data.description),
    author: nonEmpty(data.author),
    publishedAt: nonEmpty(data.published_at),
    requestId,
    raw: data,
  });
}

/** Wait `ms`, or reject with the signal's reason as soon as it aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The exponential backoff before retry number `retry` (0 for the first):
 * 0.5 s doubling up to 8 s, shortened by up to 25% of jitter so clients that
 * failed together do not retry together. Kept in step with Python and Go.
 */
export function backoffMs(retry: number, random: number = Math.random()): number {
  const base = Math.min(INITIAL_RETRY_DELAY_MS * 2 ** retry, MAX_RETRY_DELAY_MS);
  return base * (1 - 0.25 * random);
}

/** A redirect this SDK refused to follow; retrying would refuse it again. */
class KeenableRedirectError extends KeenableConnectionError {}

/**
 * How long to wait before retrying after `error`, or undefined when it should
 * not be retried. The API's `retryable` decides when it sent one; otherwise
 * 408, 429 and 5xx are retried, and so are network failures and timeouts. A
 * `Retry-After` over a minute is not waited out.
 */
export function retryDelayMs(error: unknown, retry: number): number | undefined {
  if (error instanceof KeenableAPIError) {
    const status = error.statusCode;
    const retryable = error.retryable ?? (status === 408 || status === 429 || status >= 500);
    if (!retryable) return undefined;
    if (error.retryAfterSeconds !== undefined) {
      return error.retryAfterSeconds <= MAX_RETRY_AFTER_WAIT_SECONDS
        ? error.retryAfterSeconds * 1000
        : undefined;
    }
    return backoffMs(retry);
  }
  if (error instanceof KeenableRedirectError) return undefined;
  if (error instanceof KeenableConnectionError) return backoffMs(retry);
  return undefined;
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new KeenableInvalidRequestError(
      `${name} must be a non-negative integer, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

function positiveTimeout(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new KeenableInvalidRequestError(
      `${name} must be a positive number of milliseconds, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * Client for the Keenable web search API.
 *
 * Keyless by default: with no API key it calls the public endpoints, which are
 * rate limited per hour. Pass `apiKey` (or set `KEENABLE_API_KEY`) to lift that
 * limit. Create a key at https://keenable.ai/console.
 *
 * ```ts
 * const keenable = new Keenable();
 * const results = await keenable.search("cerebras inference benchmarks");
 * console.log(results.toContext());
 * ```
 */
export class Keenable {
  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly clientSource: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly defaultHeaders: Record<string, string>;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: KeenableOptions = {}) {
    this.apiKey = nonEmpty(options.apiKey ?? readEnv("KEENABLE_API_KEY"))?.trim();
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.clientSource = options.clientSource ?? "Keenable SDK";
    this.timeoutMs = positiveTimeout("timeoutMs", options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    this.maxRetries = nonNegativeInteger("maxRetries", options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.defaultHeaders = { ...options.defaultHeaders };
    const fetchImpl = options.fetch ?? globalThis.fetch;
    if (typeof fetchImpl !== "function") {
      throw new KeenableInvalidRequestError(
        "no global fetch available; pass one via the `fetch` option (Node 18+ has it built in)",
      );
    }
    this.fetchImpl = fetchImpl;
  }

  /** True when no API key is configured and the public tier is in use. */
  get keyless(): boolean {
    return this.apiKey === undefined;
  }

  /**
   * The headers for one request: the SDK's own, then `defaultHeaders`, then
   * the call's `headers`. The API key is always the configured one, so a
   * stray header cannot send a different key or turn a keyless call keyed.
   */
  private headers(
    extra: Record<string, string> | undefined,
    json: boolean,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `keenable-typescript/${VERSION}`,
      // The public tier rejects requests without this header.
      "X-Keenable-Title": this.clientSource,
    };
    // Header names are case-insensitive: a caller's "user-agent" replaces ours.
    const set = (name: string, value: string) => {
      for (const existing of Object.keys(headers)) {
        if (existing.toLowerCase() === name.toLowerCase()) delete headers[existing];
      }
      headers[name] = value;
    };
    for (const source of [this.defaultHeaders, extra ?? {}]) {
      for (const [name, value] of Object.entries(source)) {
        if (name.toLowerCase() !== "x-api-key") set(name, value);
      }
    }
    if (this.apiKey !== undefined) set("X-API-Key", this.apiKey);
    if (json) set("Content-Type", "application/json");
    return headers;
  }

  /** The endpoint URL, keyless or keyed depending on the configured key. */
  private url(endpoint: Endpoint): string {
    return `${this.baseUrl}/v1/${endpoint}${this.keyless ? "/public" : ""}`;
  }

  /**
   * Search the web and return ranked results with page text.
   *
   * Describe the ideal page in natural language ("blog post comparing React
   * and Vue performance") rather than typing keywords; the index is semantic.
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
    if (typeof query !== "string" || query.trim() === "") {
      throw new KeenableInvalidRequestError("search() needs a non-empty query");
    }

    const payload: Record<string, unknown> = {
      query,
      mode: options.mode ?? "pro",
    };
    for (const filter of SEARCH_FILTERS) {
      const value = (options as Record<string, unknown>)[filter.option];
      if (value !== undefined) payload[filter.wire] = value;
    }

    const { data, requestId } = await this.request(
      "search",
      { method: "POST", body: JSON.stringify(payload) },
      options,
    );

    const rawResults = Array.isArray(data.results) ? data.results : [];
    return new SearchResponse({
      query: nonEmpty(data.query) ?? query,
      mode: nonEmpty(data.mode),
      results: rawResults
        .filter(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null,
        )
        .map(toSearchResult),
      requestId,
      raw: data,
    });
  }

  /**
   * Fetch one URL and return its main content as markdown.
   *
   * Use this after `search()` when a snippet is not enough and the model needs
   * the full page.
   */
  async fetch(url: string, options: RequestOptions = {}): Promise<Page> {
    rejectPrivateFetchTarget(url);

    const target = new URL(this.url("fetch"));
    target.searchParams.set("url", url);

    const { data, requestId } = await this.request(
      "fetch",
      { method: "GET" },
      options,
      target.toString(),
    );
    return toPage(data, url, requestId);
  }

  /**
   * Send a request, retrying what can be retried, and return the decoded body
   * with the request id.
   *
   * Every transport concern lives here: headers, timeout, abort wiring,
   * retries, error translation and decoding.
   */
  private async request(
    endpoint: Endpoint,
    init: { method: "GET" | "POST"; body?: string },
    options: RequestOptions,
    url: string = this.url(endpoint),
  ): Promise<{ data: Record<string, unknown>; requestId?: string }> {
    const timeoutMs =
      options.timeoutMs === undefined
        ? this.timeoutMs
        : positiveTimeout("timeoutMs", options.timeoutMs);
    const maxRetries =
      options.maxRetries === undefined
        ? this.maxRetries
        : nonNegativeInteger("maxRetries", options.maxRetries);
    const headers = this.headers(options.headers, init.body !== undefined);

    for (let retry = 0; ; retry += 1) {
      try {
        return await this.attempt(url, { ...init, headers }, timeoutMs, options.signal);
      } catch (error) {
        const delay = retry < maxRetries ? retryDelayMs(error, retry) : undefined;
        if (delay === undefined) throw error;
        await sleep(delay, options.signal);
      }
    }
  }

  /** One attempt: send, read the body under the deadline, decode. */
  private async attempt(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<{ data: Record<string, unknown>; requestId?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onAbort);
    if (callerSignal?.aborted) controller.abort();

    let response: Response;
    let text: string;
    try {
      // Redirects are not followed: fetch would carry X-API-Key to whatever
      // host the redirect names.
      response = await this.fetchImpl(url, {
        ...init,
        redirect: "manual",
        signal: controller.signal,
      });
      // fetch() resolves on headers. The body can still take arbitrarily long,
      // so the deadline and the caller's signal must stay armed until it is read.
      text = await response.text();
    } catch (cause) {
      if (callerSignal?.aborted) throw callerSignal.reason ?? cause;
      if (controller.signal.aborted) {
        throw new KeenableTimeoutError(
          `the Keenable API did not respond within ${timeoutMs} ms`,
        );
      }
      throw new KeenableConnectionError(
        `could not reach the Keenable API: ${String(cause)}`,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }

    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      const location = response.headers.get("Location");
      throw new KeenableRedirectError(
        `the Keenable API redirected${location ? ` to ${location}` : ""}. The redirect was not followed, so the API key was not sent. Check KEENABLE_API_URL.`,
      );
    }
    if (!response.ok) throw toApiError(response.status, text, response.headers);

    const requestId = nonEmpty(response.headers.get("X-Request-Id")?.trim());
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new KeenableAPIError(
        `Keenable API returned a non-JSON response: ${JSON.stringify(text.slice(0, 200))}`,
        response.status,
        undefined,
        { requestId },
      );
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new KeenableAPIError(
        `unexpected response from the Keenable API: ${JSON.stringify(data)}`,
        response.status,
        undefined,
        { requestId },
      );
    }
    const record = data as Record<string, unknown>;
    return { data: record, requestId: nonEmpty(record.request_id) ?? requestId };
  }
}

// Codes about the page being fetched rather than about Keenable or the caller,
// besides every `target_*` code. Servers before error format v1 send no `type`,
// so it is derived from these and the status.
const TARGET_CODES = new Set(["page_not_found", "content_not_extracted"]);

/**
 * The error `type` for a response that did not send one. Matches the API's
 * catalog for every code it had when `type` was added.
 */
function deriveType(status: number, code: string | undefined): KeenableErrorType {
  if (code && (code.startsWith("target_") || TARGET_CODES.has(code))) return "target_error";
  if (status === 401) return "authentication_error";
  if (status === 403) return "permission_error";
  if (status === 402 || status === 451) return "billing_error";
  if (status === 429) return "rate_limit_error";
  if (status >= 400 && status < 500) return "invalid_request_error";
  return "api_error";
}

/** Append `more` as a new sentence, without doubling a final period. */
function sentence(message: string, more: string): string {
  return `${message}${message.endsWith(".") ? " " : ". "}${more}`;
}

function toApiError(status: number, text: string, headers?: Headers): KeenableAPIError {
  let detail = text.trim();
  let record: Record<string, unknown> | undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      record = body as Record<string, unknown>;
      detail =
        nonEmpty(record.message) ??
        nonEmpty(record.error) ??
        nonEmpty(record.detail) ??
        "";
    }
  } catch {
    // Not JSON; the raw body is the best detail we have.
  }

  const details = errorDetails(status, Array.isArray(record) ? undefined : record, headers);
  // A 401/403 about the page being fetched is not an authentication failure.
  const auth = (status === 401 || status === 403) && details.type !== "target_error";
  const label =
    (status === 401 || status === 403) && !auth
      ? `Keenable API error (${status})`
      : (STATUS_LABELS[status] ?? `Keenable API error (${status})`);
  let message = detail ? `${label}: ${detail}` : label;
  // The API's next step, appended the same way in the Go and Python SDKs.
  if (details.fix) message = sentence(message, details.fix);
  // Where to read more and what to quote, as Stripe's SDKs print them; the same
  // tail as the Go and Python SDKs. The code goes in its own parentheses so the
  // "(request_id: ...)" Go has shipped reads the same everywhere.
  if (details.docsUrl) message = sentence(message, `Docs: ${details.docsUrl}`);
  if (details.code) message = `${message} (code: ${details.code})`;
  if (details.requestId) message = `${message} (request_id: ${details.requestId})`;

  if (auth) {
    return new KeenableAuthError(message, status, detail || undefined, details);
  }
  if (status === 402) {
    return new KeenableInsufficientCreditsError(message, status, detail || undefined, details);
  }
  if (status === 429) {
    return new KeenableRateLimitError(message, status, detail || undefined, details);
  }
  return new KeenableAPIError(message, status, detail || undefined, details);
}

/** The longest Retry-After delay reported, in seconds (a year). */
const MAX_RETRY_AFTER = 365 * 24 * 60 * 60;

/**
 * A non-negative, finite number of seconds capped at a year, or undefined for
 * anything else. JSON too large for a double (1e400) parses as Infinity and is
 * dropped, as the Go and Python SDKs drop it.
 */
function seconds(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, MAX_RETRY_AFTER);
}

/** Parse a Retry-After header: delay-seconds or an HTTP date. */
function retryAfterHeader(value: string | null | undefined): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^[0-9]+$/.test(text)) {
    // Cap at a year, as the Go SDK does, so a huge value never becomes
    // Infinity.
    return Math.min(Number(text), MAX_RETRY_AFTER);
  }
  const when = Date.parse(text);
  if (Number.isNaN(when)) return undefined;
  return Math.min(Math.max(0, Math.ceil((when - Date.now()) / 1000)), MAX_RETRY_AFTER);
}

function rateLimitInfo(value: unknown): RateLimitInfo | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const limit = value as Record<string, unknown>;
  return {
    scope: nonEmpty(limit.scope),
    window: nonEmpty(limit.window),
    max: Number.isInteger(limit.max) ? (limit.max as number) : undefined,
    resetsAt: nonEmpty(limit.resets_at),
  };
}

/**
 * The agent-ready fields of an error body, undefined where the API left one
 * out. `retryAfterSeconds` prefers the body, then the `Retry-After` header,
 * then the older `retryAfter` body field; `requestId` prefers the body, then
 * the `X-Request-Id` header; `type` is derived from the status and code when
 * the API did not send it.
 */
function errorDetails(
  status: number,
  body: Record<string, unknown> | undefined,
  headers: Headers | undefined,
): KeenableAPIErrorDetails {
  const b = body ?? {};
  const code = nonEmpty(b.code);
  return {
    code,
    type: nonEmpty(b.type) ?? deriveType(status, code),
    error: nonEmpty(b.error),
    fix: nonEmpty(b.fix),
    docsUrl: nonEmpty(b.docs_url),
    retryable: typeof b.retryable === "boolean" ? b.retryable : undefined,
    retryAfterSeconds:
      seconds(b.retry_after_seconds) ??
      retryAfterHeader(headers?.get("Retry-After")) ??
      seconds(b.retryAfter),
    requestId: nonEmpty(b.request_id) ?? nonEmpty(headers?.get("X-Request-Id")?.trim()),
    param: nonEmpty(b.param),
    limit: rateLimitInfo(b.limit),
    billingUrl: nonEmpty(b.billing_url),
    autoTopUpUrl: nonEmpty(b.auto_top_up_url),
    payPerRequest: nonEmpty(b.pay_per_request),
    raw: body,
  };
}
