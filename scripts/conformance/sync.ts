/**
 * Builds the shared conformance fixture from scripts/conformance/cases/*.json
 * and writes the same bytes to each SDK's test fixtures. Every SDK runs every
 * case, so a behaviour that differs between the SDKs fails a test.
 *
 *   node scripts/conformance/sync.ts
 *   node scripts/conformance/sync.ts --check
 *
 * The case files are written by hand for readability: `json` bodies, tuples
 * for URL and Retry-After lists, and error expectations that leave unchecked
 * fields out. This script turns them into one explicit form (every body a
 * string, every field present) so the SDK test runners stay simple.
 * `--check` writes nothing and exits 1 when a copy differs from what the cases
 * produce. Needs Node 22.18+ (it runs this file as TypeScript).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HERE = new URL("./", import.meta.url);
const ROOT = new URL("../../", HERE);
const CASES = new URL("cases/", HERE);

/** Each SDK's copy of the fixture. They are kept byte-identical. */
export const FIXTURE_PATHS = [
  "go/testdata/conformance.json",
  "python/tests/fixtures/conformance.json",
  "typescript/test/fixtures/conformance.json",
  "rust/tests/fixtures/conformance.json",
].map((path) => fileURLToPath(new URL(path, ROOT)));

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

function load(name: string): Obj {
  return JSON.parse(readFileSync(new URL(name, CASES), "utf8")) as Obj;
}

function fail(message: string): never {
  throw new Error(`scripts/conformance/cases: ${message}`);
}

/** A response's body as the text sent: `json` encoded, or `body` as is. */
function bodyText(item: Obj, where: string): string {
  const hasJson = "json" in item;
  const hasBody = "body" in item;
  if (hasJson === hasBody) fail(`${where}: give exactly one of "json" and "body"`);
  if (hasBody) {
    if (typeof item.body !== "string") fail(`${where}: "body" must be a string`);
    return item.body;
  }
  return JSON.stringify(item.json);
}

function headers(item: Obj): Record<string, string> {
  return (item.headers as Record<string, string> | undefined) ?? {};
}

function uniqueNames(section: string, cases: { name: string }[]): void {
  const seen = new Set<string>();
  for (const { name } of cases) {
    if (seen.has(name)) fail(`${section}: duplicate case name ${JSON.stringify(name)}`);
    seen.add(name);
  }
}

function fetchUrls(): Obj[] {
  const source = load("fetch-url.json");
  const pairs = (allowed: boolean) =>
    (source[allowed ? "allowed" : "refused"] as [string, string][]).map(([url, why]) => ({
      name: `${allowed ? "allowed" : "refused"}: ${why}: ${JSON.stringify(url)}`,
      url,
      allowed,
    }));
  return [...pairs(true), ...pairs(false)];
}

function baseUrls(): Obj[] {
  const source = load("base-url.json");
  const pairs = (valid: boolean) =>
    (source[valid ? "valid" : "invalid"] as [string, string][]).map(([base_url, why]) => ({
      name: `${valid ? "valid" : "invalid"}: ${why}: ${JSON.stringify(base_url)}`,
      base_url,
      valid,
    }));
  return [...pairs(true), ...pairs(false)];
}

function retryAfter(): Obj {
  const source = load("retry-after.json");
  return {
    now: source.now as string,
    cases: (source.cases as [string, number | null, string][]).map(([value, seconds, why]) => ({
      name: `${why}: ${JSON.stringify(value)}`,
      value,
      seconds,
    })),
  };
}

function retries(): Obj[] {
  return (load("retry.json").cases as Obj[]).map((item) => {
    const name = item.name as string;
    if (item.retried === false && typeof item.kind !== "string") fail(`retry ${name}: needs a kind`);
    return {
      name,
      status: item.status as number,
      headers: headers(item),
      body: bodyText(item, `retry ${name}`),
      max_retries: (item.max_retries as number | undefined) ?? 1,
      retried: item.retried as boolean,
      wait: (item.wait as Json) ?? null,
      kind: (item.kind as string | undefined) ?? null,
    };
  });
}

