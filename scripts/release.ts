/**
 * One-command SDK release.
 *
 *   node scripts/release.ts <python|typescript|go|all> [patch|minor|major|X.Y.Z] [--yes] [--dry-run]
 *
 * `all` releases the three SDKs together at one shared version (the highest
 * current one, bumped), in one PR.
 *
 * Runs on your own `gh` login, so the release PR is authored by you and the
 * Qodo bridge approves it like any other PR (see
 * .github/workflows/cut-sdk-release.yml for why the workflow doesn't open it).
 *   1. dispatches "Cut SDK release" on main (bumps the version files and
 *      changelogs on a release/<sdk>-vX.Y.Z branch and runs the tests on it)
 *   2. opens the PR as you, waits for the tests and approval, squash-merges the
 *      exact commit the tests ran on
 *   3. waits for the tag job and each publish workflow (PyPI / npm + GitHub
 *      Release assets) or the go/v<version> tag, and prints where each landed
 * Nothing is built or pushed from this machine. Needs Node 22.18+ (it runs this
 * file as TypeScript) and `gh`.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const REPO = "keenableai/keenable-sdk";
type Sdk = "python" | "typescript" | "go";
type Target = Sdk | "all";
const ALL: Sdk[] = ["python", "typescript", "go"];

interface SdkConfig {
  file: string;
  read: (text: string) => string;
  tag: string;
  publish?: string;
  url: (v: string) => string;
  allowed: RegExp;
}

const SDKS: Record<Sdk, SdkConfig> = {
  python: {
    allowed: /^python\/(pyproject\.toml|keenable\/_version\.py|CHANGELOG\.md)$/,
    file: "python/pyproject.toml",
    read: (t) => /^version = "(.*)"$/m.exec(t)?.[1] ?? "",
    tag: "python-v",
    publish: "publish-python.yml",
    url: (v) => `https://pypi.org/project/keenable/${v}/`,
  },
  typescript: {
    allowed: /^typescript\/(package\.json|package-lock\.json|CHANGELOG\.md)$/,
    file: "typescript/package.json",
    read: (t) => (JSON.parse(t) as { version: string }).version,
    tag: "ts-v",
    publish: "publish-typescript.yml",
    url: (v) => `https://www.npmjs.com/package/keenable/v/${v}`,
  },
  go: {
    allowed: /^go\/(version\.go|CHANGELOG\.md)$/,
    file: "go/version.go",
    read: (t) => /^const Version = "(.*)"$/m.exec(t)?.[1] ?? "",
    tag: "go/v",
    url: (v) => `go get github.com/keenableai/keenable-sdk/go@v${v}`,
  },
};

function gh(args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function ghTry(args: string[]): string | undefined {
  try {
    return gh(args);
  } catch {
    return undefined;
  }
}

const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const log = (m: string) => console.log(`\x1b[1m==>\x1b[0m ${m}`);
function die(m: string): never {
  console.error(`\x1b[31merror:\x1b[0m ${m}`);
  process.exit(1);
}

/** -1, 0 or 1 comparing two X.Y.Z versions numerically. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** [major, minor, patch] of an X.Y.Z version. */
function parts(v: string): number[] {
  return v.split(".").map(Number);
}

/** The highest of some X.Y.Z versions. */
export function highestVersion(versions: string[]): string {
  return versions.reduce((hi, v) => (compareVersions(v, hi) > 0 ? v : hi));
}

/** The next version for a bump keyword or an explicit X.Y.Z. */
export function nextVersion(cur: string, bump: string): string {
  const [maj = 0, min = 0, pat = 0] = parts(cur);
  if (bump === "patch") return `${maj}.${min}.${pat + 1}`;
  if (bump === "minor") return `${maj}.${min + 1}.0`;
  if (bump === "major") return `${maj + 1}.0.0`;
  if (!/^\d+\.\d+\.\d+$/.test(bump)) die("bump must be patch, minor, major or X.Y.Z (no prerelease suffix)");
  return bump;
}

/** The entries under `## <version>` in a changelog, up to the next `## ` heading. */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const start = lines.indexOf(`## ${version}`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim();
}

interface Check {
  __typename?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  name?: string;
  workflowName?: string;
  context?: string;
  startedAt?: string;
}

