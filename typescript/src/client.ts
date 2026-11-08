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
import {
  bool,
  capSnippet,
  cleanContextText,
  collapse,
  count,
  nonEmpty,
  normalizeHost,
  readEnv,
  timestamp,
} from "./internal.js";
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
/**
 * Default per-result cap for `SearchResponse.toContext()`. Search snippets are
 * often whole pages (4,000 to 13,000 characters); without a cap the first one
 * or two results eat the budget and crowd out every other source.
 */
export const DEFAULT_CONTEXT_MAX_SNIPPET_CHARS = 2_000;
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

/** The host as written in a URL, before a WHATWG parser rewrites it. */
function writtenHost(raw: string): string {
  const authority = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  const host = authority.slice(authority.lastIndexOf("@") + 1);
  const port = host.startsWith("[") ? host.indexOf("]") + 1 : host.lastIndexOf(":");
  const bare = (port > 0 ? host.slice(0, port) : host)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return trimTrailing(bare, ".");
}

/** `text` without any trailing `char`s, in linear time (a /x+$/ regex is polynomial). */
function trimTrailing(text: string, char: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === char) end--;
  return text.slice(0, end);
}

function resolveBaseUrl(baseUrl: string | undefined): string {
  // A blank KEENABLE_API_URL is unset, as in Python and Go.
  const env = nonEmpty(readEnv("KEENABLE_API_URL"));
  const raw = trimTrailing((baseUrl ?? env ?? DEFAULT_BASE_URL).trim(), "/");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new KeenableInvalidRequestError(
      `baseUrl must be an absolute https:// URL, got ${JSON.stringify(raw)}`,
    );
  }
  // The endpoint path is appended to the base URL, so a query or fragment
  // would swallow it.
  if (raw.includes("?") || raw.includes("#")) {
    throw new KeenableInvalidRequestError(
      `baseUrl must be an https:// URL with a host and no query or fragment, got ${JSON.stringify(raw)}`,
    );
  }
  // The host as written: the URL parser would read 127.1 as 127.0.0.1, which
  // Python and Go do not accept for plain http.
  const isLocal = LOCAL_HOSTS.has(writtenHost(raw));
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
 * of an outbound request in the first place. The rules are the same in the
 * Python and Go SDKs: see scripts/conformance/README.md.
 */
