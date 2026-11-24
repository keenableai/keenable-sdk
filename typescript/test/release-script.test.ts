/**
 * The pure helpers of scripts/release.ts (the one-command SDK release): version
 * math across the three SDKs, the changelog section it puts in the PR body, and
 * how it reads a PR's checks before merging.
 */
import { describe, expect, it } from "vitest";

import {
  changelogSection,
  compareVersions,
  highestVersion,
  newestPerCheck,
  nextVersion,
  releaseBody,
  summarizeChecks,
} from "../../scripts/release.js";
import { checkReleaseNotes } from "../../scripts/pr-description/pr-body.mjs";

const run = (name: string, status: string, conclusion: string, startedAt: string, workflowName = "Test") => ({
  __typename: "CheckRun",
  name,
  workflowName,
  status,
  conclusion,
  startedAt,
});

describe("versions", () => {
  it("compares numerically, not as text", () => {
    expect(compareVersions("0.1.10", "0.1.9")).toBe(1);
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
  });

  it("takes the highest of the SDK versions as the base for `all`", () => {
    expect(highestVersion(["0.1.4", "0.1.10", "0.1.2"])).toBe("0.1.10");
    expect(nextVersion(highestVersion(["0.1.4", "0.1.4", "0.1.2"]), "patch")).toBe("0.1.5");
    expect(nextVersion("0.1.4", "minor")).toBe("0.2.0");
    expect(nextVersion("0.1.4", "major")).toBe("1.0.0");
    expect(nextVersion("0.1.4", "3.2.1")).toBe("3.2.1");
  });
});

describe("changelogSection", () => {
  const changelog = "# C\n\n## Unreleased\n\n## 0.1.5\n\n- x\n\n## 0.1.4\n\n- y\n";

  it("returns the entries under one version, up to the next heading", () => {
    expect(changelogSection(changelog, "0.1.5")).toBe("- x");
    expect(changelogSection(changelog, "0.1.4")).toBe("- y");
  });

  it("is empty for a version that isn't there, and doesn't match by prefix", () => {
    expect(changelogSection(changelog, "9.9.9")).toBe("");
    expect(changelogSection(changelog, "0.1")).toBe("");
  });
});

describe("summarizeChecks", () => {
  it("counts a retried run once: an old failure followed by a newer success passes", () => {
    const retried = [
      run("Python 3.12", "COMPLETED", "FAILURE", "2026-11-13T15:00:00Z"),
      run("Python 3.12", "COMPLETED", "SUCCESS", "2026-11-13T15:10:00Z"),
      run("Go stable", "COMPLETED", "SUCCESS", "2026-11-13T15:10:00Z"),
    ];
    expect(summarizeChecks(retried)).toEqual({ total: 2, pending: 0, failed: 0 });
    // The list order must not matter.
    expect(summarizeChecks([...retried].reverse())).toEqual({ total: 2, pending: 0, failed: 0 });
  });

  it("fails on a newer failure after an older success", () => {
    const checks = [
      run("Node 22", "COMPLETED", "SUCCESS", "2026-11-13T15:00:00Z"),
      run("Node 22", "COMPLETED", "FAILURE", "2026-11-13T15:10:00Z"),
    ];
    expect(summarizeChecks(checks).failed).toBe(1);
  });

  it("treats a re-queued run (no start time yet) as the newest, so it is pending", () => {
    const checks = [
      run("Python 3.12", "COMPLETED", "SUCCESS", "2026-11-13T15:00:00Z"),
      run("Python 3.12", "QUEUED", "", "0001-01-01T00:00:00Z"),
    ];
    expect(summarizeChecks(checks)).toEqual({ total: 1, pending: 1, failed: 0 });
  });

  it("counts cancelled and timed-out runs as failed, skipped ones as neither", () => {
    const checks = [
      run("a", "COMPLETED", "CANCELLED", "2026-11-13T15:00:00Z"),
      run("b", "COMPLETED", "TIMED_OUT", "2026-11-13T15:00:00Z"),
      run("c", "COMPLETED", "SKIPPED", "2026-11-13T15:00:00Z"),
    ];
    expect(summarizeChecks(checks)).toEqual({ total: 3, pending: 0, failed: 2 });
  });

  it("reports no checks as zero, so the caller can wait for one to appear", () => {
    expect(summarizeChecks([]).total).toBe(0);
  });

  it("keeps same-named checks of different workflows apart, and dedupes status contexts", () => {
    expect(
      newestPerCheck([
        run("build", "COMPLETED", "SUCCESS", "2026-11-13T15:00:00Z", "A"),
        run("build", "COMPLETED", "SUCCESS", "2026-11-13T15:00:00Z", "B"),
      ]),
    ).toHaveLength(2);
    expect(
      newestPerCheck([
        { __typename: "StatusContext", context: "ci/x", state: "FAILURE" },
        { __typename: "StatusContext", context: "ci/x", state: "SUCCESS" },
      ]),
    ).toHaveLength(1);
  });
});

describe("release PR body", () => {
  const intro = "Bumps the python SDK 0.1.4 -> 0.1.5. Merging tags `python-v0.1.5` and publishes.";
  const changes = "- `search()` takes `moderation`; `safety_mode` is deprecated and still accepted until 2027-03-01.";
  const notes = [
    "## Evidence",
    "Measured: conformance and error-contract suites green, https://github.com/keenableai/keenable-sdk/actions/runs/1; docs sample ran unmodified against production.",
    "",
    "## Rollback",
    "Yank 0.1.5 on PyPI (pip falls back to 0.1.4 unless pinned); the deprecated argument keeps working, so a yank breaks nobody.",
  ].join("\n");

  it("puts the changelog under What changes for users and passes the release-notes check", () => {
    const body = releaseBody(intro, changes, notes);
    expect(body).toContain("## What changes for users\n\n- `search()`");
    expect(checkReleaseNotes({ body }).errors).toEqual([]);
  });

  it("fails without changelog entries, evidence or a rollback", () => {
    expect(checkReleaseNotes({ body: releaseBody(intro, "", notes) }).errors.join()).toMatch(/What changes for users/);
    expect(checkReleaseNotes({ body: releaseBody(intro, changes, "") }).errors).toHaveLength(2);
    const unlinked = notes.replace(/https:\/\/\S+;/, "");
    expect(checkReleaseNotes({ body: releaseBody(intro, changes, unlinked) }).errors.join()).toMatch(/must link/);
  });
});