const ERROR_FIELDS = [
  "detail",
  "code",
  "type",
  "error",
  "fix",
  "retryable",
  "retry_after_seconds",
  "request_id",
  "param",
  "value",
  "reason",
  "limit",
] as const;
const ERROR_LISTS = ["message_contains", "message_excludes", "absent"] as const;

function errors(): Obj[] {
  return (load("errors.json").cases as Obj[]).map((item) => {
    const name = item.name as string;
    const given = item.expect as Obj;
    for (const key of Object.keys(given)) {
      if (key !== "kind" && !(ERROR_FIELDS as readonly string[]).includes(key) &&
          !(ERROR_LISTS as readonly string[]).includes(key)) {
        fail(`errors ${name}: unknown expect key ${key}`);
      }
    }
    if (typeof given.kind !== "string" || typeof given.type !== "string") {
      fail(`errors ${name}: expect needs kind and type`);
    }
    const expect: Obj = { kind: given.kind };
    for (const key of ERROR_FIELDS) expect[key] = given[key] ?? null;
    for (const key of ERROR_LISTS) expect[key] = (given[key] as Json[] | undefined) ?? [];
    return {
      name,
      status: item.status as number,
      headers: headers(item),
      body: bodyText(item, `errors ${name}`),
      expect,
    };
  });
}

function responses(): Obj[] {
  return (load("responses.json").cases as Obj[]).map((item) => {
    const name = item.name as string;
    if (item.endpoint !== "search") fail(`responses ${name}: endpoint must be search`);
    const given = item.expect as Obj;
    return {
      name,
      endpoint: item.endpoint,
      arg: item.arg as string,
      status: (item.status as number | undefined) ?? 200,
      headers: headers(item),
      body: bodyText(item, `responses ${name}`),
      expect: typeof given.error === "string" ? given : { error: null, warnings: [], usage: null, ...given },
      skip: (item.skip as Obj | undefined) ?? {},
    };
  });
}

function billing(): Obj[] {
  return (load("billing.json").cases as Obj[]).map((item) => {
    const name = item.name as string;
    if (typeof item.keyed !== "boolean") fail(`billing ${name}: keyed must be true or false`);
    const given = item.expect as Obj;
    if (typeof given.path !== "string") fail(`billing ${name}: expect needs a path`);
    if (("error" in given) === ("billing" in given)) fail(`billing ${name}: give exactly one of "error" and "billing"`);
    return {
      name,
      keyed: item.keyed,
      status: (item.status as number | undefined) ?? 200,
      headers: headers(item),
      body: bodyText(item, `billing ${name}`),
      expect: {
        path: given.path,
        error: (given.error as Json | undefined) ?? null,
        request_id: (given.request_id as Json | undefined) ?? null,
        billing: (given.billing as Json | undefined) ?? null,
      },
    };
  });
}

const OPTIONS = new Set(["max_retries", "timeout", "headers", "query", "url", "disable_cards"]);

function options(): Obj[] {
  return (load("options.json").cases as Obj[]).map((item) => {
    const name = item.name as string;
    if (!OPTIONS.has(item.option as string)) fail(`options ${name}: unknown option`);
    if (item.scope !== "client" && item.scope !== "call") fail(`options ${name}: unknown scope`);
    return {
      name,
      option: item.option as string,
      scope: item.scope,
      value: item.value ?? null,
      valid: item.valid as boolean,
      skip: (item.skip as Obj | undefined) ?? {},
    };
  });
}

function searchBodies(): Obj[] {
  return (load("search-body.json").cases as Obj[]).map((item) => ({
    name: item.name as string,
    query: (item.query as string | undefined) ?? "q",
    options: item.options as Obj,
    sent: item.sent as Obj,
    skip: (item.skip as Obj | undefined) ?? {},
  }));
}

function toolCalls(): Obj[] {
  return (load("tool-call.json").cases as Obj[]).map((item) => {
    const name = item.name as string;
    if (("args" in item) === ("text" in item)) fail(`tool_call ${name}: give exactly one of "args" and "text"`);
    if (("sent" in item) === (item.invalid === true)) fail(`tool_call ${name}: give exactly one of "sent" and "invalid"`);
    return {
      name,
      arguments: "text" in item ? (item.text as string) : JSON.stringify(item.args),
      sent: (item.sent as Json | undefined) ?? null,
      invalid: item.invalid === true,
    };
  });
}

