import { readFileSync } from "node:fs";

import { defineConfig } from "tsup";

const { version } = JSON.parse(readFileSync("./package.json", "utf8")) as {
  version: string;
};

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  target: "node18",
  // package.json is the single source of the version; the client reads it
  // through this define, so a release cannot ship a stale User-Agent.
  define: { __VERSION__: JSON.stringify(version) },
});
