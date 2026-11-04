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
  /** Search mode. `"pro"` (the default) does deeper retrieval. */
  mode?: "pro";
  /**
   * Restrict results to one domain, e.g. `"arxiv.org"`. For several domains
   * use `includeDomains`; the API rejects the two together.
   */
  site?: string;
  /**
   * Only return results from these domains (an allow-list).
   *
   * Each entry is a domain (`"un.org"`, which also matches its subdomains), a
   * domain with a path prefix (`"un.org/en/ga"`, matched on whole path
   * segments), or a suffix (`".gov"`, `"*.gov"`, `".gov.uk"`). Up to 200
   * entries across both lists. A narrow list can return fewer than
   * `maxResults`.
   *
   * Sent as given, including `[]`: the API validates entries and answers an
   * empty list or a malformed entry with HTTP 400, which surfaces as a
   * `KeenableAPIError` naming the field, the entry and the reason.
   *
   * ```ts
   * await keenable.search("security council resolution on sudan", {
   *   includeDomains: ["press.un.org", "undocs.org", "documents.un.org"],
   * });
   * ```
   */
  includeDomains?: readonly string[];
  /**
   * Never return results from these domains (a block-list). Same entry forms
   * as `includeDomains`. With both set, a result must match the allow-list and
   * miss the block-list; the same entry in both lists is a 400. `[]` means no
   * block-list.
   */
  excludeDomains?: readonly string[];
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
