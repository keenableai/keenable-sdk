/**
 * Release tooling for all three SDKs. They share one version, written in the
 * root `VERSION` file and copied into each package:
 *
 *   python/pyproject.toml           version = "X.Y.Z"
 *   python/keenable/_version.py     __version__ = "X.Y.Z"
 *   typescript/package.json         "version": "X.Y.Z"
 *   go/version.go                   const Version = "X.Y.Z"
 *
 * Commands (Node 22.18+, which runs this file as TypeScript):
 *
 *   node scripts/release/release.ts check
 *       Exit 1 unless every package carries the VERSION file's version.
 *
 *   node scripts/release/release.ts prepare <patch|minor|major|X.Y.Z[-pre.N]>
 *       Bump VERSION and every package, and move each CHANGELOG's
 *       "Unreleased" section under the new version. An SDK with nothing under
 *       "Unreleased" gets the commits that touched its directory since the
 *       last release, so its entry is never blank. Writes files only; review,
 *       commit and merge them, and CI tags and publishes the release.
 *
 *   node scripts/release/release.ts notes [X.Y.Z]
 *       Print the GitHub Release body for a version (default: VERSION): the
 *       install lines, each SDK's changelog section and the commits since the
 *       previous release.
 *
 *   node scripts/release/release.ts status
 *       Show the latest published version on PyPI, npm and the Go module
 *       proxy next to VERSION.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_URL = "https://github.com/keenableai/keenable-sdk";

/** Strict semver: X.Y.Z with an optional -prerelease. No build metadata. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** One place a version is written: the file and how to read and replace it. */
interface VersionSite {
  file: string;
  pattern: RegExp; // group 1 is the version
  render: (version: string) => string;
}

export const SITES: VersionSite[] = [
  {
    file: "python/pyproject.toml",
    pattern: /^version = "([^"]+)"$/m,
    render: (v) => `version = "${v}"`,
  },
  {
    file: "python/keenable/_version.py",
    pattern: /^__version__ = "([^"]+)"$/m,
    render: (v) => `__version__ = "${v}"`,
  },
  {
    file: "typescript/package.json",
    pattern: /^ {2}"version": "([^"]+)",$/m,
    render: (v) => `  "version": "${v}",`,
  },
  {
    file: "go/version.go",
    pattern: /^const Version = "([^"]+)"$/m,
    render: (v) => `const Version = "${v}"`,
  },
];

export interface Sdk {
  name: string;
  dir: string;
  tagPrefix: string;
  install: (version: string) => string;
}

export const SDKS: Sdk[] = [
  {
    name: "Python",
    dir: "python",
    tagPrefix: "python-v",
    install: (v) => `pip install keenable==${v}`,
  },
  {
    name: "TypeScript",
    dir: "typescript",
    tagPrefix: "ts-v",
    install: (v) => `npm install keenable@${v}`,
  },
  {
    name: "Go",
    dir: "go",
    tagPrefix: "go/v",
    install: (v) => `go get github.com/keenableai/keenable-sdk/go@v${v}`,
  },
];

const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const write = (rel: string, text: string) => writeFileSync(join(ROOT, rel), text);

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function gitOrEmpty(...args: string[]): string {
  try {
    return git(...args);
  } catch {
    return "";
  }
}

export function readVersionFile(): string {
  const v = read("VERSION").trim();
  if (!SEMVER.test(v)) throw new Error(`VERSION holds "${v}", which is not X.Y.Z`);
  return v;
}

function parse(v: string): [number, number, number, string | undefined] {
  const m = SEMVER.exec(v);
  if (!m) throw new Error(`"${v}" is not a version (X.Y.Z or X.Y.Z-pre.N)`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4]];
}

/** Semver precedence: -1, 0 or 1. */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return (pa[i] as number) < (pb[i] as number) ? -1 : 1;
  }
  const [ra, rb] = [pa[3], pb[3]];
  if (ra === rb) return 0;
  if (ra === undefined) return 1; // a release outranks its prereleases
  if (rb === undefined) return -1;
  const xa = ra.split(".");
  const xb = rb.split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    if (xa[i] === xb[i]) continue;
    const na = /^\d+$/.test(xa[i]!);
    const nb = /^\d+$/.test(xb[i]!);
    if (na && nb) return Number(xa[i]) < Number(xb[i]) ? -1 : 1;
    if (na !== nb) return na ? -1 : 1;
    return xa[i]! < xb[i]! ? -1 : 1;
  }
  return 0;
}

