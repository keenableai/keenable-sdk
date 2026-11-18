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
  readonly jsonType?: "string" | "integer" | "array" | "boolean";
  /**
   * Whether a model may set this filter through the search tool. The subset is
   * kept small: a model picks better from fewer knobs.
   */
  readonly toolExposed?: boolean;
}

export const SEARCH_FILTERS: readonly Filter[] = [
  {
    wire: "site",
    option: "site",
    description:
      "Optional. Deprecated, removed on 2027-02-15: use include_domains. " +
      "Restrict results to one domain, e.g. 'arxiv.org'.",
    toolExposed: true,
  },
  {
    wire: "include_domains",
    option: "includeDomains",
    description:
      "Optional. Return results only from these hosts or their subdomains, " +
      "e.g. 'arxiv.org'. Hosts only, no paths. A public suffix written with " +
      "a leading dot or '*.', such as '.gov' or '*.edu', covers every host " +
      "under it; other wildcards are rejected. Up to 50.",
    jsonType: "array",
    toolExposed: true,
  },
  {
    wire: "exclude_domains",
    option: "excludeDomains",
    description:
      "Optional. Never return results from these hosts or their subdomains, " +
      "e.g. 'pinterest.com'. Hosts only, no paths or wildcards. Up to 1,000.",
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
  {
    wire: "objective",
    option: "objective",
    description:
      "Optional. Two or three natural sentences, with no field labels and no line breaks, that cover: the exact facts, entities, numbers, dates or names a useful page must contain; task context the query does not state (who, where, when, eligibility, date window); which kinds of sources count or must be excluded; what is already established from earlier steps; and what is still unknown. Every sentence must be self-contained: name the entities, places, dates and figures explicitly, and never refer to 'the task', 'the clue', 'the question', 'above' or earlier results. Do not paste the conversation, and do not include personal, confidential or sensitive information. At most 1,000 characters.",
    toolExposed: true,
  },
  {
    wire: "disable_cards",
    option: "disableCards",
    description:
      "Optional. true returns ordinary web pages in place of Keenable's cards " +
      "(results Keenable writes for prices, exchange rates or company facts, " +
      "whose URLs expire after one day). Default false.",
    jsonType: "boolean",
    toolExposed: true,
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
