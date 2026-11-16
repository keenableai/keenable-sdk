/**
 * The anonymous client ID of a keyless client. Each test gets its own
 * temporary config directory; test/setup.ts gives every other test file one.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClientIdStore, clientIdPath, loadNodeRuntime } from "../src/client-id.js";
import type { NodeRuntime } from "../src/client-id.js";
import { Keenable } from "../src/index.js";
import type { KeenableOptions } from "../src/index.js";

const TOKEN = "kc1.AbC-dEf_123.s1x2y3.q9";
const OTHER = "kc1.other-token";
const HEADER = "X-Keenable-Client";

let configDir: string;
let idFile: string;

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "keenable-client-id-"));
  idFile = join(configDir, "keenable", "client-id");
  vi.stubEnv("XDG_CONFIG_HOME", configDir);
  vi.stubEnv("KEENABLE_NO_CLIENT_ID", undefined);
  vi.stubEnv("KEENABLE_API_KEY", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(configDir, { recursive: true, force: true });
});

function store(token: string): void {
  mkdirSync(dirname(idFile), { recursive: true });
  writeFileSync(idFile, `${token}\n`);
}

/** A client whose server issues `issue` as the ID, and the IDs it was sent. */
function server(issue: string | null, options: KeenableOptions = {}, status = 200) {
  const sent: (string | null)[] = [];
  const urls: string[] = [];
  const client = new Keenable({
    maxRetries: 0,
    ...options,
    fetch: (async (input: RequestInfo | URL, init: RequestInit = {}) => {
      urls.push(String(input));
      sent.push(new Headers(init.headers).get(HEADER));
      const headers = new Headers();
      if (issue !== null) headers.set(HEADER, issue);
      const body = status === 200 ? { results: [], content: "c" } : { error: "e" };
      return new Response(JSON.stringify(body), { status, headers });
    }) as unknown as typeof globalThis.fetch,
  });
  return { client, sent, urls };
}