/** The version after `current` for a bump keyword, or an explicit version. */
export function nextVersion(current: string, bump: string): string {
  const [major, minor, patch, pre] = parse(current);
  let next: string;
  switch (bump) {
    case "patch":
      // 1.2.3-rc.1 + patch = 1.2.3: finishing the prerelease.
      next = pre ? `${major}.${minor}.${patch}` : `${major}.${minor}.${patch + 1}`;
      break;
    case "minor":
      next = pre && patch === 0 ? `${major}.${minor}.0` : `${major}.${minor + 1}.0`;
      break;
    case "major":
      next = pre && minor === 0 && patch === 0 ? `${major}.0.0` : `${major + 1}.0.0`;
      break;
    default:
      next = bump.replace(/^v/, "");
      parse(next);
  }
  if (compareVersions(next, current) <= 0) {
    throw new Error(`${next} is not newer than the current version ${current}`);
  }
  return next;
}

export const isPrerelease = (v: string) => parse(v)[3] !== undefined;

/** Every site's current version, keyed by file. */
export function siteVersions(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const site of SITES) out[site.file] = site.pattern.exec(read(site.file))?.[1];
  return out;
}

const TAG_PATTERNS = ["v[0-9]*", ...SDKS.map((s) => `${s.tagPrefix}[0-9]*`)];

/** The newest release tag (of any SDK) reachable from `ref`, or "". */
function lastTag(ref: string): string {
  return gitOrEmpty(
    "describe",
    "--tags",
    "--abbrev=0",
    ...TAG_PATTERNS.flatMap((m) => ["--match", m]),
    ref,
  );
}

/** The release tag before `ref`: the newest one reachable from its parent. */
const previousTag = (ref: string) => lastTag(`${ref}^`);

/**
 * One "<hash> <title>" line per first-parent commit in (from, to], newest
 * first, without release commits. A GitHub merge commit is listed by its PR
 * title and number rather than "Merge pull request #N from branch".
 */
