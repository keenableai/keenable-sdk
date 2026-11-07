/**
 * Builds the shared error-contract fixture from the backend's error catalog and
 * writes the same bytes to each SDK's test fixtures.
 *
 * The catalog (`error-catalog.json` here) is a vendored copy of
 * keenableai/keenable-backend-ts `docs/error-catalog.json`, written by its
 * `npm run errors:catalog`: one entry per error code with its type, status,
 * title, summary, fix, retryable and docs_url (Keenable error format v1).
 *
 *   node scripts/error-contract/sync.ts [path/to/error-catalog.json]
 *   node scripts/error-contract/sync.ts --check
 *
 * A path refreshes the vendored catalog first. `--check` writes nothing and
 * exits 1 when a fixture differs from what the catalog produces. Needs Node
 * 22.18+ (it runs this file as TypeScript); the TypeScript tests import it on
 * any supported Node.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One catalog entry, as the backend writes it. */
export interface CatalogEntry {
  code: string;
  type: string;
  status: number;
  title: string;
  summary: string;
  fix: string;
  retryable: boolean;
  docs_anchor: string;
  docs_url: string;
  since: string;
}

export interface ContractCase {
  name: string;
  source: string;
  status: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  expect: Record<string, unknown>;
}

const HERE = new URL("./", import.meta.url);
const ROOT = new URL("../../", HERE);

export const CATALOG_PATH = fileURLToPath(new URL("error-catalog.json", HERE));
export const BEFORE_V1_PATH = fileURLToPath(new URL("before-v1.json", HERE));

/** Each SDK's copy of the fixture. They are kept byte-identical. */
export const FIXTURE_PATHS = [
  "go/testdata/error_contract.json",
  "python/tests/fixtures/error_contract.json",
  "typescript/test/fixtures/error_contract.json",
].map((path) => fileURLToPath(new URL(path, ROOT)));

// The fields every SDK parses, in the order the spec lists them. Anything else
// a "before v1" case of the same code carries (limit, billing_url, keyless,
// ...) is a domain extra and is copied onto the catalog case after these.
const CORE_FIELDS = new Set([
  "error",
  "type",
  "code",
  "message",
  "fix",
  "param",
  "docs_url",
  "request_id",
  "retryable",
  "retry_after_seconds",
]);

/**
 * Which SDK error class a response becomes. Classes stay status-based, so old
 * handlers keep catching what they caught; a 401/403 about the fetched page
 * (type target_error) is not an authentication failure.
 */
function kindFor(status: number, type: string): string {
  if ((status === 401 || status === 403) && type !== "target_error") return "auth";
  if (status === 429) return "rate_limit";
  if (status === 402) return "insufficient_credits";
  return "api";
}

function catalogCase(entry: CatalogEntry, sameCode: ContractCase | undefined): ContractCase {
  const requestId = `req-${entry.code}`;
  const extras = Object.fromEntries(
    Object.entries(sameCode?.body ?? {}).filter(([key]) => !CORE_FIELDS.has(key)),
  );
  const param = typeof sameCode?.body.param === "string" ? sameCode.body.param : null;
  const earlierWait = sameCode?.body.retry_after_seconds;
  const retryAfter = entry.retryable ? (typeof earlierWait === "number" ? earlierWait : 1) : null;

  const headers: Record<string, string> = { "X-Request-Id": requestId };
  if (retryAfter !== null) headers["Retry-After"] = String(retryAfter);

  const body: Record<string, unknown> = {
    error: entry.title,
    type: entry.type,
    code: entry.code,
    message: entry.summary,
    fix: entry.fix,
  };
  if (param !== null) body.param = param;
  body.docs_url = entry.docs_url;
  body.request_id = requestId;
  body.retryable = entry.retryable;
  if (retryAfter !== null) body.retry_after_seconds = retryAfter;
  Object.assign(body, extras);

  const want = sameCode?.expect ?? {};
  return {
    name: entry.code,
    source: `keenable-backend-ts docs/error-catalog.json#${entry.code}`,
    status: entry.status,
    headers,
    body,
    expect: {
      kind: kindFor(entry.status, entry.type),
      code: entry.code,
      type: entry.type,
      retryable: entry.retryable,
      retry_after_seconds: retryAfter,
      request_id: requestId,
      param,
      docs_url: entry.docs_url,
      fix: entry.fix,
      limit: want.limit ?? null,
      billing_url: want.billing_url ?? null,
      auto_top_up_url: want.auto_top_up_url ?? null,
      pay_per_request: want.pay_per_request ?? null,
      message_contains: entry.summary,
    },
  };
}

/** The fixture's exact text for this catalog and these "before v1" cases. */
export function buildContract(catalog: CatalogEntry[], beforeV1: ContractCase[]): string {
  const byCode = (code: string) =>
    beforeV1.find((c) => c.name === `${code} (before v1)`) ??
    beforeV1.find((c) => c.body.code === code);
  const cases = [
    ...[...catalog]
      .sort((a, b) => a.code.localeCompare(b.code))
      .map((entry) => catalogCase(entry, byCode(entry.code))),
    ...beforeV1,
  ];
  const fixture = {
    _comment:
      "Generated by scripts/error-contract/sync.ts; do not edit. One case per code in keenable-backend-ts docs/error-catalog.json (error format v1: type, code, fix, docs_url and retryable from the catalog; error and message are its title and summary, which a route may word differently, and SDKs never parse them), with the domain extras of the \"before v1\" case of the same code. The \"(before v1)\" cases are bodies older servers send, without type; expect.type is what an SDK derives from the status and code. Kept identical in go/testdata, python/tests/fixtures and typescript/test/fixtures.",
    cases,
  };
  return `${JSON.stringify(fixture, null, 2)}\n`;
}

/** The fixture text for the vendored catalog and "before v1" cases on disk. */
export function contractFromDisk(): string {
  const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as CatalogEntry[];
  const beforeV1 = (JSON.parse(readFileSync(BEFORE_V1_PATH, "utf8")) as { cases: ContractCase[] })
    .cases;
  return buildContract(catalog, beforeV1);
}

function main(args: string[]): number {
  const check = args.includes("--check");
  const source = args.find((arg) => !arg.startsWith("--"));
  if (source && !check) writeFileSync(CATALOG_PATH, readFileSync(source));

  const want = contractFromDisk();
  const stale = FIXTURE_PATHS.filter((path) => {
    try {
      return readFileSync(path, "utf8") !== want;
    } catch {
      return true;
    }
  });
  if (check) {
    for (const path of stale) console.error(`out of date: ${path}`);
    if (stale.length) console.error("Run: node scripts/error-contract/sync.ts");
    return stale.length ? 1 : 0;
  }
  for (const path of FIXTURE_PATHS) writeFileSync(path, want);
  console.log(`Wrote ${FIXTURE_PATHS.length} fixtures (${stale.length} changed).`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
