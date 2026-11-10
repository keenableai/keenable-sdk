// node --test scripts/release/version.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { CHANGELOGS, notes, prepare, versions } from "./version.ts";

function repo(py: string, ts: string, go: string, logs: Record<string, string>) {
  const files = new Map<string, string>([
    ["python/pyproject.toml", `[project]\nname = "keenable"\nversion = "${py}"\n`],
    ["python/keenable/_version.py", `"""Doc."""\n\n__version__ = "${py}"\n`],
    ["typescript/package.json", `{\n  "name": "keenable",\n  "version": "${ts}",\n  "type": "module"\n}\n`],
    ["go/version.go", `package keenable\n\nconst Version = "${go}"\n`],
    ...CHANGELOGS.map((path) => [path, logs[path] ?? "# Changelog\n\n## Unreleased\n\n## 0.1.0\n\nFirst.\n"] as [string, string]),
  ]);
  return {
    files,
    read: (path: string) => files.get(path) ?? assert.fail(`no ${path}`),
    write: (path: string, text: string) => void files.set(path, text),
  };
}

const withChange = { "python/CHANGELOG.md": "# Changelog\n\nIntro.\n\n## Unreleased\n\n- Added x.\n\n## 0.1.3\n\nOld.\n" };

test("prepare aligns every file on one version", () => {
  const r = repo("0.1.3", "0.1.4", "0.1.1", withChange);
  prepare("0.1.5", r);
  assert.deepEqual([...new Set(versions(r).values())], ["0.1.5"]);
  assert.match(r.files.get("typescript/package.json")!, /"type": "module"/);
});

test("prepare moves Unreleased under the version and leaves a fresh one", () => {
  const r = repo("0.1.3", "0.1.4", "0.1.1", withChange);
  prepare("0.1.5", r);
  assert.equal(
    r.files.get("python/CHANGELOG.md"),
    "# Changelog\n\nIntro.\n\n## Unreleased\n\n## 0.1.5\n\n- Added x.\n\n## 0.1.3\n\nOld.\n",
  );
  assert.match(r.files.get("go/CHANGELOG.md")!, /## 0\.1\.5\n\nNo changes\. Released with the other SDKs/);
});

test("prepare refuses a version that is not above every current one", () => {
  assert.throws(() => prepare("0.1.4", repo("0.1.3", "0.1.4", "0.1.1", withChange)), /not above typescript/);
  assert.throws(() => prepare("0.1", repo("0.1.3", "0.1.4", "0.1.1", withChange)), /not a release version/);
});

test("prepare refuses a release with nothing unreleased and writes nothing", () => {
  const r = repo("0.1.3", "0.1.4", "0.1.1", {});
  assert.throws(() => prepare("0.1.5", r), /no SDK has unreleased changes/);
  assert.equal(versions(r).get("go/version.go"), "0.1.1");
});

test("notes collects each SDK's section", () => {
  const r = repo("0.1.3", "0.1.4", "0.1.1", withChange);
  prepare("0.1.5", r);
  const text = notes("0.1.5", r);
  assert.match(text, /^## Python\n\n- Added x\.\n\n## TypeScript\n\nNo changes/);
  assert.ok(!text.includes("Old."));
});
