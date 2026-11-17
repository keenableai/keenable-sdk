/**
 * Keenable Monitors: standing searches that report new pages as they appear.
 *
 * ```ts
 * const monitor = await keenable.monitors.create({
 *   search: { query: "new open-weights LLM releases" },
 *   schedule: { type: "cron", value: "0 9 * * 1-5", timezone: "Europe/Paris" },
 * });
 * const pages = await keenable.monitors.pages(monitor.id);
 * ```
 */

import { KeenableInvalidRequestError } from "./errors.js";
import type { RequestOptions } from "./types.js";

export type MonitorStatus = "active" | "paused" | "disabled" | "completed";
export type MonitorRunStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type MonitorEvent =
  | "monitor.created"
  | "monitor.updated"
  | "monitor.deleted"
  | "monitor.run.created"
  | "monitor.run.completed"
  | "monitor.run.failed"
  | "monitor.disabled"
  | "monitor.hit"
  | "monitor.update";
export type BulkAction = "pause" | "resume" | "delete";

/** What a monitor watches for. `query` is required on create. */
export interface MonitorSearchParams {
  /** The topic in plain words, e.g. "new open-weights LLM releases". */
  query: string;
  /** Pages a run returns at most, 1 to 100 (default 10). */
  maxResults?: number;
  /** Only pages on these sites. */
  includeDomains?: string[] | null;
  /** Never pages on these sites. */
  excludeDomains?: string[] | null;
  /** Return each page's text (first 6,000 characters). */
  contentText?: boolean;
}

/** When runs happen. */
export interface MonitorScheduleParams {
  type: "cron" | "interval" | "once";
  /** cron: five fields, at most hourly. interval: 1h to 90d ("6h", "2w"). once: a timestamp or a delay ("2h"); empty means now. */
  value?: string | null;
  /** IANA name, cron only; UTC when unset. */
  timezone?: string | null;
}

/** Where events go. */
export interface MonitorWebhookParams {
  /** A public HTTPS address. */
  url: string;
  /** Default: the monitor.* and monitor.run.* events. Add "monitor.hit" to get each new page as soon as it is found. */
  events?: MonitorEvent[] | null;
}

export interface MonitorCreateParams extends RequestOptions {
  search: MonitorSearchParams;
  /** Up to 200 characters. */
  name?: string;
  /** Without one, runs happen only on `trigger()`. */
  schedule?: MonitorScheduleParams;
  /** JSON Schema of each run's `output.structured`. */
  outputSchema?: Record<string, unknown>;
  webhook?: MonitorWebhookParams;
  /** Your own tags (at most 50), echoed in every webhook. */
  metadata?: Record<string, string>;
  /**
   * Makes a retry safe: the same key with the same body returns the monitor
   * the first call created, for 24 hours. A new key is made for each call
   * when you leave it out.
   */
  idempotencyKey?: string;
}

/** Only the fields you set are sent; `null` removes the schedule, webhook or output schema. */
export interface MonitorUpdateParams extends RequestOptions {
  name?: string | null;
  /** "active" also re-enables a disabled monitor. */
  status?: "active" | "paused";
  /** Merged into the stored search. */
  search?: Partial<MonitorSearchParams>;
  schedule?: MonitorScheduleParams | null;
  outputSchema?: Record<string, unknown> | null;
  /** Merged into the stored webhook. */
  webhook?: Partial<MonitorWebhookParams> | null;
  metadata?: Record<string, string> | null;
}

export interface MonitorListParams extends RequestOptions {
  status?: MonitorStatus;
  /** Part of a name. */
  name?: string;
  /** Only monitors with these metadata values. */
  metadata?: Record<string, string>;
  /** Monitors per page (the API's default is 50). */
  limit?: number;
  /** The previous page's `nextCursor`. */
  cursor?: string;
}

export interface MonitorPageParams extends RequestOptions {
  limit?: number;
  cursor?: string;
}

export interface MonitorPagesParams extends MonitorPageParams {
  /** Keep pages the monitor rated at least this important (1 to 5). */
  minImportance?: number;
}

export interface BulkFilter {
  status?: MonitorStatus;
  name?: string;
  metadata?: Record<string, string>;
}

