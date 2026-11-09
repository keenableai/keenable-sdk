/** Helpers shared by the client and the tool layer. Not part of the public API. */

/** Return a non-empty string, or undefined for anything else (incl. ""). */
export function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

// The last Unix second with a four-digit year, 9999-12-31T23:59:59Z. A larger
// number is not a date the API sends (a millisecond value lands past it).
const MAX_UNIX_SECONDS = 253_402_300_799;

/**
 * A date as the API sends it, as one ISO 8601 string, or undefined.
 *
 * Search sends ISO 8601 strings, kept as sent (when not blank). Fetch sends
 * Unix seconds, which become ISO 8601 UTC to the second, such as
 * "2024-05-01T12:00:00Z"; a fraction is dropped. A number below 1 (the API
 * omits an unknown date rather than send 0), past the year 9999 or not finite
 * is undefined, as is anything else.
 */
export function timestamp(value: unknown): string | undefined {
  if (typeof value === "string") return nonEmpty(value);
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const seconds = Math.floor(value);
  if (seconds < 1 || seconds > MAX_UNIX_SECONDS) return undefined;
  return new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** A JSON boolean, or undefined for anything else. */
export function bool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A whole number from 0 to 2^53 - 1, or undefined for anything else. */
export function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return undefined;
  return value + 0; // -0 is 0
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
// CommonMark: optional blockquote markers, then at most 3 spaces before a fence.
const FENCE = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const PLACEHOLDER = /\x00(\d+)\x00/g;
const WORD_CHAR = /[A-Za-z0-9_]/;
const CODE_IDENT = /^[A-Za-z0-9_]*$/;

function resolveLink(
  match: string,
  text: string,
  href: string,
  offset: number,
  line: string,
  baseUrl: string,
): string {
  // `handlers[name](event)` and `fns[i]()` are code, not links. Ordinary
  // adjacent links like `docs[API](/api)` still resolve.
  if (offset > 0 && WORD_CHAR.test(line.charAt(offset - 1)) && CODE_IDENT.test(href)) {
    return match;
  }
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
 * How many `|` in `line` separate cells. A pipe after an odd run of
 * backslashes (`\|`, `\\\|`) is escaped; after an even run (`\\|`) the
 * backslashes escape each other.
 */
function cellPipes(line: string): number {
  let count = 0;
  let backslashes = 0;
  for (const ch of line) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === "|" && backslashes % 2 === 0) count += 1;
    backslashes = 0;
  }
  return count;
}

/**
 * Whether `line` has a row's shape on its own: `| a | b |`. It must start and
 * end with a cell pipe and hold at least two cells, so prose that merely
 * starts with a pipe (`|x| is ...`) is not a row.
 */
function looksLikeRow(line: string): boolean {
  // Trimmed by hand: /[ \t\r]+$/ is quadratic on long inner runs of spaces.
  const isBlank = (ch: string) => ch === " " || ch === "\t" || ch === "\r";
  let start = 0;
  let end = line.length;
  while (start < end && isBlank(line.charAt(start))) start += 1;
  while (end > start && isBlank(line.charAt(end - 1))) end -= 1;
  const trimmed = line.slice(start, end);
  if (!(trimmed.startsWith("|") && trimmed.endsWith("|"))) return false;
  const body = trimmed.slice(0, -1);
  let escapes = 0;
  while (escapes < body.length && body.charAt(body.length - 1 - escapes) === "\\") escapes += 1;
  return escapes % 2 === 0 && cellPipes(trimmed) >= 3;
}

/** The non-empty cells of a table row, trimmed, with `\|` read as `|`. */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let backslashes = 0;
  for (const ch of line) {
    if (ch === "|" && backslashes % 2 === 1) {
      cell = `${cell.slice(0, -1)}|`;
    } else if (ch === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
      backslashes = ch === "\\" ? backslashes + 1 : 0;
      continue;
    }
    backslashes = 0;
  }
  cells.push(cell);
  return cells.map((c) => c.replace(/[ \t]+/g, " ").trim()).filter(Boolean);
}

function restoreCodeSpans(text: string, spans: string[]): string {
  if (!spans.length) return text;
  return text.replace(PLACEHOLDER, (_m, n: string) => spans[Number(n)] ?? "");
}

/**
 * Swap inline code spans for placeholders the cleanup patterns skip.
 * Opening and closing backtick runs must be the same length, so a shorter
 * run inside a longer span (``a ` ![x](y)``) stays protected.
 */
