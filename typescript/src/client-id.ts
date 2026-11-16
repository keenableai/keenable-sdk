/**
 * The anonymous client ID a keyless client keeps.
 *
 * The API issues an opaque token to a keyless caller in the
 * `X-Keenable-Client` response header, and the client sends it back on later
 * keyless requests, so keyless traffic is told apart by an ID the server
 * issued rather than by address. It identifies an installation, not a person,
 * is not a credential and grants nothing. On Node it is kept in
 * `<config dir>/keenable/client-id`, the file the Keenable MCP bridge uses
 * too, so one machine keeps one ID; where there is no filesystem (browsers,
 * edge runtimes) it lives in memory.
 *
 * The rules (which values are a token, where the file lives) are the same in
 * the Python and Go SDKs: see scripts/conformance/README.md.
 */

export const CLIENT_ID_HEADER = "X-Keenable-Client";
/**
 * Set to any non-empty value, this turns the ID off: never read, written,
 * sent or captured.
 */
export const CLIENT_ID_OPT_OUT_ENV = "KEENABLE_NO_CLIENT_ID";

const TOKEN = /^[A-Za-z0-9._-]{1,128}$/;

/** `value` when it is a token, else undefined. The token is never parsed. */
export function validClientId(value: unknown): string | undefined {
  return typeof value === "string" && TOKEN.test(value) ? value : undefined;
}

function isAbsolute(path: string, windows: boolean): boolean {
  if (!windows) return path.startsWith("/");
  return /^[\\/]/.test(path) || /^[A-Za-z]:[\\/]/.test(path);
}

function trimTrailingSeparators(path: string, windows: boolean): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || (windows && path[end - 1] === "\\"))) end--;
  return path.slice(0, end);
}

/**
 * The client-id file, or undefined when there is no directory to keep it in.
 *
 * `$XDG_CONFIG_HOME` when it is set and absolute; else `%APPDATA%` on Windows,
 * falling back to `~/AppData/Roaming`; else `~/.config`.
 */
export function clientIdPath(
  env: Record<string, string | undefined>,
  windows: boolean,
  home: string,
): string | undefined {
  const sep = windows ? "\\" : "/";
  const xdg = env.XDG_CONFIG_HOME ?? "";
  const appData = env.APPDATA ?? "";
  let base: string;
  if (isAbsolute(xdg, windows)) base = xdg;
  else if (windows && appData !== "") base = appData;
  else if (home === "") return undefined;
  else {
    const tail = windows ? ["AppData", "Roaming"] : [".config"];
    base = [trimTrailingSeparators(home, windows), ...tail].join(sep);
  }
  return [trimTrailingSeparators(base, windows), "keenable", "client-id"].join(sep);
}

/** What the store needs from Node: a few `node:fs` calls and where files go. */
export interface NodeRuntime {
  fs: Pick<
    typeof import("node:fs"),
    "readFileSync" | "mkdirSync" | "writeFileSync" | "renameSync" | "unlinkSync"
  >;
  homedir: () => string;
  env: Record<string, string | undefined>;
  platform: string;
}

interface ProcessLike {
  versions?: { node?: string };
  env?: Record<string, string | undefined>;
  platform?: string;
  getBuiltinModule?: (name: string) => unknown;
}

/**
 * Node's filesystem, or undefined where there is none.
 *
 * Nothing here is a static import, so a browser or edge bundle never sees
 * `node:fs`: `process.getBuiltinModule` (Node 20.16+, 22.3+) needs no import
 * at all, and older Node falls back to an `import()` whose specifier is a
 * variable, which bundlers leave alone. Deno is skipped although it has
 * `node:fs`: reading a file there can prompt the user for permission.
 */
export async function loadNodeRuntime(
  proc: ProcessLike | undefined = (globalThis as { process?: ProcessLike }).process,
): Promise<NodeRuntime | undefined> {
  if (typeof proc?.versions?.node !== "string" || "Deno" in globalThis) return undefined;
  try {
    const load = async (name: string): Promise<unknown> =>
      typeof proc.getBuiltinModule === "function"
        ? proc.getBuiltinModule(name)
        : await import(/* webpackIgnore: true */ /* @vite-ignore */ name);
    const fs = (await load("node:fs")) as NodeRuntime["fs"];
    const os = (await load("node:os")) as { homedir: () => string };
    if (typeof fs?.readFileSync !== "function" || typeof os?.homedir !== "function") {
      return undefined;
    }
    return {
      fs,
      homedir: () => os.homedir(),
      env: proc.env ?? {},
      platform: proc.platform ?? "",
    };
  } catch {
    return undefined;
  }
}

/**
 * One client's ID: loaded from the file once, then held in memory.
 *
 * No filesystem failure is thrown or logged: the ID then lives in memory for
 * the client's lifetime.
 */
export class ClientIdStore {
  private token?: string;
  private path?: string;
  private fs?: NodeRuntime["fs"];
  private loading?: Promise<void>;

  constructor(
    private readonly runtime: () => Promise<NodeRuntime | undefined> = loadNodeRuntime,
  ) {}

  /** The ID to send, reading the file before the first request. */
  async get(): Promise<string | undefined> {
    await (this.loading ??= this.load());
    return this.token;
  }

  /** Keep the ID a response carried; anything that is not a token is ignored. */
  capture(value: string | null | undefined): void {
    const token = validClientId(value);
    if (token === undefined || token === this.token) return;
    this.token = token;
    this.write(token);
  }

  private async load(): Promise<void> {
    try {
      const node = await this.runtime();
      if (!node) return;
      let home = "";
      try {
        home = node.homedir();
      } catch {
        // No home directory: XDG_CONFIG_HOME or APPDATA can still name one.
      }
      this.path = clientIdPath(node.env, node.platform === "win32", home);
      if (this.path === undefined) return;
      this.fs = node.fs;
      const stored = validClientId(node.fs.readFileSync(this.path, "utf8").trim());
      // A response that arrived while the file was being read is newer.
      this.token ??= stored;
    } catch {
      // Unreadable or missing: no ID yet.
    }
  }

  private write(token: string): void {
    if (this.fs === undefined || this.path === undefined) return;
    const cut = Math.max(this.path.lastIndexOf("/"), this.path.lastIndexOf("\\"));
    const directory = this.path.slice(0, cut);
    const temp = `${this.path}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      this.fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      this.fs.writeFileSync(temp, `${token}\n`, { mode: 0o600, flag: "wx" });
      this.fs.renameSync(temp, this.path);
    } catch {
      try {
        this.fs.unlinkSync(temp);
      } catch {
        // Nothing to clean up.
      }
    }
  }
}