export function commitsBetween(from: string, to: string, path?: string): string[] {
  const range = from ? `${from}..${to}` : to;
  const log = gitOrEmpty(
    "log",
    "--first-parent",
    "--format=%h%x1f%s%x1f%b%x1e",
    range,
    ...(path ? ["--", path] : []),
  );
  const out: string[] = [];
  for (const record of log.split("\x1e")) {
    const [hash, subject, body] = record.trim().split("\x1f");
    if (!hash || !subject) continue;
    if (/^release: v/.test(subject)) continue;
    const merge = /^Merge pull request (#\d+)/.exec(subject);
    const title = merge ? `${(body ?? "").trim().split("\n")[0] || subject} (${merge[1]})` : subject;
    out.push(`${hash} ${title}`);
  }
  return out;
}

const UNRELEASED = /^## Unreleased[ \t]*\n/m;

/** The body of a `## <heading>` section, up to the next `## `. */
export function changelogSection(text: string, heading: string): string | undefined {
  const lines = text.split("\n");
  const start = lines.findIndex(
    (l) => l === `## ${heading}` || l.startsWith(`## ${heading} `),
  );
  if (start < 0) return undefined;
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}

/** Move "Unreleased" under `## <version> (<date>)` and open a new, empty one. */
export function rollChangelog(text: string, version: string, date: string, fallback: string): string {
  if (!UNRELEASED.test(text)) {
    throw new Error('the changelog has no "## Unreleased" heading');
  }
  const body = changelogSection(text, "Unreleased") ?? "";
  const heading = `## ${version} (${date})`;
  if (body) return text.replace(UNRELEASED, `## Unreleased\n\n${heading}\n`);
  return text.replace(UNRELEASED, `## Unreleased\n\n${heading}\n\n${fallback}\n`);
}

function prepare(bump: string | undefined): void {
  if (!bump) throw new Error("usage: release.ts prepare <patch|minor|major|X.Y.Z>");
  const current = readVersionFile();
  const next = nextVersion(current, bump);
  const date = new Date().toISOString().slice(0, 10);
  const since = lastTag("HEAD");

  write("VERSION", `${next}\n`);
  for (const site of SITES) {
    const text = read(site.file);
    if (!site.pattern.test(text)) throw new Error(`no version line in ${site.file}`);
    write(site.file, text.replace(site.pattern, site.render(next)));
  }
  for (const sdk of SDKS) {
    const file = `${sdk.dir}/CHANGELOG.md`;
    const commits = commitsBetween(since, "HEAD", sdk.dir);
    const fallback = commits.length
      ? commits.map((c) => `- ${c.replace(/^\S+ /, "")}`).join("\n")
      : `No changes to the ${sdk.name} SDK. Released at ${next} so all three SDKs share one version.`;
    write(file, rollChangelog(read(file), next, date, fallback));
  }

  console.log(`Prepared ${current} -> ${next}.`);
  console.log("");
  console.log("Next:");
  console.log("  1. Read the CHANGELOG entries and edit them if needed.");
  console.log(`  2. git checkout -b release/v${next} && git commit -am "release: v${next}"`);
  console.log(`  3. Open a PR. Merging it tags v${next}, creates the GitHub Release`);
  console.log(
    isPrerelease(next)
      ? "     (a prerelease: npm tag `next`, never Go's or pip's default) and publishes it."
      : "     (marked latest) and publishes to PyPI, npm and the Go proxy.",
  );
  console.log("  4. Update the install pins in keenable-external-docs if any are pinned.");
}

export function releaseNotes(version: string): string {
  const tag = `v${version}`;
  const end = gitOrEmpty("rev-parse", "--verify", "--quiet", `${tag}^{commit}`) ? tag : "HEAD";
  const prev = previousTag(end);
  const out: string[] = [];

  out.push("All three SDKs ship this release at the same version.", "");
  out.push("```bash");
  for (const sdk of SDKS) out.push(sdk.install(version));
  out.push("```", "");

  for (const sdk of SDKS) {
    const text = read(`${sdk.dir}/CHANGELOG.md`);
    const section = changelogSection(text, version);
    out.push(`## ${sdk.name}`, "");
    out.push(section || "_No changelog entry._", "");
  }

  const commits = commitsBetween(prev, end);
  if (commits.length) {
    out.push(`## Commits${prev ? ` since ${prev}` : ""}`, "");
    for (const c of commits) {
      const [hash, ...rest] = c.split(" ");
      out.push(`- ${rest.join(" ")} (${hash})`);
    }
    out.push("");
  }
  if (prev) out.push(`**Full diff:** ${REPO_URL}/compare/${prev}...${tag}`);
  return out.join("\n").trimEnd() + "\n";
}

function check(): void {
  const version = readVersionFile();
  const bad = Object.entries(siteVersions()).filter(([, v]) => v !== version);
  if (bad.length) {
    for (const [file, v] of bad) {
      console.error(`${file}: ${v ?? "no version found"} (VERSION says ${version})`);
    }
    console.error("Run `node scripts/release/release.ts prepare <bump>` rather than editing versions by hand.");
    process.exit(1);
  }
  console.log(`All SDKs are at ${version}.`);
}

async function latest(url: string, pick: (body: string) => string | undefined): Promise<string> {
  try {
    const res = await fetch(url);
    if (!res.ok) return `unavailable (HTTP ${res.status})`;
    return pick(await res.text()) ?? "none";
  } catch (err) {
    return `unavailable (${(err as Error).message})`;
  }
}

async function status(): Promise<void> {
  const version = readVersionFile();
  const [pypi, npm, go] = await Promise.all([
    latest("https://pypi.org/pypi/keenable/json", (b) => JSON.parse(b).info?.version),
    latest("https://registry.npmjs.org/keenable", (b) => JSON.parse(b)["dist-tags"]?.latest),
    latest("https://proxy.golang.org/github.com/keenableai/keenable-sdk/go/@latest", (b) =>
      String(JSON.parse(b).Version ?? "").replace(/^v/, "") || undefined,
    ),
  ]);
  console.log(`VERSION file   ${version}`);
  console.log(`PyPI latest    ${pypi}`);
  console.log(`npm latest     ${npm}`);
  console.log(`Go @latest     ${go}`);
}

async function main(argv: string[]): Promise<void> {
  const [cmd, arg] = argv;
  switch (cmd) {
    case "check":
      return check();
    case "prepare":
      return prepare(arg);
    case "notes":
      process.stdout.write(releaseNotes(arg ? arg.replace(/^v/, "") : readVersionFile()));
      return;
    case "status":
      return status();
    default:
      console.error("usage: release.ts <check|prepare <bump>|notes [version]|status>");
      process.exit(2);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}