export interface MonitorBulkParams extends RequestOptions {
  ids?: string[];
  filter?: BulkFilter;
  /** At most this many monitors (default 50, up to 500). */
  limit?: number;
  /** `true` (the default) only reports what would change. */
  dryRun?: boolean;
}

export interface MonitorSearch {
  query: string;
  maxResults: number;
  includeDomains: string[] | null;
  excludeDomains: string[] | null;
  contentText: boolean;
}

export interface MonitorSchedule {
  type: string;
  value: string | null;
  timezone: string | null;
}

export interface MonitorWebhook {
  url: string;
  events: string[];
  /** The signing secret (`whsec_...`), only in the response to `create()`. Keep it for `verifyWebhook`. */
  secret?: string;
}

export interface Monitor {
  id: string;
  object: string;
  name: string | null;
  status: MonitorStatus | (string & {});
  search: MonitorSearch;
  schedule: MonitorSchedule | null;
  outputSchema: Record<string, unknown> | null;
  webhook: MonitorWebhook | null;
  metadata: Record<string, string> | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  /** The next three run times, UTC. */
  upcomingRuns: string[];
  createdAt: string;
  updatedAt: string;
  /** Not available yet: always null. */
  agentRunId: unknown;
  /** Not available yet: always null. */
  backfill: unknown;
  /** Not available yet: always null. */
  memoryScope: unknown;
  /** Null until monitors are priced. */
  estimatedCostUsd: number | null;
  /** Null until monitors are priced. */
  costThisMonthUsd: number | null;
  requestId?: string;
  raw: Record<string, unknown>;
}

export interface MonitorResultChange {
  previousAt: string | null;
  previousTitle: string | null;
  previousSent: boolean | null;
  /** The share of the new text that was not in the old one, 0 to 1. */
  ratio: number | null;
  added: string[] | null;
  removed: string[] | null;
}

/** A page a monitor found: in a run, a webhook event or `pages()`. */
export interface MonitorResult {
  url: string;
  title: string | null;
  author: string | null;
  publishedAt: string | null;
  acquiredAt: string | null;
  image: string | null;
  /** Always null for now. */
  favicon: string | null;
  /** Always null for now. */
  highlights: unknown;
  /** When the monitor accepted the page. */
  matchedAt: string | null;
  /** declared, url, x or text: where the date comes from. */
  publishedAtSource: string | null;
  /** One line on what the page reports. */
  summary: string | null;
  /** 1 to 5 for the monitor's topic; pages under 3 are not sent. */
  importance: number | null;
  kind: string | null;
  /** original or rewrite. */
  sourceType: string | null;
  /** Uncalibrated relevance, only for ordering one monitor's pages. */
  score: number | null;
  /** The page's text, when the monitor's search asks for it. */
  text?: string;
  /** On monitor.update: how the page changed. */
  change?: MonitorResultChange;
  /** From `pages()`: identifies the match; also the cursor of the page it ends. */
  id?: string;
  /** From `pages()`: how many more pages reported the same story and were left out. */
  sameStory?: number;
  raw: Record<string, unknown>;
}

export interface MonitorRunOutput {
  structured: unknown;
  text: string | null;
  grounding: unknown[];
}

export interface MonitorRun {
  id: string;
  object: string;
  monitorId: string;
  status: MonitorRunStatus | (string & {});
  /** New pages; [] when none; null until the run completes. */
  results: MonitorResult[] | null;
  /** Always null for now. */
  changes: unknown;
  /** When the monitor has an output schema. */
  output: MonitorRunOutput | null;
  error: { code: string; message: string } | null;
  /** Null until monitors are priced. */
  usage: unknown;
  createdAt: string | null;
  startedAt: string | null;
  endedAt: string | null;
  requestId?: string;
  raw: Record<string, unknown>;
}

export interface MonitorDelivery {
  id: string;
  type: string;
  url: string;
  createdAt: string;
  attempts: number;
  deliveredAt: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  raw: Record<string, unknown>;
}

export interface MonitorStats {
  total: number;
  byStatus: Record<string, number>;
  /** Keys cron, interval, once and manual. */
  bySchedule: Record<string, number>;
  requestId?: string;
  raw: Record<string, unknown>;
}