function rejectPrivateFetchTarget(url: unknown): void {
  if (typeof url !== "string") {
    throw new KeenableInvalidRequestError(
      `fetch() needs a URL string, got ${typeof url}`,
    );
  }
  // WHATWG parsers delete tabs and newlines and trim spaces, which other
  // parsers do not, so the two would read different hosts.
  if (/[\x00-\x1f\x7f]/.test(url) || url.startsWith(" ") || url.endsWith(" ")) {
    throw new KeenableInvalidRequestError(
      `fetch() URL has a control character or surrounding space: ${JSON.stringify(url)}`,
    );
  }
  // Exactly "scheme://": WHATWG reads https:host, https:/host and
  // https:///host as https://host/, other parsers see no host.
  const scheme = /^(https?):\/\/([^/?#]*)/i.exec(url);
  if (!scheme) {
    throw new KeenableInvalidRequestError(
      `fetch() needs an http(s) URL, got ${JSON.stringify(url)}`,
    );
  }
  // WHATWG reads a backslash as a slash and RFC 3986 parsers do not, so
  // https://127.0.0.1\@example.com has two different hosts.
  if (scheme[2]?.includes("\\")) {
    throw new KeenableInvalidRequestError(
      `fetch() URL has a backslash in its host: ${JSON.stringify(url)}`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new KeenableInvalidRequestError(
      `fetch() needs an absolute URL, got ${JSON.stringify(url)}`,
    );
  }

  const host = normalizeHost(parsed);
  if (!scheme[2] || !host) {
    throw new KeenableInvalidRequestError(`fetch() URL has no host: ${JSON.stringify(url)}`);
  }
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".localhost")) {
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

/** IPv4 ranges fetch() refuses, as [first address, prefix length]. */
const BLOCKED_IPV4: [number, number][] = (
  [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const
).map(([address, bits]) => [ipv4Number(address) ?? 0, bits]);

/** A dotted-decimal IPv4 address as an unsigned 32-bit number. */
function ipv4Number(host: string): number | undefined {
  const parts = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!parts) return undefined;
  let value = 0;
  for (const part of parts.slice(1)) {
    const n = Number(part);
    if (n > 255) return undefined;
    value = value * 256 + n;
  }
  return value;
}

function isBlockedIPv4(value: number): boolean {
  return BLOCKED_IPV4.some(([first, bits]) => {
    const size = 2 ** (32 - bits);
    return value >= first && value < first + size;
  });
}

/**
 * An IPv6 literal as eight 16-bit groups, or undefined if it is not one. The
 * host comes from `new URL()`, which has already validated it and rewritten a
 * dotted IPv4 tail (`::ffff:1.2.3.4`) as two hex groups (`::ffff:102:304`).
 */
function parseIPv6(host: string): number[] | undefined {
  const halves = host.split("::");
  if (halves.length > 2) return undefined;
  const groups = (part: string | undefined): number[] | undefined => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = groups(halves[0]);
  const tail = groups(halves[1]);
  if (!head || !tail) return undefined;
  const known = head.length + tail.length;
  if (halves.length === 1) return known === 8 ? head : undefined;
  if (known > 7) return undefined;
  return [...head, ...new Array<number>(8 - known).fill(0), ...tail];
}

/**
 * Whether an IPv6 address is outside what fetch() may reach: an IPv4-mapped
 * address is judged by its IPv4 address; anything else must be global unicast
 * (2000::/3) outside the special blocks inside it.
 */
function isBlockedIPv6(g: number[]): boolean {
  const [g0 = 0, g1 = 0, , , , g5 = 0, g6 = 0, g7 = 0] = g;
  if (g.slice(0, 5).every((n) => n === 0) && g5 === 0xffff) {
    return isBlockedIPv4(g6 * 65536 + g7);
  }
  if ((g0 & 0xe000) !== 0x2000) return true; // outside 2000::/3
  if (g0 === 0x2001 && (g1 & 0xfe00) === 0) return true; // 2001::/23
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32
  if (g0 === 0x2002) return true; // 6to4, 2002::/16
  if (g0 === 0x3fff && (g1 & 0xf000) === 0) return true; // 3fff::/20
  return false;
}

function isPrivateAddress(host: string): boolean {
  const v4 = ipv4Number(host);
  if (v4 !== undefined) return isBlockedIPv4(v4);
  // Only an IPv6 literal from here on: a hostname such as fdic.gov or
  // fcbarcelona.com starts with the same letters as fc00::/7 and must not match.
  if (!host.includes(":")) return false;
  const groups = parseIPv6(host);
  // A host with a colon that is not an address does not survive URL parsing.
  return groups === undefined || isBlockedIPv6(groups);
}

function sourceHeader(index: number, title: string, url: string, date?: string): string {
  const header = `[${index}] ${title} (${url})`;
  return date ? `${header} - published ${date}` : header;
}

/** The text rendered under a search result's header, as budgeted. */
function resultBody(result: SearchResult, maxSnippetChars: number | null): string {
  return capSnippet(
    collapse(cleanContextText(result.snippet || result.description || "", result.url)),
    maxSnippetChars,
  );
}

/** The per-result cap `toContext()` applies: `null` means none. */
function snippetCap(options: ToContextOptions): number | null {
  return options.maxSnippetChars === undefined
    ? DEFAULT_CONTEXT_MAX_SNIPPET_CHARS
    : options.maxSnippetChars;
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
   * the budget trimmed them. Takes the same options as `toContext()`.
   */
  cited(options: ToContextOptions = {}): SearchResult[] {
    const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
    const includeDates = options.includeDates ?? true;
    const maxSnippetChars = snippetCap(options);
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
      const body = resultBody(result, maxSnippetChars);
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
   * which lets the model cite sources by number. Snippets are cleaned first
   * (images dropped, relative links resolved, tables flattened), then each is
   * cut to `maxSnippetChars` at a word boundary and ends in "…". Results are
   * then added whole until `maxChars` is reached, and the budget counts the
   * cleaned, capped text; `snippet` itself is left untouched. The first result
   * is always kept, even if it alone exceeds `maxChars`.
   */
  toContext(options: ToContextOptions = {}): string {
    const includeDates = options.includeDates ?? true;
    const maxSnippetChars = snippetCap(options);
    return this.cited(options)
      .map((result, index) =>
        contextBlock(
          sourceHeader(
            index + 1,
            result.title,
            result.url,
            includeDates ? result.publishedAt : undefined,
          ),
          resultBody(result, maxSnippetChars),
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
  /**
   * When the page was published, as ISO 8601. The API sends Unix seconds for
   * a fetch; they are given in UTC to the second, such as
   * "2024-05-01T12:00:00Z", the form search results use. Undefined when
   * unknown.
   */
  readonly publishedAt?: string;
  /** The API's id for this request. Quote it when reporting a problem. */
  readonly requestId?: string;
  /**
   * True when the page was longer than the API's `max_chars` and `content`
   * was cut (cut content ends with `...`). Undefined when the API did not say.
   */
  readonly truncated?: boolean;
  /**
   * Length of the full extracted content in Unicode code points, before any
   * cut. Undefined when the API did not say.
   */
  readonly totalChars?: number;
  readonly raw: Record<string, unknown>;

  constructor(init: {
    url: string;
    title: string;
    content: string;
    description?: string;
    author?: string;
    publishedAt?: string;
    requestId?: string;
    truncated?: boolean;
    totalChars?: number;
    raw: Record<string, unknown>;
  }) {
    this.url = init.url;
    this.title = init.title;
    this.content = init.content;
    this.description = init.description;
    this.author = init.author;
    this.publishedAt = init.publishedAt;
    this.requestId = init.requestId;
    this.truncated = init.truncated;
    this.totalChars = init.totalChars;
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

/** A required text field: the string sent, or "" for anything else. */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toSearchResult(data: Record<string, unknown>): SearchResult {
  return {
    title: text(data.title),
    url: text(data.url),
    snippet: text(data.snippet),
    description: nonEmpty(data.description),
    publishedAt: timestamp(data.published_at),
    acquiredAt: timestamp(data.acquired_at),
    raw: data,
  };
}

function toPage(data: Record<string, unknown>, url: string, requestId?: string): Page {
  return new Page({
    // An empty url falls back to the one asked for, as in Python and Go.
    url: nonEmpty(data.url) ?? url,
    title: text(data.title),
    content: text(data.content),
    description: nonEmpty(data.description),
    author: nonEmpty(data.author),
    publishedAt: timestamp(data.published_at),
    requestId,
    truncated: bool(data.truncated),
    totalChars: count(data.total_chars),
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

/** An HTTP token: the characters a header name may hold (RFC 9110). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Refuse a header no HTTP stack would send. Left to the transport, it fails
 * as a connection error and is retried, though it can never succeed.
 */
function checkHeaders(name: string, headers: Record<string, string>): Record<string, string> {
  for (const [key, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(key)) {
      throw new KeenableInvalidRequestError(
        `${name} has an invalid header name ${JSON.stringify(key)}`,
      );
    }
    if (/[\r\n\0]/.test(String(value))) {
      throw new KeenableInvalidRequestError(
        `${name} value for ${JSON.stringify(key)} holds CR, LF or NUL`,
      );
    }
  }
  return headers;
}

/** The longest delay a JavaScript timer can wait; a longer one fires at once. */
const MAX_TIMER_MS = 2_147_483_647;

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
    this.defaultHeaders = checkHeaders("defaultHeaders", { ...options.defaultHeaders });
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

    // An empty string is unset, as Go cannot tell the two apart.
    const payload: Record<string, unknown> = {
      query,
      mode: options.mode || "pro",
    };
    for (const filter of SEARCH_FILTERS) {
      const value = (options as Record<string, unknown>)[filter.option];
      if (value !== undefined && value !== "") payload[filter.wire] = value;
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
        .filter(isRecord)
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
    const headers = this.headers(
      checkHeaders("headers", options.headers ?? {}),
      init.body !== undefined,
    );

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
    // An already-aborted call sends nothing, whatever the fetch implementation
    // does with the signal; Go's canceled ctx sends nothing either.
    if (callerSignal?.aborted) throw callerSignal.reason;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, MAX_TIMER_MS));
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

    if (response.redirected) {
      // A custom fetch followed the redirect although the SDK passed
      // redirect: "manual"; the reply came from wherever it led.
      throw new KeenableRedirectError(
        `the Keenable API redirected to ${response.url || "another URL"}, and the fetch function you passed followed it although the SDK asked it not to. The response was discarded. Check KEENABLE_API_URL and the fetch option.`,
      );
    }
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      const location = response.headers.get("Location");
      throw new KeenableRedirectError(
        `the Keenable API redirected${location ? ` to ${location}` : ""}. The redirect was not followed, so the API key was not sent. Check KEENABLE_API_URL.`,
      );
    }
    if (!response.ok) throw toApiError(response.status, text, response.headers);

    const requestId = nonEmpty(response.headers.get("X-Request-Id")?.trim());
    const parsed = parseJson(text);
    if (!parsed) {
      throw new KeenableAPIError(
        `Keenable API returned a non-JSON response: ${JSON.stringify(text.slice(0, 200))}`,
        response.status,
        undefined,
        { requestId },
      );
    }
    const data = parsed.value;
    if (!isRecord(data)) {
      throw new KeenableAPIError(
        `unexpected response from the Keenable API: ${JSON.stringify(data)}`,
        response.status,
        undefined,
        { requestId },
      );
    }
    return { data, requestId: nonEmpty(data.request_id) ?? requestId };
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

/**
 * A response body decoded as strict JSON: `undefined` when it is not JSON.
 * A leading byte order mark is ignored, as Python and Go ignore it.
 */
function parseJson(text: string): { value: unknown } | undefined {
  const body = text.replace(/^﻿/, "");
  if (nestedTooDeeply(body)) return undefined;
  try {
    return { value: JSON.parse(body) };
  } catch {
    return undefined;
  }
}

/** Nesting deeper than this is "not JSON" in all three SDKs (scripts/conformance). */
const MAX_JSON_DEPTH = 512;

/**
 * Whether a JSON-looking body nests arrays/objects deeper than MAX_JSON_DEPTH.
 * Only a body that starts like JSON is walked, and the walk stops at the first
 * level past the limit.
 */
function nestedTooDeeply(text: string): boolean {
  const first = text.trimStart()[0];
  if (first !== "[" && first !== "{") return false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "[" || ch === "{") {
      depth++;
      if (depth > MAX_JSON_DEPTH) return true;
    } else if (ch === "]" || ch === "}") {
      depth--;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A 402's message. The API's own text links to billing and checkout pages, or
 * carries an x402 payment offer, none of which this SDK exposes; so the
 * message is the SDK's own, the same in the Python and Go SDKs.
 */
function paymentMessage(code: string | undefined, body: Record<string, unknown> | undefined): string {
  const payment =
    code?.startsWith("payment_") === true ||
    (body !== undefined && ("accepts" in body || "x402Version" in body));
  return payment
    ? "Keenable: payment required (402). This SDK does not pay per request: set KEENABLE_API_KEY to call the API with a key instead."
    : "Keenable: insufficient credits (402). The organization is out of credits; retrying fails the same way until a human with console access adds more.";
}

function toApiError(status: number, text: string, headers?: Headers): KeenableAPIError {
  let detail = text.trim();
  let record: Record<string, unknown> | undefined;
  const parsed = parseJson(text);
  if (parsed) {
    // JSON that is not an object (a string, number, null or array) carries no
    // detail: its text is not shown, and the error maps by status.
    detail = "";
    if (isRecord(parsed.value)) {
      record = parsed.value;
      detail =
        nonEmpty(record.message) ??
        nonEmpty(record.error) ??
        nonEmpty(record.detail) ??
        "";
    }
  }

  const details = errorDetails(status, record, headers);
  // A 401/403 about the page being fetched is not an authentication failure.
  const auth = (status === 401 || status === 403) && details.type !== "target_error";
  let message: string;
  if (status === 402) {
    message = paymentMessage(details.code, record);
  } else {
    const label =
      (status === 401 || status === 403) && !auth
        ? `Keenable API error (${status})`
        : (STATUS_LABELS[status] ?? `Keenable API error (${status})`);
    message = detail ? `${label}: ${detail}` : label;
    // The API's next step, appended the same way in the Go and Python SDKs.
    if (details.fix) message = sentence(message, details.fix);
  }
  // What to quote, the same tail as the Go and Python SDKs. The code goes in
  // its own parentheses so the "(request_id: ...)" Go has shipped reads the
  // same everywhere.
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

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const LONG_DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

// The three HTTP-date forms of RFC 9110 section 5.6.7. Day and month names may
// be in any case, as Go's http.ParseTime reads them; the zone must be GMT.
const IMF_FIXDATE =
  /^([A-Za-z]{3}), (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const RFC_850 =
  /^([A-Za-z]{6,9}), (\d{2})-([A-Za-z]{3})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
const ASCTIME =
  /^([A-Za-z]{3}) ([A-Za-z]{3}) ( \d|\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/** An HTTP date in milliseconds since the epoch, or undefined. */
function httpDate(text: string): number | undefined {
  let parts: (string | undefined)[];
  let weekdays = DAYS;
  let m = IMF_FIXDATE.exec(text);
  if (m) {
    parts = [m[1], m[2], m[3], m[4], m[5], m[6], m[7]];
  } else if ((m = RFC_850.exec(text))) {
    // RFC 850's two-digit year: 69 to 99 are 19xx, as Go and Python read it.
    const yy = Number(m[4]);
    parts = [m[1], m[2], m[3], String(yy >= 69 ? 1900 + yy : 2000 + yy), m[5], m[6], m[7]];
    weekdays = LONG_DAYS;
  } else if ((m = ASCTIME.exec(text))) {
    parts = [m[1], m[3], m[2], m[7], m[4], m[5], m[6]];
  } else {
    return undefined;
  }
  const [weekday = "", day = "", month = "", year = "", hour = "", minute = "", second = ""] =
    parts.map((p) => p ?? "");
  const monthIndex = MONTHS.indexOf(month.toLowerCase());
  if (!weekdays.includes(weekday.toLowerCase()) || monthIndex < 0) return undefined;
  // asctime pads a one-digit day with a space.
  const [d, y, h, mi, s] = [day.trim(), year, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  // The weekday is not checked against the date, as Go and Python do not.
  const date = new Date(0);
  date.setUTCFullYear(y, monthIndex + 1, 0);
  if (d < 1 || d > date.getUTCDate() || h > 23 || mi > 59 || s > 59) return undefined;
  date.setUTCFullYear(y, monthIndex, d);
  date.setUTCHours(h, mi, s, 0);
  return date.getTime();
}

/**
 * Parse a Retry-After header: delay-seconds, or an HTTP date in one of the
 * three RFC 9110 forms, as seconds from `now` (milliseconds since the epoch),
 * rounded up, at least 0 and capped at a year. Anything else is undefined, so
 * the next source of the delay is used. The same rules as Python and Go: see
 * scripts/conformance/README.md.
 */
export function retryAfterHeader(
  value: string | null | undefined,
  now: number = Date.now(),
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^[0-9]+$/.test(text)) {
    // Cap at a year, as the Go SDK does, so a huge value never becomes
    // Infinity.
    return Math.min(Number(text), MAX_RETRY_AFTER);
  }
  const when = httpDate(text);
  if (when === undefined) return undefined;
  return Math.min(Math.max(0, Math.ceil((when - now) / 1000)), MAX_RETRY_AFTER);
}

function rateLimitInfo(value: unknown): RateLimitInfo | undefined {
  if (!isRecord(value)) return undefined;
  const max = value.max;
  return {
    scope: nonEmpty(value.scope),
    window: nonEmpty(value.window),
    max: Number.isSafeInteger(max) && (max as number) >= 0 ? (max as number) : undefined,
    resetsAt: nonEmpty(value.resets_at),
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
    retryable: typeof b.retryable === "boolean" ? b.retryable : undefined,
    retryAfterSeconds:
      seconds(b.retry_after_seconds) ??
      retryAfterHeader(headers?.get("Retry-After")) ??
      seconds(b.retryAfter),
    requestId: nonEmpty(b.request_id) ?? nonEmpty(headers?.get("X-Request-Id")?.trim()),
    param: nonEmpty(b.param),
    limit: rateLimitInfo(b.limit),
  };
}