const DEADLINE_PHASES = new Set(["headers", "body", "terminator", "none"]);

function deadline(): Obj {
  const source = load("deadline.json");
  if (typeof source.slack !== "number") fail("deadline: needs a numeric slack");
  return {
    slack: source.slack,
    cases: (source.cases as Obj[]).map((item) => {
      const name = item.name as string;
      if (!DEADLINE_PHASES.has(item.phase as string)) fail(`deadline ${name}: unknown phase`);
      if (item.outcome !== "timeout" && item.outcome !== "success") fail(`deadline ${name}: unknown outcome`);
      for (const key of ["timeout", "interval", "pieces"]) {
        if (typeof item[key] !== "number") fail(`deadline ${name}: "${key}" must be a number`);
      }
      return {
        name,
        phase: item.phase as string,
        timeout: item.timeout as number,
        interval: item.interval as number,
        pieces: item.pieces as number,
        outcome: item.outcome as string,
        skip: (item.skip as Obj | undefined) ?? {},
      };
    }),
  };
}

const WEBHOOK_HEADERS = ["webhook-id", "webhook-timestamp", "webhook-signature"];

function webhooks(): Obj[] {
  const source = load("webhook.json");
  return (source.cases as Obj[]).map((item) => {
    const name = item.name as string;
    const given = (item.headers as Record<string, string | null> | undefined) ?? {};
    for (const key of Object.keys(given)) {
      if (!WEBHOOK_HEADERS.includes(key)) fail(`webhook ${name}: unknown header ${key}`);
    }
    const values: Record<string, string | null> = {
      "webhook-id": source.id as string,
      "webhook-timestamp": source.timestamp as string,
      "webhook-signature": ((item.signature ?? source.signature) as string),
      ...given,
    };
    const upper = item.header_case === "upper";
    const sent: Record<string, string> = {};
    for (const [key, value] of Object.entries(values)) {
      if (value !== null) sent[upper ? key.toUpperCase() : key] = value;
    }
    if (item.valid === true && typeof item.type !== "string") fail(`webhook ${name}: a valid case names its type`);
    return {
      name,
      secret: (item.secret ?? source.secret) as string,
      headers: sent,
      body: (item.body ?? source.body) as string,
      now: (item.now ?? source.now) as number,
      tolerance: (item.tolerance as number | undefined) ?? 300,
      valid: item.valid as boolean,
      type: (item.type as string | undefined) ?? null,
    };
  });
}

/** The fixture's exact text for the case files on disk. */
export function buildConformance(): string {
  const fixture = {
    _comment:
      "Generated by scripts/conformance/sync.ts from scripts/conformance/cases/*.json; do not edit. Every SDK runs every case: see scripts/conformance/README.md for what each section means. Kept identical in go/testdata, python/tests/fixtures and typescript/test/fixtures.",
    fetch_url: fetchUrls(),
    base_url: baseUrls(),
    retry_after: retryAfter(),
    retry: retries(),
    errors: errors(),
    responses: responses(),
    billing: billing(),
    options: options(),
    search_body: searchBodies(),
    tool_call: toolCalls(),
    deadline: deadline(),
    webhook: webhooks(),
  };
  for (const [section, cases] of Object.entries(fixture)) {
    if (Array.isArray(cases)) uniqueNames(section, cases as { name: string }[]);
  }
  uniqueNames("retry_after", fixture.retry_after.cases as { name: string }[]);
  uniqueNames("deadline", fixture.deadline.cases as { name: string }[]);
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

function main(args: string[]): number {
  const check = args.includes("--check");
  const want = buildConformance();
  const stale = FIXTURE_PATHS.filter((path) => {
    try {
      return readFileSync(path, "utf8") !== want;
    } catch {
      return true;
    }
  });
  if (check) {
    for (const path of stale) console.error(`out of date: ${path}`);
    if (stale.length) console.error("Run: node scripts/conformance/sync.ts");
    return stale.length ? 1 : 0;
  }
  for (const path of FIXTURE_PATHS) writeFileSync(path, want);
  console.log(`Wrote ${FIXTURE_PATHS.length} fixtures (${stale.length} changed).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
