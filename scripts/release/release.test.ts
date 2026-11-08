import assert from "node:assert/strict";
import { test } from "node:test";

import {
  changelogSection,
  compareVersions,
  nextVersion,
  rollChangelog,
  siteVersions,
  readVersionFile,
} from "./release.ts";

test("nextVersion bumps and finishes prereleases", () => {
  assert.equal(nextVersion("0.1.4", "patch"), "0.1.5");
  assert.equal(nextVersion("0.1.4", "minor"), "0.2.0");
  assert.equal(nextVersion("0.1.4", "major"), "1.0.0");
  assert.equal(nextVersion("0.1.4", "v0.3.0-rc.1"), "0.3.0-rc.1");
  assert.equal(nextVersion("0.3.0-rc.1", "patch"), "0.3.0");
  assert.equal(nextVersion("0.3.0-rc.1", "minor"), "0.3.0");
  assert.equal(nextVersion("0.3.1-rc.1", "minor"), "0.4.0");
  assert.equal(nextVersion("1.0.0-rc.1", "major"), "1.0.0");
});

test("nextVersion refuses a version that is not newer, or not a version", () => {
  assert.throws(() => nextVersion("0.2.0", "0.1.9"), /not newer/);
  assert.throws(() => nextVersion("0.2.0", "0.2.0"), /not newer/);
  assert.throws(() => nextVersion("0.2.0", "0.3"), /not a version/);
  assert.throws(() => nextVersion("0.2.0", "latest"), /not a version/);
});

test("compareVersions follows semver precedence", () => {
  assert.equal(compareVersions("1.0.0-rc.1", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-alpha.1"), -1);
  assert.equal(compareVersions("1.0.0-1", "1.0.0-alpha"), -1);
  assert.equal(compareVersions("0.10.0", "0.9.9"), 1);
});

const LOG = `# Changelog

## Unreleased

- New thing.

## 0.1.0

Initial release.
`;

test("rollChangelog moves Unreleased under the version", () => {
  const out = rollChangelog(LOG, "0.2.0", "2026-11-08", "unused");
  assert.equal(changelogSection(out, "Unreleased"), "");
  assert.equal(changelogSection(out, "0.2.0"), "- New thing.");
  assert.equal(changelogSection(out, "0.1.0"), "Initial release.");
});

test("rollChangelog writes the fallback when Unreleased is empty", () => {
  const empty = LOG.replace("- New thing.\n\n", "");
  const out = rollChangelog(empty, "0.2.0", "2026-11-08", "- from commits");
  assert.equal(changelogSection(out, "0.2.0"), "- from commits");
});

test("every package carries the VERSION file's version", () => {
  const version = readVersionFile();
  for (const [file, v] of Object.entries(siteVersions())) assert.equal(v, version, file);
});
