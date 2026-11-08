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

/** Whether `line` has a `|` that is not escaped as `\|`. */
function hasCellPipe(line: string): boolean {
  let i = line.indexOf("|");
  while (i !== -1) {
    if (i === 0 || line.charAt(i - 1) !== "\\") return true;
    i = line.indexOf("|", i + 1);
  }
  return false;
}

/** The non-empty cells of a table row, trimmed, with `\|` read as `|`. */
function tableCells(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line.charAt(i);
    if (ch === "\\" && line.charAt(i + 1) === "|") {
      cell += "|";
      i += 1;
    } else if (ch === "|") {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
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
 * a row left with no cells is dropped. Fenced code blocks and inline
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
    // A table row: it starts with a pipe, or it has one and sits under a
    // header (the next line is a delimiter row) or under another row.
    if (
      hasCellPipe(cleaned) &&
      (cleaned.trimStart().startsWith("|") ||
        inTable ||
        (i + 1 < lines.length && isTableDelimiter(lines[i + 1] ?? "")))
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
  const space = text.lastIndexOf(" ", limit);
  let head = space > 0 ? text.slice(0, space) : text.slice(0, limit);
  // A hard cut must not split a surrogate pair.
  if (space <= 0 && /[\uD800-\uDBFF]$/.test(head)) head = head.slice(0, -1);
  return `${head.trimEnd()}…`;
}
