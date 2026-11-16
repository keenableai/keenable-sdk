/**
 * Runs before every test file. A keyless client reads and writes
 * `<config dir>/keenable/client-id`; this points the config directory at a
 * temporary one so no test uses the real home directory.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const configDir = mkdtempSync(join(tmpdir(), "keenable-test-config-"));
process.env.XDG_CONFIG_HOME = configDir;
delete process.env.KEENABLE_NO_CLIENT_ID;

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true });
});
