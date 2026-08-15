import {
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
} from "./errors.js";
import { SEARCH_FILTERS } from "./filters.js";
import { collapse, nonEmpty, normalizeHost, readEnv } from "./internal.js";
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
const DEFAULT_TIMEOUT_MS = 30_000;

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

function isPrivateAddress(host: string): boolean {
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
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
      const body = collapse(result.snippet || result.description || "");
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
          collapse(result.snippet || result.description || ""),
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
   * oversized page is cut at the budget rather than dropped.
   */
  toContext(options: { maxChars?: number } = {}): string {
    const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
    const header = sourceHeader(1, this.title, this.url, this.publishedAt);
    const budget = maxChars - header.length - 1;
    if (budget <= 0) return header;
    return contextBlock(header, this.content.slice(0, budget).trimEnd());
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

    const payload: Record<string, unknown> = {
      query,
      mode: options.mode ?? "pro",
    };
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
    try {
      response = await this.fetchImpl(url, { ...rest, signal: controller.signal });
    } catch (cause) {
      if (callerSignal?.aborted) throw cause;
      throw new KeenableConnectionError(
        `could not reach the Keenable API: ${String(cause)}`,
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onAbort);
    }

    const text = await response.text();
    if (!response.ok) throw toApiError(response.status, text);

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

function toApiError(status: number, text: string): KeenableAPIError {
  let detail = text.trim();
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null) {
      const record = body as Record<string, unknown>;
      detail =
        nonEmpty(record.message) ??
        nonEmpty(record.error) ??
        nonEmpty(record.detail) ??
        "";
    }
  } catch {
    // Not JSON; the raw body is the best detail we have.
  }

  const label = STATUS_LABELS[status] ?? `Keenable API error (${status})`;
  const message = detail ? `${label}: ${detail}` : label;

  if (status === 401 || status === 403) {
    return new KeenableAuthError(message, status, detail || undefined);
  }
  if (status === 429) {
    return new KeenableRateLimitError(message, status, detail || undefined);
  }
  return new KeenableAPIError(message, status, detail || undefined);
}
