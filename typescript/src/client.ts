import {
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableInsufficientCreditsError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
  KeenableTargetError,
} from "./errors.js";
import type { KeenableAPIErrorDetails, RateLimitInfo } from "./errors.js";
import { SEARCH_FILTERS } from "./filters.js";
import { cleanContextText, collapse, nonEmpty, normalizeHost, readEnv } from "./internal.js";
import type {
  KeenableOptions,
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
const DEFAULT_TIMEOUT_MS = 90_000;

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
    return false;
  }
  // IPv6 loopback, unique-local (fc00::/7) and link-local (fe80::/10).
  if (host === "::" || host === "::1") return true;
  return /^f[cd]|^fe[89ab]/i.test(host);
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
  readonly raw: Record<string, unknown>;

  constructor(init: {
    query: string;
    mode?: string;
    results: SearchResult[];
    raw: Record<string, unknown>;
  }) {
    this.query = init.query;
    this.mode = init.mode;
    this.results = init.results;
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
  readonly raw: Record<string, unknown>;

  constructor(init: {
    url: string;
    title: string;
    content: string;
    description?: string;
    author?: string;
    publishedAt?: string;
    raw: Record<string, unknown>;
  }) {
    this.url = init.url;
    this.title = init.title;
    this.content = init.content;
    this.description = init.description;
    this.author = init.author;
    this.publishedAt = init.publishedAt;
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

function toPage(data: Record<string, unknown>, url: string): Page {
  return new Page({
    url: String(data.url ?? url),
    title: String(data.title ?? ""),
    content: String(data.content ?? ""),
    description: nonEmpty(data.description),
    author: nonEmpty(data.author),
    publishedAt: nonEmpty(data.published_at),
    raw: data,
  });
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
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: KeenableOptions = {}) {
    this.apiKey = nonEmpty(options.apiKey ?? readEnv("KEENABLE_API_KEY"))?.trim();
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.clientSource = options.clientSource ?? "Keenable SDK";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `keenable-typescript/${VERSION}`,
      // The public tier rejects requests without this header.
      "X-Keenable-Title": this.clientSource,
    };
    if (this.apiKey !== undefined) headers["X-API-Key"] = this.apiKey;
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

    const payload: Record<string, unknown> = { query };
    if (options.mode || !options.orgDefaultMode) payload.mode = options.mode ?? "pro";
    for (const filter of SEARCH_FILTERS) {
      const value = (options as Record<string, unknown>)[filter.option];
      if (value !== undefined) payload[filter.wire] = value;
    }

    const data = await this.request("search", {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: options.signal,
    });

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
      raw: data,
    });
  }

  /**
   * Fetch one URL and return its main content as markdown.
   *
   * Use this after `search()` when a snippet is not enough and the model needs
   * the full page.
   */
  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<Page> {
    rejectPrivateFetchTarget(url);

    const target = new URL(this.url("fetch"));
    target.searchParams.set("url", url);

    const data = await this.request(
      "fetch",
      { method: "GET", headers: this.headers(), signal: options.signal },
      target.toString(),
    );
    return toPage(data, url);
  }

  /**
   * Send one request and return its decoded body.
   *
   * Every transport concern lives here: timeout, abort wiring, error
   * translation and decoding, so a retry or a logging hook is one edit.
   */
  private async request(
    endpoint: Endpoint,
    init: RequestInit,
    url: string = this.url(endpoint),
  ): Promise<Record<string, unknown>> {
    const { signal: callerSignal, ...rest } = init;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onAbort);

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, { ...rest, signal: controller.signal });
      // fetch() resolves on headers. The body can still take arbitrarily long,
      // so the deadline and the caller's signal must stay armed until it is read.
      text = await response.text();
    } catch (cause) {
      if (callerSignal?.aborted) throw cause;
      if (controller.signal.aborted) {
        throw new KeenableConnectionError(
          `the Keenable API did not respond within ${this.timeoutMs} ms`,
        );
      }
      throw new KeenableConnectionError(
        `could not reach the Keenable API: ${String(cause)}`,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }

    if (!response.ok) {
      throw toApiError(response.status, text, response.headers, endpoint === "fetch");
    }

    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new KeenableAPIError(
        `Keenable API returned a non-JSON response: ${JSON.stringify(text.slice(0, 200))}`,
        response.status,
      );
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new KeenableAPIError(
        `unexpected response from the Keenable API: ${JSON.stringify(data)}`,
        response.status,
      );
    }
    return data as Record<string, unknown>;
  }
}

