//! Strips markup a model cannot use from page text bound for a prompt. Kept in
//! step with the Go, Python and TypeScript SDKs.

use std::sync::LazyLock;

use regex::Regex;
use url::Url;

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("a valid pattern")
}

// Image alt text may hold one level of [brackets] and the URL one level of
// (parentheses), as in Wikipedia's File_(1).png; a title rides along inside.
static MD_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| re(r"!\[(?:[^\[\]\n]|\[[^\[\]\n]*\])*\]\((?:[^()\n]|\([^()\n]*\))*\)"));
static HTML_IMAGE: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(?i)<img\b(?:[^<>"']|"[^"\n]*"|'[^'\n]*')*>"#));
static MD_LINK: LazyLock<Regex> =
    LazyLock::new(|| re(r#"\[([^\[\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"\n]*")?\)"#));
static URL_SCHEME: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z][A-Za-z0-9+.-]*:"));
static SPACE_RUN: LazyLock<Regex> = LazyLock::new(|| re(r"[ \t]+"));
static ONLY_TABLE_RULE: LazyLock<Regex> = LazyLock::new(|| re(r"^[ \t|:-]*$"));
// CommonMark: optional blockquote markers, then at most 3 spaces before a fence.
static FENCE_LINE: LazyLock<Regex> =
    LazyLock::new(|| re(r"^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})(.*)$"));
static PLACEHOLDER: LazyLock<Regex> = LazyLock::new(|| re(r"\x00([0-9]+)\x00"));
static CODE_IDENT: LazyLock<Regex> = LazyLock::new(|| re(r"^[A-Za-z0-9_]*$"));

/// Strips markup a model cannot use from page text.
///
/// Markdown images and `<img>` tags are removed. Links with an absolute URL
/// are kept as written; relative links are resolved against `base_url` (the
/// page the text came from), or reduced to their text when that is not
/// possible. Markdown tables are flattened: delimiter rows are dropped, and
/// each row becomes its non-empty cells joined with " · " and ended with ";".
/// Fenced code blocks and inline code spans are left alone. Text without
/// images, links or tables is returned unchanged.
pub(crate) fn clean_context_text(text: &str, base_url: &str) -> String {
    let base = Url::parse(base_url)
        .ok()
        .filter(|u| matches!(u.scheme(), "http" | "https") && u.host().is_some());
    let lines: Vec<&str> = text.split('\n').collect();
    let mut out: Vec<String> = Vec::with_capacity(lines.len());
    let mut fence = String::new();
    let mut in_table = false;
    for (i, line) in lines.iter().enumerate() {
        let line = *line;
        let (run, info) = match FENCE_LINE.captures(line) {
            Some(m) => (
                m.get(1).map_or("", |x| x.as_str()),
                m.get(2).map_or("", |x| x.as_str()),
            ),
            None => ("", ""),
        };
        if !fence.is_empty() {
            out.push(line.to_string());
            if !run.is_empty()
                && run.as_bytes()[0] == fence.as_bytes()[0]
                && run.len() >= fence.len()
                && info.trim().is_empty()
            {
                fence.clear();
            }
            continue;
        }
        if !run.is_empty() && !(run.starts_with('`') && info.contains('`')) {
            fence = run.to_string();
            in_table = false;
            out.push(line.to_string());
            continue;
        }
        if is_table_delimiter(line) {
            in_table = true;
            continue;
        }

        let (protected, spans) = protect_code_spans(line);
        let no_images = MD_IMAGE.replace_all(&protected, "");
        let no_images = HTML_IMAGE.replace_all(&no_images, "");
        let cleaned = replace_links(&no_images, base.as_ref());
        // A table row has a cell pipe and sits under another row or over a
        // delimiter row, or has a row's shape on its own (a snippet can start
        // below the header).
        if cell_pipes(&cleaned) > 0
            && (in_table
                || lines
                    .get(i + 1)
                    .is_some_and(|next| is_table_delimiter(next))
                || looks_like_row(&cleaned))
        {
            in_table = true;
            let cells = table_cells(&cleaned);
            if !cells.is_empty() {
                let mut row = restore_code_spans(&cells.join(" · "), &spans);
                if !row.ends_with(';') {
                    row.push(';');
                }
                out.push(row);
            }
            continue;
        }
        in_table = false;
        if cleaned == protected {
            out.push(line.to_string());
            continue;
        }
        let rest = cleaned.trim_start_matches([' ', '\t']);
        let indent = &cleaned[..cleaned.len() - rest.len()];
        let squeezed = SPACE_RUN.replace_all(rest, " ");
        let tidied = format!("{indent}{}", squeezed.trim_end());
        if ONLY_TABLE_RULE.is_match(&tidied) {
            continue;
        }
        out.push(restore_code_spans(&tidied, &spans));
    }
    out.join("\n")
}

/// Swaps inline code spans for placeholders. Opening and closing backtick
/// runs must be the same length, so a shorter run inside a longer span stays
/// protected.
fn protect_code_spans(line: &str) -> (String, Vec<String>) {
    let mut spans = Vec::new();
    if line.contains('\0') {
        return (line.to_string(), spans);
    }
    let bytes = line.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] != b'`' {
            out.push(bytes[i]);
            i += 1;
            continue;
        }
        let mut j = i;
        while j < bytes.len() && bytes[j] == b'`' {
            j += 1;
        }
        let open_len = j - i;
        let mut k = j;
        let mut closer = None;
        while k < bytes.len() {
            if bytes[k] != b'`' {
                k += 1;
                continue;
            }
            let mut end = k;
            while end < bytes.len() && bytes[end] == b'`' {
                end += 1;
            }
            if end - k == open_len {
                closer = Some(end);
                break;
            }
            k = end;
        }
        match closer {
            None => {
                out.extend_from_slice(&bytes[i..j]);
                i = j;
            }
            Some(end) => {
                spans.push(line[i..end].to_string());
                out.push(0);
                out.extend_from_slice((spans.len() - 1).to_string().as_bytes());
                out.push(0);
                i = end;
            }
        }
    }
    // Only ASCII bytes were swapped, at character boundaries.
    (String::from_utf8(out).unwrap_or_default(), spans)
}

fn restore_code_spans(text: &str, spans: &[String]) -> String {
    if spans.is_empty() {
        return text.to_string();
    }
    PLACEHOLDER
        .replace_all(text, |caps: &regex::Captures<'_>| {
            let whole = caps.get(0).map_or("", |m| m.as_str()).to_string();
            match caps[1].parse::<usize>() {
                Ok(n) if n < spans.len() => spans[n].clone(),
                _ => whole,
            }
        })
        .into_owned()
}

