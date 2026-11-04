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
  /**
   * @deprecated Always empty: the API no longer fills it. Read `snippet`.
   * Kept for compatibility; see https://docs.keenable.ai/versioning.
   */
  description?: string;
  /** ISO-8601 timestamp of publication, when the page exposes one. */
  publishedAt?: string;
  /** ISO-8601 timestamp of when Keenable indexed the page. */
  acquiredAt?: string;
  /** The unmodified JSON object, so new API fields stay reachable. */
  raw: Record<string, unknown>;
}

/**
 * Optional filters for `search()`.
 *
 * The filter names here pair with the wire names in `filters.ts`; add a filter
 * in both places and every consumer picks it up.
 */
export interface SearchOptions {
  /**
   * `"pro"` (the default) does deeper retrieval; `"realtime"` is the fastest,
   * for latency-sensitive calls. Other strings are passed through, so a mode
   * the API adds later works before this SDK names it.
   */
  mode?: SearchMode;
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
  /** How many results to return, 1 to 50. The API default is 10. */
  maxResults?: number;
  /**
   * Search the index as it stood at this moment; pages newer than it are
   * excluded. It sets no lower bound, so it is not a recency filter: use
   * `publishedAfter` for that. Accepts an ISO 8601 datetime, `YYYY-MM-DD`, or
   * an offset back from now such as `"7d"` (as of 7 days ago).
   */
  queryTime?: string;
  /**
   * Experimental structured-data extraction. Only valid in `"pro"` mode, and
   * not under a zero data retention policy.
   */
  enableWizards?: boolean;
  /**
   * An id for the agent session making this call. Send the same value on every
   * call in one session so its requests can be grouped.
   */
  sessionId?: string;
  /** Abort the request from your own controller. */
  signal?: AbortSignal;
}

/** A search mode: `"pro"`, `"realtime"`, or any mode the API adds later. */
// `string & {}` keeps editor autocomplete for the two named modes while still
// accepting any string.
export type SearchMode = "pro" | "realtime" | (string & {});

/** Optional arguments for `fetch()`. */
export interface FetchOptions {
  /**
   * Cap the content at this many characters (the API default is 50,000). A
   * cut page ends with a short note saying it was truncated.
   */
  maxChars?: number;
  /**
   * Fetch from the source when the page is not in the index. Without it, an
   * unindexed URL fails.
   */
  live?: boolean;
  /**
   * Instead of the full page, return the answer to this instruction,
   * extracted from the page by a model.
   */
  prompt?: string;
  /** Same as `SearchOptions.sessionId`. */
  sessionId?: string;
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
  /**
   * Name this client reports as its traffic source. Leave it alone unless you
   * are building an integration on top of this SDK and want your own
   * attribution.
   */
  clientSource?: string;
  /** Deadline in milliseconds for the whole request, headers and body. Default 30000. */
  timeoutMs?: number;
  /** Custom fetch implementation (for tests or a proxy). */
  fetch?: typeof globalThis.fetch;
}