export interface BulkResult {
  action: string;
  affected: number;
  ids: string[];
  dryRun: boolean;
  /** More monitors matched than `limit`. */
  hasMore: boolean;
  /** Of the ids sent, those that are not monitors of this key. */
  notFound: string[];
  requestId?: string;
  raw: Record<string, unknown>;
}

/** One page of a list. */
export interface ListPage<T> {
  data: T[];
  hasMore: boolean;
  nextCursor: string | null;
  requestId?: string;
  raw: Record<string, unknown>;
}

export type MonitorList = ListPage<Monitor>;
export type RunList = ListPage<MonitorRun>;
export type PageList = ListPage<MonitorResult>;
export type DeliveryList = ListPage<MonitorDelivery>;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function reqStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function int(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function strs(value: unknown): string[] | null {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
}

function objects(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isObject) : [];
}

function strMap(value: unknown): Record<string, string> | null {
  if (!isObject(value)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === "string") out[k] = v;
  return out;
}

function intMap(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isObject(value)) return out;
  for (const [k, v] of Object.entries(value)) {
    const n = int(v);
    if (n !== null) out[k] = n;
  }
  return out;
}

/** @internal */
export function toMonitor(data: Json, requestId?: string): Monitor {
  const search = isObject(data.search) ? data.search : {};
  const content = isObject(search.content) ? search.content : {};
  const schedule = isObject(data.schedule) ? data.schedule : null;
  const webhook = isObject(data.webhook) ? data.webhook : null;
  return {
    id: reqStr(data.id),
    object: reqStr(data.object) || "monitor",
    name: str(data.name),
    status: reqStr(data.status),
    search: {
      query: reqStr(search.query),
      maxResults: int(search.max_results) ?? 0,
      includeDomains: strs(search.include_domains),
      excludeDomains: strs(search.exclude_domains),
      contentText: content.text === true,
    },
    schedule: schedule
      ? { type: reqStr(schedule.type), value: str(schedule.value), timezone: str(schedule.timezone) }
      : null,
    outputSchema: isObject(data.output_schema) ? data.output_schema : null,
    webhook: webhook
      ? {
          url: reqStr(webhook.url),
          events: strs(webhook.events) ?? [],
          ...(typeof webhook.secret === "string" ? { secret: webhook.secret } : {}),
        }
      : null,
    metadata: strMap(data.metadata),
    lastRunAt: str(data.last_run_at),
    nextRunAt: str(data.next_run_at),
    upcomingRuns: strs(data.upcoming_runs) ?? [],
    createdAt: reqStr(data.created_at),
    updatedAt: reqStr(data.updated_at),
    agentRunId: data.agent_run_id ?? null,
    backfill: data.backfill ?? null,
    memoryScope: data.memory_scope ?? null,
    estimatedCostUsd: num(data.estimated_cost_usd),
    costThisMonthUsd: num(data.cost_this_month_usd),
    requestId,
    raw: data,
  };
}

/** @internal */
export function toMonitorResult(data: Json): MonitorResult {
  const result: MonitorResult = {
    url: reqStr(data.url),
    title: str(data.title),
    author: str(data.author),
    publishedAt: str(data.published_at),
    acquiredAt: str(data.acquired_at),
    image: str(data.image),
    favicon: str(data.favicon),
    highlights: data.highlights ?? null,
    matchedAt: str(data.matched_at),
    publishedAtSource: str(data.published_at_source),
    summary: str(data.summary),
    importance: int(data.importance),
    kind: str(data.kind),
    sourceType: str(data.source_type),
    score: num(data.score),
    raw: data,
  };
  if (typeof data.text === "string") result.text = data.text;
  if (isObject(data.change)) {
    const c = data.change;
    result.change = {
      previousAt: str(c.previous_at),
      previousTitle: str(c.previous_title),
      previousSent: typeof c.previous_sent === "boolean" ? c.previous_sent : null,
      ratio: num(c.ratio),
      added: strs(c.added),
      removed: strs(c.removed),
    };
  }
  if (typeof data.id === "string") result.id = data.id;
  const same = int(data.same_story);
  if (same !== null) result.sameStory = same;
  return result;
}