/// Counts the `|` in a line that separate cells. A pipe after an odd run of
/// backslashes is escaped; after an even run the backslashes escape each
/// other.
fn cell_pipes(line: &str) -> usize {
    let mut count = 0;
    let mut backslashes = 0;
    for b in line.bytes() {
        if b == b'\\' {
            backslashes += 1;
            continue;
        }
        if b == b'|' && backslashes % 2 == 0 {
            count += 1;
        }
        backslashes = 0;
    }
    count
}

/// Whether a line has a row's shape on its own: `| a | b |`.
fn looks_like_row(line: &str) -> bool {
    let trimmed = line.trim_matches([' ', '\t', '\r']);
    let bytes = trimmed.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'|' || bytes[bytes.len() - 1] != b'|' {
        return false;
    }
    let body = &trimmed[..trimmed.len() - 1];
    let escapes = body.len() - body.trim_end_matches('\\').len();
    escapes % 2 == 0 && cell_pipes(trimmed) >= 3
}

/// The non-empty cells of a table row, trimmed, with `\|` read as `|`.
fn table_cells(line: &str) -> Vec<String> {
    let mut cells = Vec::new();
    let mut cell: Vec<u8> = Vec::new();
    let flush = |cell: &mut Vec<u8>, cells: &mut Vec<String>| {
        let text = String::from_utf8_lossy(cell);
        let c = SPACE_RUN.replace_all(&text, " ").trim().to_string();
        if !c.is_empty() {
            cells.push(c);
        }
        cell.clear();
    };
    let mut backslashes = 0;
    for b in line.bytes() {
        if b == b'|' && backslashes % 2 == 1 {
            if let Some(last) = cell.last_mut() {
                *last = b'|';
            }
        } else if b == b'|' {
            flush(&mut cell, &mut cells);
        } else {
            cell.push(b);
            if b == b'\\' {
                backslashes += 1;
            } else {
                backslashes = 0;
            }
            continue;
        }
        backslashes = 0;
    }
    flush(&mut cell, &mut cells);
    cells
}

