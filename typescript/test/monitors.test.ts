import { describe, expect, it } from "vitest";

import {
  Keenable,
  KeenableAPIError,
  KeenableAuthError,
  KeenableInvalidRequestError,
  verifyWebhook,
  WebhookVerificationError,
} from "../src/index.js";

const MONITOR = {
  id: "mon_1",
  object: "monitor",
  name: "LLM releases",
  status: "active",
  search: {
    query: "new open-weights LLM releases",
    max_results: 10,
    include_domains: null,
    exclude_domains: ["example.com"],
    content: { text: true },
  },
  agent_run_id: null,
  backfill: null,
  schedule: { type: "cron", value: "0 9 * * 1-5", timezone: "Europe/Paris" },
  output_schema: null,
  webhook: { url: "https://hooks.example.com/k", events: ["monitor.hit"], secret: "whsec_abc" },
  metadata: { team: "research" },
  memory_scope: null,
  estimated_cost_usd: null,
  cost_this_month_usd: null,
  last_run_at: null,
  next_run_at: "2026-11-18T08:00:00Z",
  upcoming_runs: ["2026-11-18T08:00:00Z"],
  created_at: "2026-11-17T10:00:00Z",
  updated_at: "2026-11-17T10:00:00Z",
};

const RESULT = {
  url: "https://example.org/a",
  title: "A model",
  author: null,
  published_at: "2026-11-17T09:00:00Z",
  acquired_at: "2026-11-17T09:05:00Z",
  image: null,
  favicon: null,
  highlights: null,
  matched_at: "2026-11-17T09:10:00Z",
  published_at_source: "declared",
  summary: "A lab released a model.",
  importance: 4,
  kind: "news",
  source_type: "original",
  score: 0.7,
};

const RUN = {
  id: "mrun_1",
  object: "monitor_run",
  monitor_id: "mon_1",
  status: "completed",
  results: [RESULT],
  changes: null,
  output: { structured: { n: 1 }, text: null, grounding: [] },
  error: null,
  usage: null,
  created_at: "2026-11-17T10:00:00Z",
  started_at: "2026-11-17T10:00:01Z",
  ended_at: "2026-11-17T10:00:09Z",
};

type Seen = { url: URL; method: string; headers: Headers; body: unknown };