/** @internal */
export function toMonitorRun(data: Json, requestId?: string): MonitorRun {
  const output = isObject(data.output) ? data.output : null;
  const error = isObject(data.error) ? data.error : null;
  return {
    id: reqStr(data.id),
    object: reqStr(data.object) || "monitor_run",
    monitorId: reqStr(data.monitor_id),
    status: reqStr(data.status),
    results: Array.isArray(data.results) ? objects(data.results).map(toMonitorResult) : null,
    changes: data.changes ?? null,
    output: output
      ? {
          structured: output.structured ?? null,
          text: str(output.text),
          grounding: Array.isArray(output.grounding) ? output.grounding : [],
        }
      : null,
    error: error ? { code: reqStr(error.code), message: reqStr(error.message) } : null,
    usage: data.usage ?? null,
    createdAt: str(data.created_at),
    startedAt: str(data.started_at),
    endedAt: str(data.ended_at),
    requestId,
    raw: data,
  };
}

function toDelivery(data: Json): MonitorDelivery {
  return {
    id: reqStr(data.id),
    type: reqStr(data.type),
    url: reqStr(data.url),
    createdAt: reqStr(data.created_at),
    attempts: int(data.attempts) ?? 0,
    deliveredAt: str(data.delivered_at),
    lastError: str(data.last_error),
    nextAttemptAt: str(data.next_attempt_at),
    raw: data,
  };
}

function toList<T>(data: Json, requestId: string | undefined, item: (x: Json) => T): ListPage<T> {
  return {
    data: objects(data.data).map(item),
    hasMore: data.has_more === true,
    nextCursor: str(data.next_cursor) || null,
    requestId,
    raw: data,
  };
}

/** @internal One Monitors request, sent by the client. */
export interface MonitorCall {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  query?: Record<string, string>;
  body?: Json;
  headers?: Record<string, string>;
  safe: boolean;
}

type Send = (
  call: MonitorCall,
  options: RequestOptions,
) => Promise<{ data: Json; requestId?: string }>;

function segment(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new KeenableInvalidRequestError(`${name} must be a non-empty string`);
  }
  return encodeURIComponent(value);
}

function query(values: Record<string, string | number | undefined | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined && v !== null && v !== "") out[k] = String(v);
  }
  return out;
}

function requestOptions(options: RequestOptions): RequestOptions {
  return {
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    headers: options.headers,
  };
}

function searchBody(search: Partial<MonitorSearchParams>, required: boolean): Json {
  if (!isObject(search)) {
    throw new KeenableInvalidRequestError(
      'search must be an object such as { query: "new open-weights LLM releases" }',
    );
  }
  if ((required || search.query !== undefined) && (typeof search.query !== "string" || search.query.trim() === "")) {
    throw new KeenableInvalidRequestError("search needs a non-empty query string");
  }
  const body: Json = {};
  if (search.query !== undefined) body.query = search.query;
  if (search.maxResults !== undefined) body.max_results = search.maxResults;
  if (search.includeDomains !== undefined) body.include_domains = search.includeDomains;
  if (search.excludeDomains !== undefined) body.exclude_domains = search.excludeDomains;
  if (search.contentText !== undefined) body.content = { text: search.contentText };
  return body;
}

function webhookBody(webhook: Partial<MonitorWebhookParams>): Json {
  const body: Json = {};
  if (webhook.url !== undefined) body.url = webhook.url;
  if (webhook.events !== undefined) body.events = webhook.events;
  return body;
}

function scheduleBody(schedule: MonitorScheduleParams): Json {
  const body: Json = { type: schedule.type };
  if (schedule.value !== undefined) body.value = schedule.value;
  if (schedule.timezone !== undefined) body.timezone = schedule.timezone;
  return body;
}

function newKey(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  const hex = (n: number) =>
    Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join("");
  return `${hex(8)}-${hex(4)}-4${hex(3)}-${"89ab"[Math.floor(Math.random() * 4)]}${hex(3)}-${hex(12)}`;
}

const BULK_ACTIONS = new Set(["pause", "resume", "delete"]);

/**
 * `keenable.monitors`: create, read and manage monitors. Needs an API key.
 *
 * Every call takes the usual `signal`, `timeoutMs`, `maxRetries` and
 * `headers`. Reads and deletes are retried like a search. `create()` sends an
 * `Idempotency-Key` (yours, or a new one per call), so retrying it cannot
 * make a second monitor. `update()`, `trigger()` and `bulk()` are retried only
 * on a 429, which the API sends before it does anything.
 */