/** A run that hasn't started has no (or a zero) startedAt: rank it newest, so a re-queued run counts as pending. */
function startedRank(c: Check): string {
  return !c.startedAt || c.startedAt.startsWith("0001") ? "9999" : c.startedAt;
}

/**
 * The newest entry per check. The rollup lists every run on the head commit,
 * including ones a newer run replaced (a retried release re-dispatches the
 * tests on the same commit), and an old failure must not outvote the new pass.
 */
export function newestPerCheck(checks: Check[]): Check[] {
  const newest = new Map<string, Check>();
  for (const c of checks) {
    const key = c.__typename === "StatusContext" ? `ctx:${c.context}` : `run:${c.workflowName ?? ""}/${c.name ?? ""}`;
    const seen = newest.get(key);
    if (!seen || startedRank(c) > startedRank(seen)) newest.set(key, c);
  }
  return [...newest.values()];
}

/** Counts of a PR's checks: all, still running, and failed (cancelled and timed out count). */
export function summarizeChecks(all: Check[]): { total: number; pending: number; failed: number } {
  const checks = newestPerCheck(all);
  const isContext = (c: Check) => c.__typename === "StatusContext";
  const pending = checks.filter((c) => (isContext(c) ? c.state === "PENDING" : c.status !== "COMPLETED")).length;
  const bad = ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  const failed = checks.filter((c) =>
    isContext(c) ? c.state === "FAILURE" || c.state === "ERROR" : c.status === "COMPLETED" && bad.includes(c.conclusion ?? ""),
  ).length;
  return { total: checks.length, pending, failed };
}

type Outcome = { state: "ok"; detail: string } | { state: "failed"; detail: string } | { state: "pending" };

