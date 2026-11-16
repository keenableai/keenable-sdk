import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Points the config directory at a temporary one before any test runs.
    setupFiles: ["./test/setup.ts"],
  },
});