// Codes for a page that failed, besides every code starting with "target_".
const TARGET_CODES = new Set(["page_not_found", "content_not_extracted"]);

// Codes the API fills in by status when nothing more specific applies. They say
// no more than a missing code, so the title and message fallbacks still run.
const GENERIC_CODES = new Set(["forbidden", "not_found", "unprocessable"]);

// The API's title for a 403 from the fetched site, before it sent codes.
const UPSTREAM_FORBIDDEN = "upstream forbidden";

// In the API's message for a code-less 403 on a private or internal URL.
const PRIVATE_HOST_MARKER = "private/internal";

const TARGET_403_ADVICE =
  "The site refused the fetch. This is not about your API key, and retrying " +
  "the same URL will not help: fetch another source.";

const TARGET_ADVICE =
  "The page could not be fetched. Retrying the same URL will not help: " +
  "check the URL or fetch another source.";

const PRIVATE_URL_ADVICE =
  "The URL points to a private or internal address, which the fetcher never " +
  "reaches. This is not about your API key: use a public http or https URL.";

/**
 * True when the page being fetched failed, not the caller's request. A
 * response without a code falls back to the status: a 403 "Upstream
 * forbidden" from any endpoint, and a 404 or 422 from fetch, which the API
 * sends only when the page is missing or has no readable text. That fallback
 * needs the API's JSON error object: a plain-text or HTML 404 comes from a
 * proxy or a wrong base URL, not from the page.
 */
function isTargetError(
  status: number,
  code: string | undefined,
  title: string | undefined,
  fetch: boolean,
  apiBody: boolean,
): boolean {
  if (status === 429) return false;
  if (code !== undefined && !GENERIC_CODES.has(code)) {
    return code.startsWith("target_") || TARGET_CODES.has(code);
  }
  if (status === 403 && (title ?? "").trim().toLowerCase() === UPSTREAM_FORBIDDEN) return true;
  return fetch && apiBody && (status === 404 || status === 422);
}

/** True when a 403 refused the URL for pointing to a private address. */
function isPrivateUrlError(status: number, code: string | undefined, detail: string): boolean {
  if (code !== undefined && !GENERIC_CODES.has(code)) return code === "private_url_not_allowed";
  return status === 403 && detail.toLowerCase().includes(PRIVATE_HOST_MARKER);
}

/** The next step when the API sent no fix, or undefined when there is none. */
function defaultAdvice(
  status: number,
  retryable: boolean | undefined,
  target: boolean,
  privateUrl: boolean,
): string | undefined {
  if (privateUrl) return PRIVATE_URL_ADVICE;
  if (retryable === true || !target || status >= 500) return undefined;
  return status === 403 ? TARGET_403_ADVICE : TARGET_ADVICE;
}

function toApiError(
  status: number,
  text: string,
  headers?: Headers,
  fetch = false,
): KeenableAPIError {
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

  const apiRecord = Array.isArray(record) ? undefined : record;
  const details = errorDetails(apiRecord, headers);
  const target = isTargetError(status, details.code, details.error, fetch, apiRecord !== undefined);
  const privateUrl = isPrivateUrlError(status, details.code, detail);
  const auth = (status === 401 || status === 403) && !target && !privateUrl;
  const label =
    (status === 401 || status === 403) && !auth
      ? `Keenable API error (${status})`
      : (STATUS_LABELS[status] ?? `Keenable API error (${status})`);
  let message = detail ? `${label}: ${detail}` : label;
  // The API's next step, appended the same way in the Go and Python SDKs.
  const advice = details.fix ?? defaultAdvice(status, details.retryable, target, privateUrl);
  if (advice) message = `${message}. ${advice}`;

  if (target) {
    return new KeenableTargetError(message, status, detail || undefined, details);
  }
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

/** A non-negative, finite number of seconds, or undefined for anything else. */
function seconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The longest Retry-After delay reported, in seconds (a year). */
const MAX_RETRY_AFTER = 365 * 24 * 60 * 60;

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
 * the `X-Request-Id` header.
 */
function errorDetails(
  body: Record<string, unknown> | undefined,
  headers: Headers | undefined,
): KeenableAPIErrorDetails {
  const b = body ?? {};
  return {
    code: nonEmpty(b.code),
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
