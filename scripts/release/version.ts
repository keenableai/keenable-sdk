/**
 * The Python, TypeScript and Go SDKs release together, on one version.
 *
 *   node scripts/release/version.ts show          prints each file's version
 *   node scripts/release/version.ts check         exits 1 unless all agree
 *   node scripts/release/version.ts prepare 0.1.5 bumps every file and changelog
 *
 * `prepare` writes the version into the four files that hold it and turns
 * each changelog's `## Unreleased` into `## <version>` under a fresh, empty
 * `## Unreleased`. A language with nothing unreleased gets a line saying it
 * ships to keep the versions in step. It refuses a version that is not above
 * every current one, and a release where no SDK has unreleased changes.
 * Needs Node 22.18+ (it runs this file as TypeScript).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = new URL("../../", import.meta.url);

type VersionFile = { path: string; pattern: RegExp };

/** Every place a version is written. The capture group is the version. */
export const VERSION_FILES: VersionFile[] = [
  { path: "python/pyproject.toml", pattern: /^version = "([^"]+)"$/m },
  { path: "python/keenable/_version.py", pattern: /^__version__ = "([^"]+)"$/m },
  { path: "typescript/package.json", pattern: /^  "version": "([^"]+)",$/m },
  { path: "go/version.go", pattern: /^const Version = "([^"]+)"$/m },
];

export const CHANGELOGS = ["python/CHANGELOG.md", "typescript/CHANGELOG.md", "go/CHANGELOG.md"];

const UNRELEASED = "## Unreleased";
const NO_CHANGES = "No changes. Released with the other SDKs to keep one version.";

type Files = { read(path: string): string; write(path: string, text: string): void };

const disk: Files = {
  read: (path) => readFileSync(fileURLToPath(new URL(path, ROOT)), "utf8"),
  write: (path, text) => writeFileSync(fileURLToPath(new URL(path, ROOT)), text),
};

export function parse(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) throw new Error(`"${version}" is not a release version (x.y.z)`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compare(a: string, b: string): number {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function versions(files: Files = disk): Map<string, string> {
  const found = new Map<string, string>();
  for (const { path, pattern } of VERSION_FILES) {
    const match = pattern.exec(files.read(path));
    if (!match) throw new Error(`${path}: no version found`);
    found.set(path, match[1]);
  }
  return found;
}

/** The text between `## Unreleased` and the next `## ` heading. */
export function unreleased(changelog: string, path: string): { start: number; end: number; body: string } {
  const start = changelog.indexOf(`${UNRELEASED}\n`);
  if (start < 0) throw new Error(`${path}: no "${UNRELEASED}" heading`);
  const from = start + UNRELEASED.length + 1;
  const next = changelog.indexOf("\n## ", from);
  const end = next < 0 ? changelog.length : next + 1;
  return { start, end, body: changelog.slice(from, end).trim() };
}

export function prepare(version: string, files: Files = disk): void {
  parse(version);
  for (const [path, current] of versions(files)) {
    if (compare(version, current) <= 0) throw new Error(`${version} is not above ${path} (${current})`);
  }
  const logs = CHANGELOGS.map((path) => ({ path, text: files.read(path) }));
  const sections = logs.map(({ path, text }) => unreleased(text, path));
  if (sections.every((s) => s.body === "")) throw new Error("no SDK has unreleased changes");

  for (const { path, pattern } of VERSION_FILES) {
    const text = files.read(path);
    files.write(path, text.replace(pattern, (line, old: string) => line.replace(old, version)));
  }
  logs.forEach(({ path, text }, i) => {
    const { start, end, body } = sections[i];
    const released = `${UNRELEASED}\n\n## ${version}\n\n${body || NO_CHANGES}\n\n`;
    files.write(path, text.slice(0, start) + released + text.slice(end));
  });
}

/** The release notes: each SDK's section for `version`, under its name. */
export function notes(version: string, files: Files = disk): string {
  const names: Record<string, string> = { python: "Python", typescript: "TypeScript", go: "Go" };
  return CHANGELOGS.map((path) => {
    const text = files.read(path);
    const heading = `## ${version}\n`;
    const start = text.indexOf(heading);
    if (start < 0) throw new Error(`${path}: no "## ${version}" heading`);
    const next = text.indexOf("\n## ", start + heading.length);
    const body = text.slice(start + heading.length, next < 0 ? undefined : next).trim();
    return `## ${names[path.split("/")[0]]}\n\n${body}`;
  }).join("\n\n");
}

function main(args: string[]): void {
  const [command, version] = args;
  if (command === "show") {
    for (const [path, v] of versions()) console.log(`${v}\t${path}`);
  } else if (command === "check") {
    const all = new Set(versions().values());
    if (all.size !== 1) {
      for (const [path, v] of versions()) console.error(`${v}\t${path}`);
      throw new Error("the SDK versions differ");
    }
    console.log([...all][0]);
  } else if (command === "prepare" && version) {
    prepare(version);
    console.log(`prepared ${version}`);
  } else if (command === "notes" && version) {
    console.log(notes(version));
  } else {
    throw new Error("usage: version.ts show | check | prepare <x.y.z> | notes <x.y.z>");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`version.ts: ${(error as Error).message}`);
    process.exit(1);
  }
}
