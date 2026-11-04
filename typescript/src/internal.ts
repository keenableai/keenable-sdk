/** Helpers shared by the client and the tool layer. Not part of the public API. */

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

// Markup that means nothing to a model once the page is flattened into a
// prompt. The patterns are kept in step with the Python and Go SDKs.
const MD_IMAGE = /!\[[^\]\n]*\]\([^)\n]*\)/g;
const HTML_IMAGE = /<img\b[^>]*>/gi;
const MD_LINK = /\[([^[\]\n]*)\]\(([^()\s]*)(?:\s+"[^"\n]*")?\)/g;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const ONLY_TABLE_RULE = /^[\s|:-]*$/;

function resolveLink(match: string, text: string, href: string, baseUrl: string): string {
  if (!text.trim()) return "";
  if (URL_SCHEME.test(href)) return match;
  if (!href) return text;
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") return text;
    return `[${text}](${new URL(href, base).toString()})`;
  } catch {
    return text;
  }
}

/**
 * Strip markup a model cannot use from page text bound for a prompt.
 *
 * Markdown images and `<img>` tags are removed. Links with an absolute URL are
 * kept as written; relative links are resolved against `baseUrl` (the page the
 * text came from), or reduced to their text when that is not possible. Only
 * lines that changed are tidied: runs of spaces squeezed, and the line dropped
 * if nothing but table pipes and dashes is left. Text without such markup is
 * returned unchanged.
 */
export function cleanContextText(text: string, baseUrl: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    let cleaned = line.replace(MD_IMAGE, "").replace(HTML_IMAGE, "");
    cleaned = cleaned.replace(MD_LINK, (match, linkText: string, href: string) =>
      resolveLink(match, linkText, href, baseUrl),
    );
    if (cleaned === line) {
      out.push(line);
      continue;
    }
    const indent = /^[ \t]*/.exec(cleaned)?.[0] ?? "";
    cleaned = indent + cleaned.slice(indent.length).replace(/[ \t]+/g, " ").trimEnd();
    if (ONLY_TABLE_RULE.test(cleaned)) continue;
    out.push(cleaned);
  }
  return out.join("\n");
}
