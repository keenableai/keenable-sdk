/**
 * The User-Agent the SDK sends:
 * `keenable-typescript/<sdk version> <runtime>/<runtime version> <os>/<arch>`,
 * for example `keenable-typescript/0.4.0 node/22.1.0 linux/x64`. The runtime
 * is `node`, `bun` or `deno` with its version, or `workerd` / `edge-runtime`
 * alone on those edge runtimes; a part the SDK cannot tell is left out.
 * Nothing else is sent: no host name, user, path, key or locale. A caller's
 * `User-Agent` in `defaultHeaders` or `headers` replaces it. The formatting
 * rule is shared with the other SDKs (scripts/conformance/README.md).
 * Not part of the public API.
 */

// Replaced at build time with the version from package.json, so a release
// cannot ship a User-Agent that disagrees with the published package.
declare const __VERSION__: string;
export const VERSION = typeof __VERSION__ === "string" ? __VERSION__ : "0.0.0-dev";

const MAX_PART_CHARS = 64;

function clean(text: string): string {
  return text
    .replace(/[^A-Za-z0-9._+-]+/g, "-")
    .slice(0, MAX_PART_CHARS)
    .replace(/^-+|-+$/g, "");
}

/**
 * `name/version` per part, space-separated, each half cleaned. A part whose
 * name cleans to nothing is left out; one whose version cleans to nothing is
 * its name alone.
 */
export function formatUserAgent(parts: readonly (readonly [string, string])[]): string {
  const out: string[] = [];
  for (const [rawName, rawVersion] of parts) {
    const name = clean(rawName);
    const version = clean(rawVersion);
    if (name) out.push(version ? `${name}/${version}` : name);
  }
  return out.join(" ");
}

interface RuntimeGlobals {
  Bun?: { version?: unknown };
  Deno?: { version?: { deno?: unknown }; build?: { os?: unknown; arch?: unknown } };
  EdgeRuntime?: unknown;
  navigator?: { userAgent?: unknown };
  process?: { versions?: { node?: unknown }; platform?: unknown; arch?: unknown };
}

const text = (v: unknown): string => (typeof v === "string" ? v : "");

/** The runtime and platform parts, as far as this runtime shows them. */
export function runtimeParts(g: RuntimeGlobals): [string, string][] {
  const proc = g.process;
  const procPlatform: [string, string] = [text(proc?.platform), text(proc?.arch)];
  if (g.Bun) return [["bun", text(g.Bun.version)], procPlatform];
  if (g.Deno) {
    const build = g.Deno.build;
    return [["deno", text(g.Deno.version?.deno)], [text(build?.os), text(build?.arch)]];
  }
  if (typeof g.EdgeRuntime === "string") return [["edge-runtime", ""]];
  if (g.navigator?.userAgent === "Cloudflare-Workers") return [["workerd", ""]];
  if (typeof proc?.versions?.node === "string") return [["node", proc.versions.node], procPlatform];
  return [];
}

let cached: string | undefined;

/** The User-Agent for this process, worked out once. */
export function userAgent(): string {
  if (cached === undefined) {
    let parts: [string, string][] = [];
    try {
      parts = runtimeParts(globalThis as unknown as RuntimeGlobals);
    } catch {
      // A runtime that throws on a global lookup sends the SDK part alone.
    }
    cached = formatUserAgent([["keenable-typescript", VERSION], ...parts]);
  }
  return cached;
}