describe("a keyless client", () => {
  it("sends the ID the server issued on the next request, and writes the file", async () => {
    const { client, sent, urls } = server(TOKEN);
    await client.search("q");
    await client.search("q");
    await client.fetch("https://example.com/");
    expect(sent).toEqual([null, TOKEN, TOKEN]);
    expect(urls[0]).toContain("/public");
    expect(readFileSync(idFile, "utf8")).toBe(`${TOKEN}\n`);
    expect(readdirSync(dirname(idFile))).toEqual(["client-id"]);
    if (process.platform !== "win32") {
      expect(statSync(idFile).mode & 0o777).toBe(0o600);
      expect(statSync(dirname(idFile)).mode & 0o777).toBe(0o700);
    }
  });

  it("takes an ID from an error response, and the retry carries it", async () => {
    vi.useFakeTimers();
    try {
      const { client, sent } = server(TOKEN, { maxRetries: 1 }, 429);
      const call = client.search("q").catch((error: unknown) => error);
      await vi.runAllTimersAsync();
      await call;
      expect(sent).toEqual([null, TOKEN]);
      expect(readFileSync(idFile, "utf8")).toBe(`${TOKEN}\n`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends a stored ID on the first request, and does not rewrite it", async () => {
    mkdirSync(dirname(idFile), { recursive: true });
    writeFileSync(idFile, `  ${TOKEN}  \n`);
    const { client, sent } = server(TOKEN);
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([TOKEN, TOKEN]);
    expect(readFileSync(idFile, "utf8")).toBe(`  ${TOKEN}  \n`);
  });

  it("replaces the stored ID when the server issues a new one", async () => {
    store(TOKEN);
    const { client, sent } = server(OTHER);
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([TOKEN, OTHER]);
    expect(readFileSync(idFile, "utf8")).toBe(`${OTHER}\n`);
  });

  it("reads the file once, however many calls start together", async () => {
    store(TOKEN);
    const { client, sent } = server(null);
    await Promise.all([client.search("a"), client.search("b"), client.search("c")]);
    writeFileSync(idFile, `${OTHER}\n`);
    await client.search("d");
    expect(sent).toEqual([TOKEN, TOKEN, TOKEN, TOKEN]);
  });

  it.each(["", "not a token", "a/b", "a".repeat(129), "one\ntwo"])(
    "treats an invalid file as no ID: %j",
    async (stored) => {
      store(stored);
      const { client, sent } = server(null);
      await client.search("q");
      expect(sent).toEqual([null]);
    },
  );

  it.each(["", "has space", "a/b", "a".repeat(129), "kc1.a, kc1.b"])(
    "ignores a malformed header: %j",
    async (value) => {
      const { client, sent } = server(value);
      await client.search("q");
      await client.search("q");
      expect(sent).toEqual([null, null]);
      expect(existsSync(idFile)).toBe(false);
    },
  );

  it("keeps the stored ID when the header is malformed", async () => {
    store(TOKEN);
    const { client, sent } = server("not a token");
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([TOKEN, TOKEN]);
    expect(readFileSync(idFile, "utf8")).toBe(`${TOKEN}\n`);
  });

  it("changes nothing when the server never sends the header", async () => {
    const { client, sent } = server(null);
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([null, null]);
    expect(readdirSync(configDir)).toEqual([]);
  });

  it("replaces a caller's own header of the same name, in any case", async () => {
    store(TOKEN);
    const seen: Record<string, string>[] = [];
    const client = new Keenable({
      defaultHeaders: { "x-keenable-client": "mine" },
      fetch: (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
        seen.push(init.headers as Record<string, string>);
        return new Response(JSON.stringify({ results: [] }));
      }) as unknown as typeof globalThis.fetch,
    });
    await client.search("q");
    const names = Object.keys(seen[0] ?? {}).filter((name) => name.toLowerCase() === "x-keenable-client");
    expect(names).toEqual([HEADER]);
    expect(seen[0]?.[HEADER]).toBe(TOKEN);
  });
});

describe("a client with an API key", () => {
  it("never sends, captures or stores the ID", async () => {
    store(TOKEN);
    const { client, sent, urls } = server(OTHER, { apiKey: "k" });
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([null, null]);
    expect(urls[0]).not.toContain("/public");
    expect(readFileSync(idFile, "utf8")).toBe(`${TOKEN}\n`);
  });

  it("counts a key from the environment", async () => {
    vi.stubEnv("KEENABLE_API_KEY", "k");
    const { client, sent } = server(TOKEN);
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([null, null]);
    expect(existsSync(idFile)).toBe(false);
  });
});

describe("opting out", () => {
  it.each([
    ["the anonymousClientId option", { anonymousClientId: false }, undefined],
    ["KEENABLE_NO_CLIENT_ID", {}, "1"],
  ] as const)("%s: nothing is read, sent, captured or written", async (_name, options, env) => {
    vi.stubEnv("KEENABLE_NO_CLIENT_ID", env);
    store(TOKEN);
    // The client has no store at all, and the mtime shows nothing was written.
    const before = statSync(idFile).mtimeMs;
    const { client, sent } = server(OTHER, options);
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([null, null]);
    expect(readFileSync(idFile, "utf8")).toBe(`${TOKEN}\n`);
    expect(statSync(idFile).mtimeMs).toBe(before);
    expect((client as unknown as { clientId?: unknown }).clientId).toBeUndefined();
  });

  it("an empty KEENABLE_NO_CLIENT_ID is not an opt-out", async () => {
    vi.stubEnv("KEENABLE_NO_CLIENT_ID", "");
    const { client, sent } = server(TOKEN);
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([null, TOKEN]);
  });
});

describe("a filesystem that fails", () => {
  it("keeps the ID in memory when the config directory cannot be created", async () => {
    // A file where the directory should be: nothing under it can be created.
    const blocker = join(configDir, "not-a-directory");
    writeFileSync(blocker, "");
    vi.stubEnv("XDG_CONFIG_HOME", blocker);
    const { client, sent } = server(TOKEN);
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([null, TOKEN]);
    expect(readFileSync(blocker, "utf8")).toBe("");
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "keeps the ID in memory when the directory is read-only",
    async () => {
      mkdirSync(dirname(idFile), { recursive: true });
      chmodSync(dirname(idFile), 0o500);
      try {
        const { client, sent } = server(TOKEN);
        await client.search("q");
        await client.search("q");
        expect(sent).toEqual([null, TOKEN]);
        expect(readdirSync(dirname(idFile))).toEqual([]);
      } finally {
        chmodSync(dirname(idFile), 0o700);
      }
    },
  );

  it("leaves no temporary file when the rename fails", async () => {
    // The target is a directory, so the rename over it fails.
    mkdirSync(idFile, { recursive: true });
    const { client, sent } = server(TOKEN);
    await client.search("q");
    await client.search("q");
    expect(sent).toEqual([null, TOKEN]);
    expect(readdirSync(dirname(idFile))).toEqual(["client-id"]);
  });

  it("never throws, whatever the filesystem calls throw", async () => {
    const broken = (): never => {
      throw new Error("no filesystem");
    };
    const runtime: NodeRuntime = {
      fs: {
        readFileSync: broken,
        mkdirSync: broken,
        writeFileSync: broken,
        renameSync: broken,
        unlinkSync: broken,
      } as unknown as NodeRuntime["fs"],
      homedir: broken,
      env: { XDG_CONFIG_HOME: "/xdg" },
      platform: "linux",
    };
    const ids = new ClientIdStore(async () => runtime);
    expect(await ids.get()).toBeUndefined();
    ids.capture(TOKEN);
    expect(await ids.get()).toBe(TOKEN);
  });
});

describe("a runtime with no filesystem", () => {
  it("keeps the ID in memory when `process` has no Node version", async () => {
    expect(await loadNodeRuntime({})).toBeUndefined();
    expect(await loadNodeRuntime({ versions: {} })).toBeUndefined();
    const ids = new ClientIdStore(async () => undefined);
    expect(await ids.get()).toBeUndefined();
    ids.capture("not a token");
    expect(await ids.get()).toBeUndefined();
    ids.capture(TOKEN);
    ids.capture(null);
    expect(await ids.get()).toBe(TOKEN);
  });

  it("works through the client when `process` is not Node's", async () => {
    store(TOKEN);
    vi.stubGlobal("process", { env: {} });
    const { client, sent } = server(OTHER);
    await client.search("q");
    await client.search("q");
    vi.unstubAllGlobals();
    // The stored file was not read, and the new ID was not written.
    expect(sent).toEqual([null, OTHER]);
    expect(readFileSync(idFile, "utf8")).toBe(`${TOKEN}\n`);
  });

  it("is skipped under Deno, where a file read can prompt for permission", async () => {
    vi.stubGlobal("Deno", {});
    expect(await loadNodeRuntime()).toBeUndefined();
  });

  it("treats a runtime whose node:fs fails to load as having none", async () => {
    const proc = {
      versions: { node: "22.0.0" },
      getBuiltinModule: (): never => {
        throw new Error("not available");
      },
    };
    expect(await loadNodeRuntime(proc)).toBeUndefined();
    expect(
      await loadNodeRuntime({ versions: { node: "22.0.0" }, getBuiltinModule: () => undefined }),
    ).toBeUndefined();
  });
});

describe("loading Node's filesystem", () => {
  it("uses process.getBuiltinModule when Node has it", async () => {
    const node = await loadNodeRuntime();
    expect(node?.fs.readFileSync).toBe(readFileSync);
    expect(node?.env.XDG_CONFIG_HOME).toBe(configDir);
    expect(clientIdPath(node!.env, node!.platform === "win32", node!.homedir())).toBe(idFile);
  });

  it("falls back to a dynamic import on a Node without it (18)", async () => {
    const node = await loadNodeRuntime({
      versions: { node: "18.20.0" },
      env: { XDG_CONFIG_HOME: "/xdg" },
      platform: "linux",
    });
    expect(typeof node?.fs.readFileSync).toBe("function");
    expect(node?.homedir()).not.toBe("");
    expect(node?.env).toEqual({ XDG_CONFIG_HOME: "/xdg" });
  });

  it("no source file imports a node: module statically", () => {
    const src = new URL("../src/", import.meta.url);
    for (const file of readdirSync(src)) {
      const text = readFileSync(new URL(file, src), "utf8");
      expect(text, file).not.toMatch(/^\s*import\b[^;]*["']node:/m);
      expect(text, file).not.toMatch(/\brequire\s*\(/);
    }
  });
});