export class Monitors {
  /** @internal */
  constructor(private readonly send: Send) {}

  /** Create a monitor. Takes a few seconds; `webhook.secret` is in this response only. */
  async create(params: MonitorCreateParams): Promise<Monitor> {
    if (!isObject(params)) throw new KeenableInvalidRequestError("create() needs { search: { query } }");
    const body: Json = { search: searchBody(params.search, true) };
    if (params.name !== undefined) body.name = params.name;
    if (params.schedule !== undefined) body.schedule = scheduleBody(params.schedule);
    if (params.outputSchema !== undefined) body.output_schema = params.outputSchema;
    if (params.webhook !== undefined) body.webhook = webhookBody(params.webhook);
    if (params.metadata !== undefined) body.metadata = params.metadata;
    const { data, requestId } = await this.send(
      {
        method: "POST",
        path: "monitors",
        body,
        headers: { "Idempotency-Key": params.idempotencyKey || newKey() },
        safe: true,
      },
      requestOptions(params),
    );
    return toMonitor(data, requestId);
  }

  /** One page of monitors, newest first. */
  async list(params: MonitorListParams = {}): Promise<MonitorList> {
    const q = query({ status: params.status, name: params.name, limit: params.limit, cursor: params.cursor });
    for (const [k, v] of Object.entries(params.metadata ?? {})) q[`metadata[${k}]`] = v;
    const { data, requestId } = await this.send(
      { method: "GET", path: "monitors", query: q, safe: true },
      requestOptions(params),
    );
    return toList(data, requestId, (x) => toMonitor(x));
  }

  /** Every monitor, newest first: `for await (const monitor of keenable.monitors.listAll())`. */
  async *listAll(params: Omit<MonitorListParams, "cursor"> = {}): AsyncGenerator<Monitor, void, undefined> {
    let cursor: string | undefined;
    for (;;) {
      const page = await this.list({ ...params, cursor });
      yield* page.data;
      if (!page.hasMore || !page.nextCursor) return;
      cursor = page.nextCursor;
    }
  }

  /** One monitor. */
  async get(monitorId: string, options: RequestOptions = {}): Promise<Monitor> {
    const { data, requestId } = await this.send(
      { method: "GET", path: `monitors/${segment("monitorId", monitorId)}`, safe: true },
      requestOptions(options),
    );
    return toMonitor(data, requestId);
  }

  /** Change a monitor; only the fields you set are sent. Not retried on a 5xx. */
  async update(monitorId: string, params: MonitorUpdateParams): Promise<Monitor> {
    const path = `monitors/${segment("monitorId", monitorId)}`;
    const body: Json = {};
    if (params.name !== undefined) body.name = params.name;
    if (params.status !== undefined) body.status = params.status;
    if (params.search !== undefined) body.search = searchBody(params.search, false);
    if (params.schedule !== undefined) body.schedule = params.schedule === null ? null : scheduleBody(params.schedule);
    if (params.outputSchema !== undefined) body.output_schema = params.outputSchema;
    if (params.webhook !== undefined) body.webhook = params.webhook === null ? null : webhookBody(params.webhook);
    if (params.metadata !== undefined) body.metadata = params.metadata;
    const { data, requestId } = await this.send(
      { method: "PATCH", path, body, safe: false },
      requestOptions(params),
    );
    return toMonitor(data, requestId);
  }

  /** Pause a monitor: `update(id, { status: "paused" })`. */
  pause(monitorId: string, options: RequestOptions = {}): Promise<Monitor> {
    return this.update(monitorId, { ...requestOptions(options), status: "paused" });
  }

  /** Resume a paused or disabled monitor: `update(id, { status: "active" })`. */
  resume(monitorId: string, options: RequestOptions = {}): Promise<Monitor> {
    return this.update(monitorId, { ...requestOptions(options), status: "active" });
  }

  /** Delete a monitor and the pages it found, for good. Returns it as it was. */
  async delete(monitorId: string, options: RequestOptions = {}): Promise<Monitor> {
    const { data, requestId } = await this.send(
      { method: "DELETE", path: `monitors/${segment("monitorId", monitorId)}`, safe: true },
      requestOptions(options),
    );
    return toMonitor(data, requestId);
  }