function client(replies: Array<[number, unknown]>, options: { apiKey?: string; maxRetries?: number } = {}) {
  const seen: Seen[] = [];
  const keenable = new Keenable({
    apiKey: "apiKey" in options ? options.apiKey : "k",
    maxRetries: options.maxRetries ?? 0,
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      seen.push({
        url: new URL(String(input)),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const [status, body] = replies[Math.min(seen.length, replies.length) - 1]!;
      return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof globalThis.fetch,
  });
  return { keenable, seen };
}

const page = (data: unknown[], nextCursor: string | null = null) => ({
  data,
  has_more: nextCursor !== null,
  next_cursor: nextCursor,
});

describe("monitors", () => {
  it("creates a monitor with an idempotency key and parses it", async () => {
    const { keenable, seen } = client([[201, MONITOR]]);
    const monitor = await keenable.monitors.create({
      search: { query: "new open-weights LLM releases", excludeDomains: ["x.com"], contentText: true },
      name: "LLM releases",
      schedule: { type: "cron", value: "0 9 * * 1-5", timezone: "Europe/Paris" },
      webhook: { url: "https://hooks.example.com/k", events: ["monitor.hit"] },
      metadata: { team: "research" },
    });
    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.url.toString()).toBe("https://api.keenable.ai/v1/monitors");
    expect(req.headers.get("X-API-Key")).toBe("k");
    expect(req.headers.get("Idempotency-Key")).toHaveLength(36);
    expect(req.body).toEqual({
      search: { query: "new open-weights LLM releases", exclude_domains: ["x.com"], content: { text: true } },
      name: "LLM releases",
      schedule: { type: "cron", value: "0 9 * * 1-5", timezone: "Europe/Paris" },
      webhook: { url: "https://hooks.example.com/k", events: ["monitor.hit"] },
      metadata: { team: "research" },
    });
    expect(monitor.id).toBe("mon_1");
    expect(monitor.search?.contentText).toBe(true);
    expect(monitor.search?.excludeDomains).toEqual(["example.com"]);
    expect(monitor.webhook?.secret).toBe("whsec_abc");
    expect(monitor.upcomingRuns).toEqual(["2026-11-18T08:00:00Z"]);
    expect(monitor.estimatedCostUsd).toBeNull();
  });

  it("retries a create with the same idempotency key", async () => {
    const { keenable, seen } = client(
      [
        [503, {}],
        [201, MONITOR],
      ],
      { maxRetries: 2 },
    );
    await keenable.monitors.create({ search: { query: "q" }, idempotencyKey: "key-1", timeoutMs: 1000 });
    expect(seen.map((r) => r.headers.get("Idempotency-Key"))).toEqual(["key-1", "key-1"]);
  });

  it("gives each create its own key", async () => {
    const { keenable, seen } = client([[201, MONITOR]]);
    await keenable.monitors.create({ search: { query: "q" } });
    await keenable.monitors.create({ search: { query: "q" } });
    expect(seen[0]!.headers.get("Idempotency-Key")).not.toBe(seen[1]!.headers.get("Idempotency-Key"));
  });

  it("refuses a create without a query", async () => {
    const { keenable, seen } = client([[201, MONITOR]]);
    await expect(keenable.monitors.create({ search: { query: " " } })).rejects.toBeInstanceOf(
      KeenableInvalidRequestError,
    );
    expect(seen).toHaveLength(0);
  });

  it("needs a key and sends nothing without one", async () => {
    const saved = process.env.KEENABLE_API_KEY;
    delete process.env.KEENABLE_API_KEY;
    try {
      const { keenable, seen } = client([[200, MONITOR]], { apiKey: undefined });
      const error = await keenable.monitors.get("mon_1").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(KeenableAuthError);
      expect((error as KeenableAuthError).code).toBe("missing_api_key");
      expect(seen).toHaveLength(0);
    } finally {
      if (saved !== undefined) process.env.KEENABLE_API_KEY = saved;
    }
  });

  it("lists with filters and follows the cursor in listAll", async () => {
    const { keenable, seen } = client([
      [200, page([MONITOR], "c1")],
      [200, page([{ ...MONITOR, id: "mon_2" }])],
    ]);
    const ids: string[] = [];
    for await (const m of keenable.monitors.listAll({ status: "active", metadata: { team: "research" }, limit: 1 })) {
      ids.push(m.id);
    }
    expect(ids).toEqual(["mon_1", "mon_2"]);
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({
      status: "active",
      limit: "1",
      "metadata[team]": "research",
    });
    expect(seen[1]!.url.searchParams.get("cursor")).toBe("c1");
  });

  it("encodes ids in paths, gets and deletes", async () => {
    const { keenable, seen } = client([[200, MONITOR]]);
    await keenable.monitors.get("mon/1");
    await keenable.monitors.delete("mon_1");
    expect(seen[0]!.url.pathname).toBe("/v1/monitors/mon%2F1");
    expect(seen[1]!.method).toBe("DELETE");
  });

  it("updates only what was given, null removes", async () => {
    const { keenable, seen } = client([[200, MONITOR]]);
    await keenable.monitors.update("mon_1", { name: "New", schedule: null, search: { maxResults: 5 } });
    await keenable.monitors.pause("mon_1");
    await keenable.monitors.resume("mon_1");
    expect(seen[0]!.method).toBe("PATCH");
    expect(seen.map((r) => r.body)).toEqual([
      { name: "New", schedule: null, search: { max_results: 5 } },
      { status: "paused" },
      { status: "active" },
    ]);
  });

  it("does not retry update, trigger or bulk on a 5xx", async () => {
    const { keenable, seen } = client([[503, {}]], { maxRetries: 2 });
    await expect(keenable.monitors.update("mon_1", { name: "x" })).rejects.toBeInstanceOf(KeenableAPIError);
    await expect(keenable.monitors.trigger("mon_1")).rejects.toBeInstanceOf(KeenableAPIError);
    await expect(keenable.monitors.bulk("pause", { ids: ["mon_1"] })).rejects.toBeInstanceOf(KeenableAPIError);
    expect(seen).toHaveLength(3);
  });

  it("retries a trigger on a 429 and parses the run", async () => {
    const { keenable, seen } = client(
      [
        [429, { retry_after_seconds: 0 }],
        [200, { ...RUN, status: "queued", results: null }],
      ],
      { maxRetries: 2 },
    );
    const run = await keenable.monitors.trigger("mon_1");
    expect(seen).toHaveLength(2);
    expect(seen[0]!.url.pathname).toBe("/v1/monitors/mon_1/trigger");
    expect(run.status).toBe("queued");
    expect(run.results).toBeNull();
  });

  it("retries reads on a 5xx", async () => {
    const { keenable, seen } = client(
      [
        [500, { retry_after_seconds: 0 }],
        [200, MONITOR],
      ],
      { maxRetries: 2 },
    );
    await keenable.monitors.get("mon_1");
    expect(seen).toHaveLength(2);
  });

  it("reads runs, a run, pages, deliveries and stats", async () => {
    const delivery = {
      id: "evt_1",
      type: "monitor.hit",
      url: "https://hooks.example.com/k",
      created_at: "2026-11-17T10:00:00Z",
      attempts: 2,
      delivered_at: null,
      last_error: "HTTP 500",
      next_attempt_at: null,
    };
    const { keenable, seen } = client([
      [200, page([RUN])],
      [200, RUN],
      [200, page([{ ...RESULT, id: "h1", same_story: 2 }])],
      [200, page([delivery])],
      [200, { total: 3, by_status: { active: 2 }, by_schedule: { manual: 3 } }],
    ]);
    const runs = await keenable.monitors.runs("mon_1", { limit: 5, cursor: "r0" });
    const run = await keenable.monitors.run("mon_1", "mrun_1");
    const pages = await keenable.monitors.pages("mon_1", { minImportance: 4 });
    const deliveries = await keenable.monitors.deliveries("mon_1");
    const stats = await keenable.monitors.stats();
    expect(seen.map((r) => r.url.pathname)).toEqual([
      "/v1/monitors/mon_1/runs",
      "/v1/monitors/mon_1/runs/mrun_1",
      "/v1/monitors/mon_1/hits",
      "/v1/monitors/mon_1/deliveries",
      "/v1/monitors/stats",
    ]);
    expect(seen[0]!.url.search).toBe("?limit=5&cursor=r0");
    expect(seen[2]!.url.search).toBe("?min_importance=4");
    expect(runs.data[0]!.monitorId).toBe("mon_1");
    expect(run.results?.[0]?.importance).toBe(4);
    expect(run.output?.structured).toEqual({ n: 1 });
    expect(pages.data[0]!.id).toBe("h1");
    expect(pages.data[0]!.sameStory).toBe(2);
    expect(pages.data[0]!.sourceType).toBe("original");
    expect(deliveries.data[0]!.lastError).toBe("HTTP 500");
    expect(stats.byStatus.active).toBe(2);
  });

  it("sends bulk with a dry run by default", async () => {
    const { keenable, seen } = client([
      [200, { action: "pause", affected: 1, ids: ["mon_1"], dry_run: true, has_more: false, not_found: ["mon_x"] }],
    ]);
    const result = await keenable.monitors.bulk("pause", {
      ids: ["mon_1", "mon_x"],
      filter: { status: "active", name: "", metadata: {} },
    });
    expect(seen[0]!.body).toEqual({
      action: "pause",
      dry_run: true,
      ids: ["mon_1", "mon_x"],
      filter: { status: "active" },
    });
    expect(result.notFound).toEqual(["mon_x"]);
    await expect(keenable.monitors.bulk("pause")).rejects.toBeInstanceOf(KeenableInvalidRequestError);
  });

  it("refuses a bulk filter that selects nothing before sending", async () => {
    const { keenable, seen } = client([[200, {}]]);
    for (const filter of [{}, { metadata: {} }, { name: "" }]) {
      await expect(keenable.monitors.bulk("pause", { filter })).rejects.toBeInstanceOf(KeenableInvalidRequestError);
    }
    expect(seen).toHaveLength(0);
  });

  it.each([".", ".."])("refuses the monitor id %j before sending", async (id) => {
    const { keenable, seen } = client([[200, MONITOR]]);
    await expect(keenable.monitors.get(id)).rejects.toBeInstanceOf(KeenableInvalidRequestError);
    await expect(keenable.monitors.delete(id)).rejects.toBeInstanceOf(KeenableInvalidRequestError);
    await expect(keenable.monitors.runs(id)).rejects.toBeInstanceOf(KeenableInvalidRequestError);
    expect(seen).toHaveLength(0);
  });
});

const SECRET = "whsec_a2VlbmFibGUtbW9uaXRvcnMtd2ViaG9vay10ZXN0ISE=";
const BODY =
  '{"id":"msg_2nY8kTestVector01","type":"monitor.hit","created_at":"2026-11-17T17:20:00Z","data":{"monitor_id":"mon_test01","result":{"url":"https://example.com/news/1","title":"Open weights model released","author":null,"published_at":"2026-11-17T16:00:00Z","acquired_at":"2026-11-17T16:05:00Z","image":null,"favicon":null,"highlights":null,"matched_at":"2026-11-17T16:10:00Z","published_at_source":"declared","summary":"A lab released an open-weights model.","importance":4,"kind":"news","source_type":"original","score":0.82}},"metadata":{"team":"research"}}';
const HEADERS = {
  "webhook-id": "msg_2nY8kTestVector01",
  "webhook-timestamp": "1763400000",
  "webhook-signature": "v1,9+ChBZb9nSbPYLix6nY+Pd+ykv10PwAjK5TDBLb2qp4=",
};

describe("verifyWebhook", () => {
  it("verifies the known vector", async () => {
    const event = await verifyWebhook(BODY, new Headers(HEADERS), SECRET, { now: 1763400000 });
    expect(event.id).toBe("msg_2nY8kTestVector01");
    expect(event.type).toBe("monitor.hit");
    expect(event.data.monitorId).toBe("mon_test01");
    expect(event.data.result?.url).toBe("https://example.com/news/1");
    expect(event.data.result?.importance).toBe(4);
    expect(event.metadata).toEqual({ team: "research" });
  });

  it("refuses a stale delivery by the clock", async () => {
    await expect(verifyWebhook(BODY, HEADERS, SECRET)).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it.each([Infinity, -Infinity, NaN, 0, -1])("refuses the tolerance %s", async (toleranceSeconds) => {
    await expect(verifyWebhook(BODY, HEADERS, SECRET, { now: 1763400000, toleranceSeconds })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it("refuses a secret with no key after whsec_", async () => {
    await expect(verifyWebhook(BODY, HEADERS, "whsec_", { now: 1763400000 })).rejects.toBeInstanceOf(
      WebhookVerificationError,
    );
  });

  it("refuses a timestamp of more than 12 digits", async () => {
    const headers = { ...HEADERS, "webhook-timestamp": "1".repeat(400) };
    await expect(verifyWebhook(BODY, headers, SECRET, { now: 1763400000 })).rejects.toThrow(/not a Unix time/);
  });
});

const PAGE_MONITOR = {
  ...MONITOR,
  id: "mon_p",
  type: "page",
  search: null,
  page: { url: "https://example.com/pricing", watch_for: "plan prices", sensitivity: "meaningful" },
  webhook: null,
  status: "disabled",
  estimated_cost_usd: 0.24,
  cost_this_month_usd: 0.004,
  disabled_reason: { code: "insufficient_credits", message: "The organization is out of credits." },
};

const DIFF = {
  previous_at: "2026-11-17T08:00:00Z",
  ratio: 0.12,
  added: ["Pro: $30/month"],
  removed: ["Pro: $25/month"],
};

const PAGE_RUN = {
  ...RUN,
  id: "mrun_p",
  monitor_id: "mon_p",
  results: [],
  changes: {
    changed: true,
    notified: true,
    baseline: false,
    version: 3,
    source: "live",
    summary: "The Pro plan went from $25 to $30 a month.",
    items: ["Pro: $30/month"],
    diff: DIFF,
  },
  output: {
    structured: null,
    text: null,
    grounding: [],
    fresh: false,
    error: { code: "output_invalid", message: "missing field price" },
  },
  usage: { runs: 1, credits: 0.5, cost_usd: 0.002 },
};

const VERSION = {
  id: "ver_3",
  object: "page_version",
  version: 3,
  fetched_at: "2026-11-18T08:00:00Z",
  title: "Pricing",
  source: "live",
  notified: true,
  summary: "The Pro plan went from $25 to $30 a month.",
  items: ["Pro: $30/month"],
  diff: DIFF,
};

describe("page monitors", () => {
  it("creates a page monitor and parses it", async () => {
    const { keenable, seen } = client([[201, PAGE_MONITOR]]);
    const monitor = await keenable.monitors.create({
      type: "page",
      page: { url: "https://example.com/pricing", watchFor: "plan prices", sensitivity: "any" },
      schedule: { type: "interval", value: "10m" },
    });
    expect(seen[0]!.body).toEqual({
      type: "page",
      page: { url: "https://example.com/pricing", watch_for: "plan prices", sensitivity: "any" },
      schedule: { type: "interval", value: "10m" },
    });
    expect(monitor.type).toBe("page");
    expect(monitor.search).toBeNull();
    expect(monitor.page).toEqual({
      url: "https://example.com/pricing",
      watchFor: "plan prices",
      sensitivity: "meaningful",
    });
    expect(monitor.estimatedCostUsd).toBe(0.24);
    expect(monitor.costThisMonthUsd).toBe(0.004);
    expect(monitor.disabledReason).toEqual({
      code: "insufficient_credits",
      message: "The organization is out of credits.",
    });
  });

  it("reads a search monitor's type, with no page", async () => {
    const { keenable } = client([[200, { ...MONITOR, type: "search" }]]);
    const monitor = await keenable.monitors.get("mon_1");
    expect(monitor.type).toBe("search");
    expect(monitor.page).toBeNull();
    expect(monitor.disabledReason).toBeNull();
    expect(monitor.search?.query).toBe("new open-weights LLM releases");
  });

  it("sends type search when given", async () => {
    const { keenable, seen } = client([[201, MONITOR]]);
    await keenable.monitors.create({ type: "search", search: { query: "q" } });
    expect(seen[0]!.body).toEqual({ type: "search", search: { query: "q" } });
  });

  it("checks the kind of monitor before sending", async () => {
    const { keenable, seen } = client([[201, MONITOR]]);
    const bad = [
      { type: "page" },
      { type: "page", page: { url: " " } },
      { type: "page", page: { url: "https://example.com" }, search: { query: "q" } },
      { search: { query: "q" }, page: { url: "https://example.com" } },
      { type: "feed", search: { query: "q" } },
      {},
    ];
    for (const params of bad) {
      await expect(keenable.monitors.create(params as never)).rejects.toBeInstanceOf(KeenableInvalidRequestError);
    }
    expect(seen).toHaveLength(0);
  });

  it("updates a page, null clears watchFor", async () => {
    const { keenable, seen } = client([[200, PAGE_MONITOR]]);
    await keenable.monitors.update("mon_p", { page: { watchFor: null, sensitivity: "any" } });
    expect(seen[0]!.body).toEqual({ page: { watch_for: null, sensitivity: "any" } });
    await expect(keenable.monitors.update("mon_p", { page: { url: "" } })).rejects.toBeInstanceOf(
      KeenableInvalidRequestError,
    );
  });

  it("parses a page run's changes, output and usage", async () => {
    const { keenable } = client([[200, PAGE_RUN]]);
    const run = await keenable.monitors.run("mon_p", "mrun_p");
    expect(run.results).toEqual([]);
    expect(run.changes).toEqual({
      changed: true,
      notified: true,
      baseline: false,
      version: 3,
      source: "live",
      summary: "The Pro plan went from $25 to $30 a month.",
      items: ["Pro: $30/month"],
      diff: { previousAt: "2026-11-17T08:00:00Z", ratio: 0.12, added: ["Pro: $30/month"], removed: ["Pro: $25/month"] },
    });
    expect(run.output?.fresh).toBe(false);
    expect(run.output?.error).toEqual({ code: "output_invalid", message: "missing field price" });
    expect(run.usage).toEqual({ runs: 1, credits: 0.5, costUsd: 0.002 });
  });

  it("gives a search run no changes and a fresh output", async () => {
    const { keenable } = client([[200, RUN]]);
    const run = await keenable.monitors.run("mon_1", "mrun_1");
    expect(run.changes).toBeNull();
    expect(run.usage).toBeNull();
    expect(run.output?.fresh).toBe(true);
    expect(run.output?.error).toBeNull();
  });

  it("reads an output error sent as a bare code", async () => {
    const { keenable } = client([[200, { ...RUN, output: { structured: null, error: "output_failed" } }]]);
    const run = await keenable.monitors.run("mon_1", "mrun_1");
    expect(run.output?.error).toEqual({ code: "output_failed", message: "" });
  });

  it("lists versions", async () => {
    const first = { ...VERSION, id: "ver_1", version: 1, notified: false, summary: null, items: [], diff: null };
    const { keenable, seen } = client([[200, page([VERSION, first], "ver_1")]]);
    const versions = await keenable.monitors.versions("mon_p", { limit: 2, cursor: "ver_4" });
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.url.pathname).toBe("/v1/monitors/mon_p/versions");
    expect(Object.fromEntries(seen[0]!.url.searchParams)).toEqual({ limit: "2", cursor: "ver_4" });
    expect(versions.hasMore).toBe(true);
    expect(versions.nextCursor).toBe("ver_1");
    expect(versions.data[0]!.version).toBe(3);
    expect(versions.data[0]!.fetchedAt).toBe("2026-11-18T08:00:00Z");
    expect(versions.data[0]!.diff?.added).toEqual(["Pro: $30/month"]);
    expect(versions.data[1]!.diff).toBeNull();
    expect(versions.data[1]!.items).toEqual([]);
    await expect(keenable.monitors.versions("..")).rejects.toBeInstanceOf(KeenableInvalidRequestError);
  });

  it("verifies a monitor.change event", async () => {
    const { createHmac } = await import("node:crypto");
    const body = JSON.stringify({
      id: "msg_change1",
      type: "monitor.change",
      created_at: "2026-11-18T08:00:05Z",
      data: { monitor_id: "mon_p", run: PAGE_RUN },
      metadata: null,
    });
    const key = Buffer.from(SECRET.slice("whsec_".length), "base64");
    const signature = createHmac("sha256", key).update(`msg_change1.1763452805.${body}`).digest("base64");
    const event = await verifyWebhook(
      body,
      { "webhook-id": "msg_change1", "webhook-timestamp": "1763452805", "webhook-signature": `v1,${signature}` },
      SECRET,
      { now: 1763452805 },
    );
    expect(event.type).toBe("monitor.change");
    expect(event.data.run?.changes?.summary).toBe("The Pro plan went from $25 to $30 a month.");
    expect(event.data.result).toBeUndefined();
  });
});
