/**
 * Keenable: web search and page fetch for AI agents.
 *
 * Keyless by default. `new Keenable()` works with no account; an API key only
 * lifts the hourly rate limit.
 *
 * ```ts
 * import { Keenable } from "keenable";
 *
 * const keenable = new Keenable();
 * const results = await keenable.search("fastest inference providers 2026");
 * console.log(results.toContext());
 * ```
 */

export {
  DEFAULT_BASE_URL,
  DEFAULT_CONTEXT_MAX_CHARS,
  Keenable,
  Page,
  SearchResponse,
} from "./client.js";
export {
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
} from "./errors.js";
export { FETCH_TOOL, SEARCH_TOOL, TOOLS, runToolCall } from "./tools.js";
export type { ToolDefinition } from "./tools.js";
export type {
  KeenableOptions,
  SearchOptions,
  SearchResult,
  ToContextOptions,
} from "./types.js";
