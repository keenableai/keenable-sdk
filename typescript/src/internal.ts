/** Helpers shared by the client and the tool layer. Not part of the public API. */

// Epoch values at or above this are milliseconds: 1e11 seconds is the year
// 5138, while 1e11 milliseconds is 1973, so no real date is ambiguous.
const EPOCH_MS_THRESHOLD = 100_000_000_000;
// Values below this (1973-03-03 in seconds) are not read as epochs: they are
// far more likely a compact date such as "20261022", a bare year, or 0 for
// "unknown". The Python and Go SDKs apply the same rules.
const EPOCH_MIN = 100_000_000;
// 9999-12-31T23:59:59Z: past it a "date" is garbage, not a four-digit year.
const EPOCH_MAX_SECONDS = 253_402_300_799;

/**
 * Normalize a timestamp to ISO-8601, or undefined.
 *
 * Search returns ISO strings, which pass through untouched. Fetch returns a
 * Unix epoch number (seconds, or milliseconds past the threshold above), which
 * becomes `YYYY-MM-DDTHH:MM:SSZ` in UTC.
 */
export function isoTimestamp(value: unknown): string | undefined {
  let epoch: number;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return undefined;
    // A digit string too small to be an epoch is returned as given.
    if (!/^\d+$/.test(text) || Number(text) < EPOCH_MIN) return value;
    epoch = Number(text);
  } else if (typeof value === "number" && Number.isFinite(value)) {
    if (value < EPOCH_MIN) return undefined;
    epoch = value;
  } else {
    return undefined;
  }
  const ms = epoch >= EPOCH_MS_THRESHOLD ? epoch : epoch * 1000;
  if (ms / 1000 > EPOCH_MAX_SECONDS) return undefined;
  const date = new Date(Math.floor(ms / 1000) * 1000);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(".000Z", "Z");
}

/** Return a non-empty string, or undefined for anything else (incl. ""). */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * A URL's host in one canonical form: lowercased, without IPv6 brackets, and
 * without the trailing dot of a fully-qualified name.
 *
 * `URL.hostname` keeps the brackets on IPv6 literals, so comparing hosts
 * against a set only works if every caller strips them the same way. The
 * trailing dot matters too: `localhost.` resolves to `localhost` but does not
 * match it as a string, which is enough to walk past a blocklist.
 */
export function normalizeHost(url: URL): string {
  return url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");
}

/** Read an environment variable, tolerating runtimes with no `process`. */
export function readEnv(name: string): string | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process?.env;
  return env?.[name];
}

/**
 * Squeeze runs of whitespace into single spaces.
 *
 * Snippets are raw page text and carry newlines. Left alone they collide with
 * the blank line that separates rendered sources, so a model cannot tell where
 * one source ends, and the character budget gets spent on layout.
 */
export function collapse(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}
