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
  DEFAULT_CONTEXT_MAX_SNIPPET_CHARS,
  Keenable,
  Page,
  SearchResponse,
} from "./client.js";
export {
  KeenableAPIError,
  KeenableAuthError,
  KeenableConnectionError,
  KeenableCreditsError,
  KeenableError,
  KeenableInsufficientCreditsError,
  KeenableInvalidRequestError,
  KeenableRateLimitError,
  KeenableTimeoutError,
  WebhookVerificationError,
} from "./errors.js";
export type { KeenableAPIErrorDetails, KeenableErrorType, RateLimitInfo } from "./errors.js";
export { FETCH_TOOL, SEARCH_TOOL, TOOLS, runToolCall } from "./tools.js";
export type { ToolDefinition } from "./tools.js";
export type {
  Balance,
  KeenableOptions,
  FetchOptions,
  Money,
  Plan,
  Price,
  PriceList,
  RequestOptions,
  SearchOptions,
  SearchResult,
  ToContextOptions,
  Usage,
} from "./types.js";
export { Monitors } from "./monitors.js";
export type {
  BulkAction,
  BulkFilter,
  BulkResult,
  DeliveryList,
  ListPage,
  Monitor,
  MonitorBulkParams,
  MonitorCreateCommonParams,
  MonitorCreateParams,
  MonitorDelivery,
  MonitorDiff,
  MonitorDisabledReason,
  MonitorEvent,
  MonitorList,
  MonitorListParams,
  MonitorPageParams,
  MonitorPageSensitivity,
  MonitorPageTarget,
  MonitorPageCreateParams,
  MonitorPageTargetParams,
  MonitorResult,
  MonitorResultsParams,
  MonitorResultChange,
  MonitorRun,
  MonitorRunChanges,
  MonitorRunOutput,
  MonitorRunOutputError,
  MonitorRunStatus,
  MonitorSchedule,
  MonitorScheduleParams,
  MonitorSearch,
  MonitorSearchCreateParams,
  MonitorSearchParams,
  MonitorStats,
  MonitorStatus,
  MonitorType,
  MonitorUpdateParams,
  MonitorVersion,
  MonitorVersionsParams,
  MonitorWebhook,
  MonitorWebhookParams,
  ResultList,
  RunList,
  VersionList,
} from "./monitors.js";
export { DEFAULT_WEBHOOK_TOLERANCE_SECONDS, verifyWebhook } from "./webhooks.js";
export type {
  VerifyWebhookOptions,
  WebhookEvent,
  WebhookEventData,
  WebhookHeaders,
} from "./webhooks.js";