  /** Start a run now and return it queued. Not retried on a 5xx. */
  async trigger(monitorId: string, options: RequestOptions = {}): Promise<MonitorRun> {
    const { data, requestId } = await this.send(
      { method: "POST", path: `monitors/${segment("monitorId", monitorId)}/trigger`, safe: false },
      requestOptions(options),
    );
    return toMonitorRun(data, requestId);
  }

  /** One page of a monitor's runs, newest first. */
  async runs(monitorId: string, params: MonitorPageParams = {}): Promise<RunList> {
    const { data, requestId } = await this.send(
      {
        method: "GET",
        path: `monitors/${segment("monitorId", monitorId)}/runs`,
        query: query({ limit: params.limit, cursor: params.cursor }),
        safe: true,
      },
      requestOptions(params),
    );
    return toList(data, requestId, (x) => toMonitorRun(x));
  }

  /** One run. */
  async run(monitorId: string, runId: string, options: RequestOptions = {}): Promise<MonitorRun> {
    const { data, requestId } = await this.send(
      {
        method: "GET",
        path: `monitors/${segment("monitorId", monitorId)}/runs/${segment("runId", runId)}`,
        safe: true,
      },
      requestOptions(options),
    );
    return toMonitorRun(data, requestId);
  }

  /**
   * The pages a monitor accepted, newest first, one per story. Poll and stop
   * at the first `id` already seen; `minImportance: 4` keeps the pages a
   * reader would not want to miss.
   */
  async pages(monitorId: string, params: MonitorPagesParams = {}): Promise<PageList> {
    const { data, requestId } = await this.send(
      {
        method: "GET",
        path: `monitors/${segment("monitorId", monitorId)}/hits`,
        query: query({ limit: params.limit, cursor: params.cursor, min_importance: params.minImportance }),
        safe: true,
      },
      requestOptions(params),
    );
    return toList(data, requestId, toMonitorResult);
  }

  /** The monitor's webhook events of the last 7 days, with attempts and the last error. */
  async deliveries(monitorId: string, params: MonitorPageParams = {}): Promise<DeliveryList> {
    const { data, requestId } = await this.send(
      {
        method: "GET",
        path: `monitors/${segment("monitorId", monitorId)}/deliveries`,
        query: query({ limit: params.limit, cursor: params.cursor }),
        safe: true,
      },
      requestOptions(params),
    );
    return toList(data, requestId, toDelivery);
  }

  /** Counts of monitors by status and by kind of schedule. */
  async stats(options: RequestOptions = {}): Promise<MonitorStats> {
    const { data, requestId } = await this.send(
      { method: "GET", path: "monitors/stats", safe: true },
      requestOptions(options),
    );
    return {
      total: int(data.total) ?? 0,
      byStatus: intMap(data.by_status),
      bySchedule: intMap(data.by_schedule),
      requestId,
      raw: data,
    };
  }

  /**
   * Pause, resume or delete many monitors, by `ids` or by `filter`.
   * `dryRun` is true unless you pass false. Not retried on a 5xx.
   */
  async bulk(action: BulkAction, params: MonitorBulkParams = {}): Promise<BulkResult> {
    if (!BULK_ACTIONS.has(action)) {
      throw new KeenableInvalidRequestError(`action must be pause, resume or delete, got ${JSON.stringify(action)}`);
    }
    const hasFilter = params.filter !== undefined && Object.keys(params.filter).length > 0;
    if (!params.ids?.length && !hasFilter) {
      throw new KeenableInvalidRequestError("bulk() needs ids or a filter");
    }
    const body: Json = { action, dry_run: params.dryRun ?? true };
    if (params.ids?.length) body.ids = params.ids;
    if (hasFilter) body.filter = params.filter;
    if (params.limit !== undefined) body.limit = params.limit;
    const { data, requestId } = await this.send(
      { method: "POST", path: "monitors/bulk", body, safe: false },
      requestOptions(params),
    );
    return {
      action: reqStr(data.action),
      affected: int(data.affected) ?? 0,
      ids: strs(data.ids) ?? [],
      dryRun: data.dry_run === true,
      hasMore: data.has_more === true,
      notFound: strs(data.not_found) ?? [],
      requestId,
      raw: data,
    };
  }
}
