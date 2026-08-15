/** Types returned by, and accepted by, the Keenable API. */

/** A single web page returned by `search()`. */
export interface SearchResult {
  title: string;
  url: string;
  /**
   * Page text extracted for this query. This is the field to put in a prompt:
   * it carries the actual content, unlike `description`.
   */
  snippet: string;
  /** The page's meta description. Often absent; prefer `snippet`. */
  description?: string;
  /** ISO-8601 timestamp of publication, when the page exposes one. */
  publishedAt?: string;
  /** ISO-8601 timestamp of when Keenable indexed the page. */
  acquiredAt?: string;
  /** The unmodified JSON object, so new API fields stay reachable. */
  raw: Record<string, unknown>;
}

/** A web page fetched by `fetch()`, extracted as markdown. */
export interface Page {
  url: string;
  title: string;
  /** The page's main content as markdown, with boilerplate stripped. */
  content: string;
  description?: string;
  author?: string;
  publishedAt?: string;
  raw: Record<string, unknown>;
}

/** Optional filters for `search()`. */
export interface SearchOptions {
  /** Search mode. `"pro"` (the default) does deeper retrieval. */
  mode?: "pro";
  /** Restrict results to one domain, e.g. `"arxiv.org"`. */
  site?: string;
  /** Only pages published on or after this date (`YYYY-MM-DD`). */
  publishedAfter?: string;
  /** Only pages published on or before this date (`YYYY-MM-DD`). */
  publishedBefore?: string;
  /** Only pages Keenable indexed on or after this date (`YYYY-MM-DD`). */
  acquiredAfter?: string;
  /** Only pages Keenable indexed on or before this date (`YYYY-MM-DD`). */
  acquiredBefore?: string;
  /** Cap the characters of page text returned per result. */
  snippetMaxLength?: number;
  /** Abort the request from your own controller. */
  signal?: AbortSignal;
}

/** Options for rendering results into a prompt block. */
export interface ToContextOptions {
  /** Approximate character budget for the whole block. Default 12000. */
  maxChars?: number;
  /** Keep at most this many results before the budget is applied. */
  maxResults?: number;
  /** Append the publication date to each header. Default true. */
  includeDates?: boolean;
}

/** Configuration for a `Keenable` client. */
export interface KeenableOptions {
  /**
   * API key. Falls back to `KEENABLE_API_KEY`. Optional: without one the
   * client uses the keyless public endpoints, which are rate limited.
   */
  apiKey?: string;
  /** API base URL. Falls back to `KEENABLE_API_URL`. */
  baseUrl?: string;
  /** Request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Custom fetch implementation (for tests or a proxy). */
  fetch?: typeof globalThis.fetch;
}
