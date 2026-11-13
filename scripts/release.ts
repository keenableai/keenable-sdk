/**
 * One-command SDK release.
 *
 *   node scripts/release.ts <python|typescript|go> [patch|minor|major|X.Y.Z] [--yes] [--dry-run]
 *
 * Runs on your own `gh` login, so the release PR is authored by you and the
 * Qodo bridge approves it like any other PR (see
 * .github/workflows/cut-sdk-release.yml for why the workflow doesn't open it).
 *   1. dispatches "Cut SDK release" on main (bumps the SDK's version files and
 *      changelog on a release/<sdk>-vX.Y.Z branch and runs the tests on it)
 *   2. opens the PR as you, waits for checks and approval, squash-merges it
 *   3. waits for the tag job and the publish workflow (PyPI / npm), or the
 *      go/v<version> tag, and prints where it landed
 * Nothing is built or pushed from this machine. Needs Node 22.18+ (it runs this
 * file as TypeScript) and `gh`.
 */
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";

const REPO = "keenableai/keenable-sdk";
type Sdk = "python" | "typescript" | "go";

const SDKS: Record<
  Sdk,
  { file: string; read: (text: string) => string; tag: string; publish?: string; url: (v: string) => string }
> = {
  python: {
    file: "python/pyproject.toml",
    read: (t) => /^version = "(.*)"$/m.exec(t)?.[1] ?? "",
    tag: "python-v",
    publish: "publish-python.yml",
    url: (v) => `https://pypi.org/project/keenable/${v}/`,
  },
  typescript: {
    file: "typescript/package.json",
    read: (t) => (JSON.parse(t) as { version: string }).version,
    tag: "ts-v",
    publish: "publish-typescript.yml",
    url: (v) => `https://www.npmjs.com/package/keenable/v/${v}`,
  },
  go: {
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

/** The next version for a bump keyword or an explicit X.Y.Z. */
export function nextVersion(cur: string, bump: string): string {
  const [maj, min, pat] = cur.split(".").map(Number);
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("-")));
  const [sdkArg, bumpArg = "patch"] = args.filter((a) => !a.startsWith("-"));
  if (flags.has("--help") || flags.has("-h") || !sdkArg) {
    console.log("usage: node scripts/release.ts <python|typescript|go> [patch|minor|major|X.Y.Z] [--yes] [--dry-run]");
    process.exit(sdkArg ? 0 : 1);
  }
  if (!(sdkArg in SDKS)) die(`sdk must be python, typescript or go (got ${sdkArg})`);
  const sdk = sdkArg as Sdk;
  const cfg = SDKS[sdk];
  if (ghTry(["auth", "status"]) === undefined) die("run: gh auth login");

  const cur = cfg.read(gh(["api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/${cfg.file}?ref=main`]));
  if (!cur) die(`could not read the ${sdk} version from ${cfg.file}`);
  const next = nextVersion(cur, bumpArg);
  const branch = `release/${sdk}-v${next}`;
  const tag = `${cfg.tag}${next}`;
  log(`keenable ${sdk} ${cur} -> ${next} (branch ${branch}, tag ${tag})`);
  if (flags.has("--dry-run")) return;

  if (!flags.has("--yes") && !flags.has("-y")) {
    if (!process.stdin.isTTY) die("not a terminal; pass --yes to release without asking");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = await rl.question(`Release ${sdk} ${next} now? [y/N] `);
    rl.close();
    if (!/^y/i.test(ans)) die("cancelled");
  }

  log("dispatching Cut SDK release");
  const start = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  gh(["workflow", "run", "cut-sdk-release.yml", "--repo", REPO, "--ref", "main", "-f", `sdk=${sdk}`, "-f", `bump=${next}`]);
  let run = "";
  for (let i = 0; i < 30 && !run; i++) {
    run =
      ghTry([
        "run", "list", "--repo", REPO, "--workflow", "cut-sdk-release.yml", "--event", "workflow_dispatch", "--limit", "5",
        "--json", "databaseId,createdAt", "--jq", `[.[] | select(.createdAt >= "${start}")][0].databaseId // empty`,
      ]) ?? "";
    if (!run) await sleep(2);
  }
  if (!run) die("could not find the dispatched run; check the Actions tab");
  if (ghTry(["run", "watch", run, "--repo", REPO, "--exit-status"]) === undefined) {
    die(`Cut SDK release failed: https://github.com/${REPO}/actions/runs/${run}`);
  }

  let pr = ghTry(["pr", "list", "--repo", REPO, "--head", branch, "--state", "open", "--json", "number", "--jq", ".[0].number // empty"]);
  if (!pr) {
    log("opening the PR");
    const changelog = ghTry(["api", "-H", "Accept: application/vnd.github.raw", `repos/${REPO}/contents/${sdk}/CHANGELOG.md?ref=${branch}`]) ?? "";
    const notes = changelogSection(changelog, next);
    const body = `Bumps the ${sdk} SDK ${cur} -> ${next}. Merging tags \`${tag}\` and publishes it.\n\n${notes}`;
    pr = gh(["pr", "create", "--repo", REPO, "--base", "main", "--head", branch, "--title", `chore: release ${sdk} ${next}`, "--body", body]).split("/").pop()!;
  }

  log(`PR #${pr}: waiting for checks and approval`);
  let state = "";
  for (let i = 0; i < 90; i++) {
    const failed = ghTry(["pr", "checks", pr, "--repo", REPO, "--json", "bucket", "--jq", '[.[] | select(.bucket == "fail")] | length']) ?? "0";
    if (failed !== "0") die(`a check failed: https://github.com/${REPO}/pull/${pr}/checks`);
    state = gh(["pr", "view", pr, "--repo", REPO, "--json", "mergeStateStatus", "--jq", ".mergeStateStatus"]);
    if (state === "CLEAN") break;
    if (state === "DIRTY" || state === "BEHIND") die(`PR #${pr} is ${state}; resolve it, then re-run`);
    await sleep(20);
  }
  if (state !== "CLEAN") die(`PR #${pr} is not mergeable yet (${state}): https://github.com/${REPO}/pull/${pr}`);

  log(`merging PR #${pr}`);
  gh(["pr", "merge", pr, "--repo", REPO, "--squash", "--delete-branch"]);

  log(`waiting for ${tag}${cfg.publish ? ` and ${cfg.publish}` : ""}`);
  for (let i = 0; i < 360; i++) {
    if (cfg.publish) {
      const runs = ghTry(["run", "list", "--repo", REPO, "--workflow", cfg.publish, "--branch", tag, "--json", "status,conclusion"]);
      const list = runs ? (JSON.parse(runs) as { status: string; conclusion: string }[]) : [];
      if (list.some((r) => r.conclusion === "success")) {
        log(`published: ${cfg.url(next)}`);
        return;
      }
      if (list.length > 0 && list.every((r) => r.status === "completed")) {
        die(`${cfg.publish} failed for ${tag}: https://github.com/${REPO}/actions/workflows/${cfg.publish}`);
      }
    } else if (ghTry(["api", `repos/${REPO}/git/ref/tags/${tag}`]) !== undefined) {
      log(`tagged ${tag}: ${cfg.url(next)}`);
      return;
    }
    await sleep(10);
  }
  die(`${tag} is not published after 60 min: https://github.com/${REPO}/actions`);
}

// Run only when executed directly, so the pure helpers can be imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  await main();
}