/** Where one SDK's publish stands after the merge. */
function publishOutcome(sdk: Sdk, next: string, mergedAt: number): Outcome {
  const cfg = SDKS[sdk];
  const tag = `${cfg.tag}${next}`;
  const timedOut = Date.now() - mergedAt > 15 * 60 * 1000;
  if (!cfg.publish) {
    if (ghTry(["api", `repos/${REPO}/git/ref/tags/${tag}`]) !== undefined) return { state: "ok", detail: `tagged ${tag}: ${cfg.url(next)}` };
    return timedOut ? { state: "failed", detail: `no ${tag} tag after 15 min; the tag job may have failed: https://github.com/${REPO}/actions/workflows/cut-sdk-release.yml` } : { state: "pending" };
  }
  const raw = ghTry(["run", "list", "--repo", REPO, "--workflow", cfg.publish, "--branch", tag, "--json", "databaseId,status,conclusion"]);
  const list = raw ? (JSON.parse(raw) as { databaseId: number; status: string; conclusion: string }[]) : [];
  if (list.some((r) => r.conclusion === "success")) return { state: "ok", detail: `published: ${cfg.url(next)}` };
  if (list.length === 0) {
    return timedOut ? { state: "failed", detail: `no ${cfg.publish} run for ${tag} after 15 min; the tag job may have failed: https://github.com/${REPO}/actions/workflows/cut-sdk-release.yml` } : { state: "pending" };
  }
  if (!list.every((r) => r.status === "completed")) return { state: "pending" };
  // Every run finished and none succeeded as a whole. The registry and the
  // GitHub assets are separate jobs, so say how each channel went rather than
  // inferring one from the run's overall conclusion.
  const id = list[0]?.databaseId;
  const raw2 = ghTry(["run", "view", String(id), "--repo", REPO, "--json", "jobs"]);
  const jobs = raw2 ? (JSON.parse(raw2) as { jobs: { name: string; conclusion: string }[] }).jobs : [];
  const channel = (prefix: string) => jobs.find((j) => j.name.startsWith(prefix))?.conclusion ?? "not run";
  const registry = channel("Publish to");
  const assets = channel("Attach to");
  const where = `https://github.com/${REPO}/actions/runs/${id}`;
  return { state: "failed", detail: `${tag}: registry ${registry}, GitHub assets ${assets} (${cfg.publish}; re-run the failed job: ${where})` };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const [targetArg, bumpArg = "patch"] = args.filter((a) => !a.startsWith("-"));
  const usage = "usage: node scripts/release.ts <python|typescript|go|all> [patch|minor|major|X.Y.Z] [--yes] [--dry-run]";
  if (flags.has("--help") || flags.has("-h") || !targetArg) {
    console.log(usage);
    process.exit(targetArg ? 0 : 1);
  }
  if (targetArg !== "all" && !(targetArg in SDKS)) die(`sdk must be python, typescript, go or all (got ${targetArg})`);
  const target = targetArg as Target;
  const sdks: Sdk[] = target === "all" ? ALL : [target];
  if (ghTry(["auth", "status"]) === undefined) die("run: gh auth login");

  const cur = new Map<Sdk, string>();
  for (const s of sdks) {
    const v = SDKS[s].read(gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/${SDKS[s].file}?ref=main`]));
    if (!v) die(`could not read the ${s} version from ${SDKS[s].file}`);
    cur.set(s, v);
  }
  const curOf = (s: Sdk): string => cur.get(s) ?? "";
  const next = nextVersion(highestVersion(sdks.map(curOf)), bumpArg);
  for (const s of sdks) {
    if (compareVersions(next, curOf(s)) <= 0) die(`${s} is at ${curOf(s)}, which is not below ${next}`);
  }
  const branch = `release/${target}-v${next}`;
  log(`keenable ${sdks.map((s) => `${s} ${curOf(s)}`).join(", ")} -> ${next} (branch ${branch})`);
  if (flags.has("--dry-run")) return;

  if (!flags.has("--yes") && !flags.has("-y")) {
    if (!process.stdin.isTTY) die("not a terminal; pass --yes to release without asking");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(`Release ${target} ${next} now? [y/N] `);
    rl.close();
    if (!/^y/i.test(ans)) die("cancelled");
  }

  log("dispatching Cut SDK release");
  const start = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  gh(["workflow", "run", "cut-sdk-release.yml", "--repo", REPO, "--ref", "main", "-f", `sdk=${target}`, "-f", `bump=${next}`]);
  let run = "";
  for (let i = 0; i < 30 && !run; i++) {
    // The run title carries the SDK and version (run-name), so a concurrent
    // release of another SDK or version can't be mistaken for ours.
    run =
      ghTry([
        "run", "list", "--repo", REPO, "--workflow", "cut-sdk-release.yml", "--event", "workflow_dispatch", "--limit", "20",
        "--json", "databaseId,displayTitle,createdAt", "--jq",
        `[.[] | select(.displayTitle == "Cut SDK release ${target} ${next}" and .createdAt >= "${start}")][0].databaseId // empty`,
      ]) ?? "";
    if (!run) await sleep(2);
  }
  if (!run) die("could not find the dispatched run; check the Actions tab");
  if (ghTry(["run", "watch", run, "--repo", REPO, "--exit-status"]) === undefined) {
    die(`Cut SDK release failed: https://github.com/${REPO}/actions/runs/${run}`);
  }

  // The workflow dispatches the tests on the branch. The ruleset requires no
  // status checks, so a CLEAN PR does not mean the tests ran: wait for that run.
  log(`waiting for the tests on ${branch}`);
  let tests = "";
  for (let i = 0; i < 30 && !tests; i++) {
    tests =
      ghTry([
        "run", "list", "--repo", REPO, "--workflow", "test.yml", "--branch", branch, "--event", "workflow_dispatch", "--limit", "5",
        "--json", "databaseId,createdAt", "--jq", `[.[] | select(.createdAt >= "${start}")][0].databaseId // empty`,
      ]) ?? "";
    if (!tests) await sleep(2);
  }
  if (!tests) die(`the tests were not dispatched on ${branch}; check the Actions tab`);
  if (ghTry(["run", "watch", tests, "--repo", REPO, "--exit-status"]) === undefined) {
    die(`the tests failed on ${branch}: https://github.com/${REPO}/actions/runs/${tests}`);
  }
  const testedSha = gh(["run", "view", tests, "--repo", REPO, "--json", "headSha", "--jq", ".headSha"]);

  const me = gh(["api", "user", "--jq", ".login"]);
  let pr = ghTry(["pr", "list", "--repo", REPO, "--head", branch, "--state", "open", "--json", "number", "--jq", ".[0].number // empty"]);
  if (pr) {
    // Someone else's PR on our branch name is not ours to merge.
    const author = gh(["pr", "view", pr, "--repo", REPO, "--json", "author", "--jq", ".author.login"]);
    if (author !== me) die(`PR #${pr} on ${branch} is authored by ${author}, not you; check it, close it, and re-run`);
  }
  if (!pr) {
    log("opening the PR");
    const notes = sdks
      .map((s) => {
        const changelog = ghTry(["api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/${s}/CHANGELOG.md?ref=${branch}`]) ?? "";
        const section = changelogSection(changelog, next);
        return sdks.length > 1 ? `### ${s}\n\n${section}` : section;
      })
      .join("\n\n");
    const tags = sdks.map((s) => `\`${SDKS[s].tag}${next}\``).join(", ");
    const body = `Bumps ${sdks.map((s) => `the ${s} SDK ${curOf(s)}`).join(", ")} -> ${next}. Merging tags ${tags} and publishes.\n\n${notes}`;
    pr = gh(["pr", "create", "--repo", REPO, "--base", "main", "--head", branch, "--title", `chore: release ${target} ${next}`, "--body", body]).split("/").pop()!;
  }

  log(`PR #${pr}: waiting for checks and approval`);
  let state = "";
  let counts = { total: 0, pending: 1, failed: 0 };
  for (let i = 0; i < 90; i++) {
    // Opening the PR starts its own checks, which the ruleset doesn't require:
    // a failure there must stop us, a run still going must be waited for, and
    // at least one must have appeared. One read, so a failed query throws
    // instead of passing as "nothing pending".
    const snap = JSON.parse(gh(["pr", "view", pr, "--repo", REPO, "--json", "statusCheckRollup,mergeStateStatus"])) as {
      statusCheckRollup: Check[];
      mergeStateStatus: string;
    };
    state = snap.mergeStateStatus;
    counts = summarizeChecks(snap.statusCheckRollup);
    if (counts.failed > 0) die(`a check failed: https://github.com/${REPO}/pull/${pr}/checks`);
    if (state === "CLEAN" && counts.total > 0 && counts.pending === 0) break;
    if (state === "DIRTY" || state === "BEHIND") die(`PR #${pr} is ${state}; resolve it, then re-run`);
    await sleep(20);
  }
  if (state !== "CLEAN" || counts.total === 0 || counts.pending > 0) {
    die(`PR #${pr} is not mergeable yet (${state}, ${counts.total} checks, ${counts.pending} pending): https://github.com/${REPO}/pull/${pr}`);
  }

  // Merge exactly what was checked: only the release files of these SDKs, at
  // the head we saw, which must be the commit the tests ran on.
  const head = gh(["pr", "view", pr, "--repo", REPO, "--json", "headRefOid", "--jq", ".headRefOid"]);
  if (head !== testedSha) die(`the tests ran on ${testedSha.slice(0, 7)} but PR #${pr} head is ${head.slice(0, 7)}; the branch changed after the tests started, re-run`);
  const files = gh(["api", `repos/${REPO}/pulls/${pr}/files`, "--paginate", "--jq", ".[].filename"]).split("\n").filter(Boolean);
  const extra = files.filter((f) => !sdks.some((s) => SDKS[s].allowed.test(f)));
  if (extra.length > 0) die(`PR #${pr} changes more than the release files (${extra.join(", ")}); review it, then merge by hand`);

  log(`merging PR #${pr}`);
  gh(["pr", "merge", pr, "--repo", REPO, "--squash", "--delete-branch", "--match-head-commit", head]);

  log(`waiting for ${sdks.map((s) => `${SDKS[s].tag}${next}`).join(", ")}`);
  const mergedAt = Date.now();
  const done = new Map<Sdk, Outcome>();
  for (let i = 0; i < 360 && done.size < sdks.length; i++) {
    for (const s of sdks) {
      if (done.has(s)) continue;
      const o = publishOutcome(s, next, mergedAt);
      if (o.state !== "pending") {
        done.set(s, o);
        log(`${s}: ${o.state === "ok" ? "" : "FAILED: "}${o.detail}`);
      }
    }
    if (done.size < sdks.length) await sleep(10);
  }
  const pending = sdks.filter((s) => !done.has(s));
  if (pending.length > 0) die(`${pending.join(", ")} not published after 60 min: https://github.com/${REPO}/actions`);
  if ([...done.values()].some((o) => o.state === "failed")) process.exit(1);
}

// Run only when executed directly, so the pure helpers can be imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
