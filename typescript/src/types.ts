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
 * Per-call transport settings, accepted by `search()` and `fetch()`. Each one
 * overrides the client's setting for this call only.
 */
export interface RequestOptions {
  /** Abort the request from your own controller. Aborting also stops a pending retry. */
  signal?: AbortSignal;
  /** Deadline in milliseconds for each attempt, headers and body. */
  timeoutMs?: number;
  /** How many times to retry a failed attempt. `0` turns retries off. */
  maxRetries?: number;
  /** Extra headers for this call, sent over the client's `defaultHeaders`. */
  headers?: Record<string, string>;
}

/**
 * Optional filters for `search()`.
 *
 * The filter names here pair with the wire names in `filters.ts`; add a filter
 * in both places and every consumer picks it up.
 */
export interface SearchOptions extends RequestOptions {
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
  /** How many results to return, 1 to 50. The API default is 10. */
  maxResults?: number;
  /**
   * Search the index as it stood at this moment; pages newer than it are
   * excluded. It sets no lower bound, so it is not a recency filter: use
   * `publishedAfter` for that. Accepts an ISO 8601 datetime, `YYYY-MM-DD`, or
   * an offset back from now such as `"7d"` (as of 7 days ago).
   */
  queryTime?: string;
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
  /**
   * Deadline in milliseconds for each attempt, headers and body. Default 30000.
   * A timed-out attempt throws `KeenableTimeoutError` once retries run out.
   */
  timeoutMs?: number;
  /**
   * How many times to retry a failed request. Default 2; `0` turns retries off.
   *
   * Connection errors, timeouts, 408, 429 and 5xx are retried, unless the API
   * says the error is not retryable (its `retryable` field decides when sent).
   * The wait is the API's `Retry-After` when it sent one, else exponential
   * backoff from 0.5 s up to 8 s with jitter. A `Retry-After` longer than 60 s
   * (such as the keyless hourly cap) is not waited out: the error is thrown
   * at once so you can decide.
   */
  maxRetries?: number;
  /** Headers sent with every request, e.g. for a proxy or gateway. */
  defaultHeaders?: Record<string, string>;
  /** Custom fetch implementation (for tests or a proxy). */
  fetch?: typeof globalThis.fetch;
}