fn is_table_delimiter(line: &str) -> bool {
    line.contains('|') && line.contains('-') && ONLY_TABLE_RULE.is_match(line.trim_end())
}

fn is_word_byte(b: u8) -> bool {
    b == b'_' || b.is_ascii_alphanumeric()
}

/// Rewrites every markdown link in a line through `resolve_link`.
fn replace_links(line: &str, base: Option<&Url>) -> String {
    let mut out = String::with_capacity(line.len());
    let mut last = 0;
    for caps in MD_LINK.captures_iter(line) {
        let whole = caps.get(0).expect("match");
        let text = caps.get(1).map_or("", |m| m.as_str());
        let href = caps.get(2).map_or("", |m| m.as_str());
        out.push_str(&line[last..whole.start()]);
        // handlers[name](event) and fns[i]() are code, not links. Ordinary
        // adjacent links like docs[API](/api) still resolve.
        if whole.start() > 0
            && is_word_byte(line.as_bytes()[whole.start() - 1])
            && CODE_IDENT.is_match(href)
        {
            out.push_str(whole.as_str());
        } else {
            out.push_str(&resolve_link(whole.as_str(), text, href, base));
        }
        last = whole.end();
    }
    out.push_str(&line[last..]);
    out
}

fn resolve_link(whole: &str, text: &str, href: &str, base: Option<&Url>) -> String {
    // A code span inside the URL would not survive URL normalisation.
    if href.contains('\0') {
        return whole.to_string();
    }
    if text.trim().is_empty() {
        return String::new();
    }
    if URL_SCHEME.is_match(href) {
        return whole.to_string();
    }
    let Some(base) = base.filter(|_| !href.is_empty()) else {
        return text.to_string();
    };
    match base.join(href) {
        Ok(url) => format!("[{text}]({url})"),
        Err(_) => text.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::clean_context_text as clean;

    #[test]
    fn drops_images() {
        assert_eq!(
            clean("before ![alt](https://e.com/a.png) after", "https://e.com/"),
            "before after"
        );
        assert_eq!(clean(r#"a <img src="x.png" alt="y"> b"#, ""), "a b");
    }

    #[test]
    fn resolves_relative_links() {
        assert_eq!(
            clean("see [docs](/api) now", "https://e.com/page"),
            "see [docs](https://e.com/api) now"
        );
        assert_eq!(clean("see [docs](/api) now", ""), "see docs now");
        assert_eq!(
            clean("[abs](https://x.com/y)", "https://e.com/"),
            "[abs](https://x.com/y)"
        );
    }

    #[test]
    fn keeps_code() {
        assert_eq!(
            clean("call handlers[name](event)", ""),
            "call handlers[name](event)"
        );
        assert_eq!(clean("`![x](y)` stays", ""), "`![x](y)` stays");
        let fenced = "```\n![x](y)\n```";
        assert_eq!(clean(fenced, ""), fenced);
    }

    #[test]
    fn flattens_tables() {
        let table = "| Plan | Price |\n|---|:-:|\n| Pro | $10 |\n| A \\| B | |";
        assert_eq!(clean(table, ""), "Plan · Price;\nPro · $10;\nA | B;");
    }

    #[test]
    fn leaves_plain_text_alone() {
        let text = "  two  spaces\tand a tab  ";
        assert_eq!(clean(text, ""), text);
    }
}
