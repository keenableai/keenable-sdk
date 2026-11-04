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
// prompt. The patterns are kept in step with the Python and Go SDKs. Every
// repeated group has alternatives that start with different characters, so a
// match attempt never backtracks into itself, and each attempt stops at the
// next bracket or parenthesis: cleaning stays linear on hostile input.
//
// Image alt text may hold one level of [brackets] and the URL one level of
// (parentheses), as in Wikipedia's File_(1).png; a title rides along inside.
const MD_IMAGE = /!\[(?:[^[\]\n]|\[[^[\]\n]*\])*\]\((?:[^()\n]|\([^()\n]*\))*\)/g;
const HTML_IMAGE = /<img\b(?:[^<>"']|"[^"\n]*"|'[^'\n]*')*>/gi;
const MD_LINK = /\[([^[\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"\n]*")?\)/g;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const ONLY_TABLE_RULE = /^[ \t|:-]*$/;
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const CODE_SPAN = /`+[^`\n]*`+/g;
const PLACEHOLDER = /\x00(\d+)\x00/g;
const WORD_CHAR = /[A-Za-z0-9_]/;

function resolveLink(
  match: string,
  text: string,
  href: string,
  offset: number,
  line: string,
  baseUrl: string,
): string {
  // `handlers[name](event)` and `fns[i]()` are code, not links.
  if (offset > 0 && WORD_CHAR.test(line.charAt(offset - 1))) return match;
  // A code span inside the URL would not survive URL normalisation.
  if (href.includes("\x00")) return match;
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

function isTableDelimiter(line: string): boolean {
  return line.includes("|") && line.includes("-") && ONLY_TABLE_RULE.test(line.trimEnd());
}

/**
 * Strip markup a model cannot use from page text bound for a prompt.
 *
 * Markdown images and `<img>` tags are removed. Links with an absolute URL are
 * kept as written; relative links are resolved against `baseUrl` (the page the
 * text came from), or reduced to their text when that is not possible. Fenced
 * code blocks and inline code spans are left alone, and so is `name[i](x)`,
 * which is code rather than a link. Only lines that changed are tidied: runs of
 * spaces squeezed, and the line dropped if nothing but table pipes and dashes
 * is left (unless it is a table's header row). Text without such markup is
 * returned unchanged.
 */
export function cleanContextText(text: string, baseUrl: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  lines.forEach((line, i) => {
    const marker = FENCE.exec(line);
    const run = marker?.[1] ?? "";
    const info = marker?.[2] ?? "";
    if (fence !== undefined) {
      out.push(line);
      if (run && run[0] === fence[0] && run.length >= fence.length && !info.trim()) {
        fence = undefined;
      }
      return;
    }
    if (run && !(run[0] === "`" && info.includes("`"))) {
      fence = run;
      out.push(line);
      return;
    }

    const spans: string[] = [];
    let protectedLine = line;
    if (!line.includes("\x00")) {
      protectedLine = line.replace(CODE_SPAN, (span) => {
        spans.push(span);
        return `\x00${spans.length - 1}\x00`;
      });
    }
    let cleaned = protectedLine.replace(MD_IMAGE, "").replace(HTML_IMAGE, "");
    cleaned = cleaned.replace(
      MD_LINK,
      (match: string, linkText: string, href: string, offset: number, whole: string) =>
        resolveLink(match, linkText, href, offset, whole, baseUrl),
    );
    if (cleaned === protectedLine) {
      out.push(line);
      return;
    }
    const indent = /^[ \t]*/.exec(cleaned)?.[0] ?? "";
    cleaned = indent + cleaned.slice(indent.length).replace(/[ \t]+/g, " ").trimEnd();
    if (
      ONLY_TABLE_RULE.test(cleaned) &&
      !(cleaned.includes("|") && i + 1 < lines.length && isTableDelimiter(lines[i + 1] ?? ""))
    ) {
      return;
    }
    if (spans.length) {
      cleaned = cleaned.replace(PLACEHOLDER, (_m, n: string) => spans[Number(n)] ?? "");
    }
    out.push(cleaned);
  });
  return out.join("\n");
}
