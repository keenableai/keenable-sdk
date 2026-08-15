import {
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
} from "./errors.js";
import type {
  KeenableOptions,
  Page,
  SearchOptions,
  SearchResult,
  ToContextOptions,
} from "./types.js";

const VERSION = "0.1.0";
export const DEFAULT_BASE_URL = "https://api.keenable.ai";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CONTEXT_MAX_CHARS = 12_000;

// Keyless endpoints. A key is not a prerequisite for any call: it only lifts
// the hourly rate limit, so the client picks the endpoint by key presence.
const SEARCH_PUBLIC = "/v1/search/public";
const SEARCH_KEYED = "/v1/search";
const FETCH_PUBLIC = "/v1/fetch/public";
const FETCH_KEYED = "/v1/fetch";

/** Hosts that must never be fetched, whatever the backend would do. */
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

function readEnv(name: string): string | undefined {
  // Guarded so the SDK also loads in browser-like runtimes with no `process`.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return env?.[name];
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

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
  const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
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

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
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
   * Render the results as a numbered, citable block for a prompt.
   *
   * Each result becomes a `[n] title (url)` header followed by its page text,
   * which lets the model cite sources by number. Results are added whole until
   * the budget is reached, so a trimmed context never ends mid-sentence.
   */
  toContext(options: ToContextOptions = {}): string {
    const maxChars = options.maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;
    const includeDates = options.includeDates ?? true;
    const selected =
      options.maxResults === undefined
        ? this.results
        : this.results.slice(0, options.maxResults);

    const blocks: string[] = [];
    let used = 0;

    selected.forEach((result, index) => {
      let header = `[${index + 1}] ${result.title} (${result.url})`;
      if (includeDates && result.publishedAt) {
        header += ` - published ${result.publishedAt}`;
      }
      const block = `${header}\n${result.snippet || result.description || ""}`.trim();

      // +2 for the blank line between blocks. Stop rather than truncate: a
      // half-sentence source reads as corrupted context to the model.
      const cost = block.length + (blocks.length > 0 ? 2 : 0);
      if (blocks.length > 0 && used + cost > maxChars) return;
      blocks.push(block);
      used += cost;
    });

    return blocks.join("\n\n");
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
  return {
    url: String(data.url ?? url),
    title: String(data.title ?? ""),
    content: String(data.content ?? ""),
    description: nonEmpty(data.description),
    author: nonEmpty(data.author),
    publishedAt: nonEmpty(data.published_at),
    raw: data,
  };
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
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: KeenableOptions = {}) {
    this.apiKey = nonEmpty(options.apiKey ?? readEnv("KEENABLE_API_KEY"))?.trim();
    this.baseUrl = resolveBaseUrl(options.baseUrl);
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
      "User-Agent": `keenable-typescript/${VERSION}`,
      // The public tier rejects requests without this header.
      "X-Keenable-Title": "Keenable SDK (TypeScript)",
    };
    if (this.apiKey !== undefined) headers["X-API-Key"] = this.apiKey;
    return headers;
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
    const optional: Array<[string, unknown]> = [
      ["site", options.site],
      ["published_after", options.publishedAfter],
      ["published_before", options.publishedBefore],
      ["acquired_after", options.acquiredAfter],
      ["acquired_before", options.acquiredBefore],
      ["snippet_max_length", options.snippetMaxLength],
    ];
    for (const [name, value] of optional) {
      if (value !== undefined) payload[name] = value;
    }

    const path = this.keyless ? SEARCH_PUBLIC : SEARCH_KEYED;
    const data = await this.request(
      `${this.baseUrl}${path}`,
      {
        method: "POST",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      },
      options.signal,
    );

    const rawResults = Array.isArray(data.results) ? data.results : [];
    return new SearchResponse({
      query: nonEmpty(data.query) ?? query,
      mode: nonEmpty(data.mode),
      results: rawResults
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
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

    const path = this.keyless ? FETCH_PUBLIC : FETCH_KEYED;
    const target = new URL(`${this.baseUrl}${path}`);
    target.searchParams.set("url", url);

    const data = await this.request(
      target.toString(),
      { method: "GET", headers: this.headers() },
      options.signal,
    );
    return toPage(data, url);
  }

  private async request(
    url: string,
    init: RequestInit,
    signal?: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort);

    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (cause) {
      if (signal?.aborted) throw cause;
      throw new KeenableConnectionError(
        `could not reach the Keenable API: ${String(cause)}`,
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
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
        nonEmpty(record.message) ?? nonEmpty(record.error) ?? nonEmpty(record.detail) ?? "";
    }
  } catch {
    // Not JSON; the raw body is the best detail we have.
  }

  const labels: Record<number, string> = {
    401: "Keenable authentication failed (401)",
    403: "Keenable authentication failed (403)",
    402: "Keenable: insufficient credits (402)",
    429: "Keenable rate limit exceeded (429)",
  };
  const label = labels[status] ?? `Keenable API error (${status})`;
  const message = detail ? `${label}: ${detail}` : label;

  if (status === 401 || status === 403) {
    return new KeenableAuthError(message, status, detail || undefined);
  }
  if (status === 429) {
    return new KeenableRateLimitError(message, status, detail || undefined);
  }
  return new KeenableAPIError(message, status, detail || undefined);
}