function protectCodeSpans(line: string): { protected: string; spans: string[] } {
  const spans: string[] = [];
  if (line.includes("\x00")) return { protected: line, spans };

  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line.charAt(i) !== "`") {
      out += line.charAt(i);
      i += 1;
      continue;
    }
    let j = i;
    while (j < line.length && line.charAt(j) === "`") j += 1;
    const openLen = j - i;
    let k = j;
    let closer = -1;
    while (k < line.length) {
      if (line.charAt(k) !== "`") {
        k += 1;
        continue;
      }
      let end = k;
      while (end < line.length && line.charAt(end) === "`") end += 1;
      if (end - k === openLen) {
        closer = end;
        break;
      }
      k = end;
    }
    if (closer < 0) {
      out += line.slice(i, j);
      i = j;
      continue;
    }
    spans.push(line.slice(i, closer));
    out += `\x00${spans.length - 1}\x00`;
    i = closer;
  }
  return { protected: out, spans };
}

/**
 * Strip markup a model cannot use from page text bound for a prompt.
 *
 * Markdown images and `<img>` tags are removed. Links with an absolute URL are
 * kept as written; relative links are resolved against `baseUrl` (the page the
 * text came from), or reduced to their text when that is not possible.
 * Markdown tables are flattened: delimiter rows (`|---|:-:|`) are dropped, and
 * each row becomes its non-empty cells joined with " · " and ended with ";"
 * (`\|` is a literal pipe), so rows stay apart once whitespace is collapsed;
 * a row left with no cells is dropped. A line is a row when it sits under
 * another row or over a delimiter row, or has a row's shape on its own
 * (`| a | b |`). Fenced code blocks and inline
 * code spans are left alone, and so is `name[i](x)`, which is code rather than
 * a link. Other lines are tidied only if they changed: runs of spaces
 * squeezed, and the line dropped if nothing but pipes and dashes is left. Text
 * without images, links or tables is returned unchanged.
 */
export function cleanContextText(text: string, baseUrl: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let fence: string | undefined;
  let inTable = false;
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
      inTable = false;
      out.push(line);
      return;
    }
    if (isTableDelimiter(line)) {
      inTable = true;
      return;
    }

    const { protected: protectedLine, spans } = protectCodeSpans(line);
    let cleaned = protectedLine.replace(MD_IMAGE, "").replace(HTML_IMAGE, "");
    cleaned = cleaned.replace(
      MD_LINK,
      (match: string, linkText: string, href: string, offset: number, whole: string) =>
        resolveLink(match, linkText, href, offset, whole, baseUrl),
    );
    // A table row has a cell pipe and sits under another row or over a
    // delimiter row, or has a row's shape on its own (a snippet can start
    // below the header).
    if (
      cellPipes(cleaned) > 0 &&
      (inTable ||
        (i + 1 < lines.length && isTableDelimiter(lines[i + 1] ?? "")) ||
        looksLikeRow(cleaned))
    ) {
      inTable = true;
      const cells = tableCells(cleaned);
      if (cells.length) {
        const row = restoreCodeSpans(cells.join(" · "), spans);
        out.push(row.endsWith(";") ? row : `${row};`);
      }
      return;
    }
    inTable = false;
    if (cleaned === protectedLine) {
      out.push(line);
      return;
    }
    const indent = /^[ \t]*/.exec(cleaned)?.[0] ?? "";
    cleaned = indent + cleaned.slice(indent.length).replace(/[ \t]+/g, " ").trimEnd();
    if (ONLY_TABLE_RULE.test(cleaned)) return;
    out.push(restoreCodeSpans(cleaned, spans));
  });
  return out.join("\n");
}

/**
 * Cut `text` to `limit` characters at a word boundary, ending in "…".
 *
 * The cut falls at the last space at or before `limit` (a hard cut when there
 * is none). Text at or under the limit, or a `limit` of `null`, `Infinity` or
 * below 1, leaves the text as is.
 */
export function capSnippet(text: string, limit: number | null): string {
  if (limit === null || !(limit >= 1) || text.length <= limit) return text;
  // Count the limit in code points, as the Python and Go SDKs do, so an emoji
  // costs one character and a hard cut never splits a surrogate pair.
  let end = 0;
  for (let points = 0; points < limit && end < text.length; points++) {
    end += (text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  }
  if (end >= text.length) return text;
  const space = text.lastIndexOf(" ", end);
  const head = space > 0 ? text.slice(0, space) : text.slice(0, end);
  return `${head.trimEnd()}…`;
}
