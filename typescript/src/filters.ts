/**
 * The search filter set, declared once.
 *
 * Three consumers read this table: the client builds its request payload from
 * it, the tool schema generates its `properties` from the tool-exposed rows,
 * and the tool dispatcher uses those same rows as its allow-list. Adding a
 * filter is one row here plus the field on `SearchOptions`, instead of an edit
 * in every consumer that can silently fall out of step.
 */

export interface Filter {
  /** Wire name, as the API expects it. */
  readonly wire: string;
  /** Field name on `SearchOptions`. */
  readonly option: string;
  /** Shown to the model when the filter is exposed as a tool parameter. */
  readonly description: string;
  readonly jsonType?: "string" | "integer" | "array";
  /**
   * Whether a model may set this filter through the search tool. The subset is
   * deliberately small: a model choosing between six date and length knobs
   * picks worse than one choosing between two.
   */
  readonly toolExposed?: boolean;
}

export const SEARCH_FILTERS: readonly Filter[] = [
  {
    wire: "site",
    option: "site",
    description:
      "Optional. Restrict results to one domain, e.g. 'arxiv.org'. " +
      "For several domains use include_domains.",
    toolExposed: true,
  },
  {
    wire: "include_domains",
    option: "includeDomains",
    description:
      "Optional. Only return results from these hosts, e.g. 'un.org', which also " +
      "matches its subdomains. Hosts only: paths and suffixes like '.gov' are rejected. " +
      "Up to 50. Do not combine with site.",
    jsonType: "array",
    toolExposed: true,
  },
  {
    wire: "exclude_domains",
    option: "excludeDomains",
    description:
      "Optional. Never return results from these hosts, up to 200. Same host " +
      "form as include_domains; a host in both lists is an error.",
    jsonType: "array",
    toolExposed: true,
  },
  {
    wire: "published_after",
    option: "publishedAfter",
    description:
      "Optional. Only pages published on or after this date (YYYY-MM-DD).",
    toolExposed: true,
  },
  {
    wire: "published_before",
    option: "publishedBefore",
    description:
      "Optional. Only pages published on or before this date (YYYY-MM-DD).",
  },
  {
    wire: "acquired_after",
    option: "acquiredAfter",
    description: "Optional. Only pages indexed on or after this date (YYYY-MM-DD).",
  },
  {
    wire: "acquired_before",
    option: "acquiredBefore",
    description: "Optional. Only pages indexed on or before this date (YYYY-MM-DD).",
  },
  {
    wire: "snippet_max_length",
    option: "snippetMaxLength",
    description: "Optional. Cap the characters of page text returned per result.",
    jsonType: "integer",
  },
  {
    wire: "max_results",
    option: "maxResults",
    description: "Optional. How many results to return, 1 to 50. The API default is 10.",
    jsonType: "integer",
  },
  {
    wire: "query_time",
    option: "queryTime",
    description:
      "Optional. Search the index as it stood at this moment: pages newer than it are " +
      "excluded. Not a recency filter (use published_after for that). An ISO 8601 " +
      "datetime, YYYY-MM-DD, or an offset back from now such as '7d'.",
  },
];

export const TOOL_FILTERS: readonly Filter[] = SEARCH_FILTERS.filter(
  (f) => f.toolExposed,
);

/** The JSON-schema `properties` entries for the tool-exposed filters. */
export function toolProperties(): Record<string, unknown> {
  return Object.fromEntries(
    TOOL_FILTERS.map((f) => [
      f.wire,
      f.jsonType === "array"
        ? { type: "array", items: { type: "string" }, description: f.description }
        : { type: f.jsonType ?? "string", description: f.description },
    ]),
  );
}
