import { describe, expect, it } from "vitest";

import { runtimeParts } from "../src/user-agent.js";

describe("runtimeParts", () => {
  it("reads Node's version and platform", () => {
    const parts = runtimeParts({ process: { versions: { node: "22.1.0" }, platform: "linux", arch: "x64" } });
    expect(parts).toEqual([["node", "22.1.0"], ["linux", "x64"]]);
  });

  it("names Bun before its Node compatibility layer", () => {
    const parts = runtimeParts({
      Bun: { version: "1.1.8" },
      process: { versions: { node: "22.3.0" }, platform: "darwin", arch: "arm64" },
    });
    expect(parts).toEqual([["bun", "1.1.8"], ["darwin", "arm64"]]);
  });

  it("reads Deno's version and build target", () => {
    const parts = runtimeParts({
      Deno: { version: { deno: "2.0.0" }, build: { os: "linux", arch: "aarch64" } },
      process: { versions: { node: "20.11.1" }, platform: "linux", arch: "arm64" },
    });
    expect(parts).toEqual([["deno", "2.0.0"], ["linux", "aarch64"]]);
  });

  it("names the edge runtimes without a version or platform", () => {
    expect(runtimeParts({ EdgeRuntime: "edge-runtime" })).toEqual([["edge-runtime", ""]]);
    expect(runtimeParts({ navigator: { userAgent: "Cloudflare-Workers" } })).toEqual([["workerd", ""]]);
  });

  it("sends nothing it cannot tell", () => {
    expect(runtimeParts({})).toEqual([]);
    expect(runtimeParts({ navigator: { userAgent: "Mozilla/5.0" } })).toEqual([]);
  });
});
