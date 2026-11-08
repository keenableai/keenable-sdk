package keenable

import (
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
)

// Markup that means nothing to a model once the page is flattened into a
// prompt. The patterns are kept in step with the Python and TypeScript SDKs,
// whose backtracking engines need each repeated group to have alternatives
// that start with different characters; Go's engine is linear regardless.
//
// Image alt text may hold one level of [brackets] and the URL one level of
// (parentheses), as in Wikipedia's File_(1).png; a title rides along inside.
var (
	mdImage       = regexp.MustCompile(`!\[(?:[^\[\]\n]|\[[^\[\]\n]*\])*\]\((?:[^()\n]|\([^()\n]*\))*\)`)
	htmlImage     = regexp.MustCompile(`(?i)<img\b(?:[^<>"']|"[^"\n]*"|'[^'\n]*')*>`)
	mdLink        = regexp.MustCompile(`\[([^\[\]\n]*)\]\(((?:[^()\s]|\([^()\s]*\))*)(?:\s+"[^"\n]*")?\)`)
	urlScheme     = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
	spaceRun      = regexp.MustCompile(`[ \t]+`)
	onlyTableRule = regexp.MustCompile(`^[ \t|:-]*$`)
	// CommonMark: optional blockquote markers, then at most 3 spaces before a fence.
	fenceLine   = regexp.MustCompile("^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})(.*)$")
	placeholder = regexp.MustCompile("\x00([0-9]+)\x00")
	codeIdent   = regexp.MustCompile(`^[A-Za-z0-9_]*$`)
)

// cleanContextText strips markup a model cannot use from page text bound for
// a prompt.
//
// Markdown images and <img> tags are removed. Links with an absolute URL are
// kept as written; relative links are resolved against baseURL (the page the
// text came from), or reduced to their text when that is not possible.
// Markdown tables are flattened: delimiter rows (|---|:-:|) are dropped, and
// each row becomes its non-empty cells joined with " · " and ended with ";"
// (\| is a literal pipe), so rows stay apart once whitespace is collapsed;
// a row left with no cells is dropped. Fenced code blocks and inline
// code spans are left alone, and so is name[i](x), which is code rather than
// a link. Other lines are tidied only if they changed: runs of spaces
// squeezed, and the line dropped if nothing but pipes and dashes is left.
// Text without images, links or tables is returned unchanged.
func cleanContextText(text, baseURL string) string {
	var base *url.URL
	if u, err := url.Parse(baseURL); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
		base = u
	}
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	fence := ""
	inTable := false
	for i, line := range lines {
		marker := fenceLine.FindStringSubmatch(line)
		run, info := "", ""
		if marker != nil {
			run, info = marker[1], marker[2]
		}
		if fence != "" {
			out = append(out, line)
			if run != "" && run[0] == fence[0] && len(run) >= len(fence) && strings.TrimSpace(info) == "" {
				fence = ""
			}
			continue
		}
		if run != "" && !(run[0] == '`' && strings.Contains(info, "`")) {
			fence = run
			inTable = false
			out = append(out, line)
			continue
		}
		if isTableDelimiter(line) {
			inTable = true
			continue
		}

		protected, spans := protectCodeSpans(line)
		cleaned := htmlImage.ReplaceAllString(mdImage.ReplaceAllString(protected, ""), "")
		cleaned = replaceLinks(cleaned, base)
		// A table row: it starts with a pipe, or it has one and sits under a
		// header (the next line is a delimiter row) or under another row.
		if hasCellPipe(cleaned) && (strings.HasPrefix(strings.TrimLeftFunc(cleaned, unicode.IsSpace), "|") ||
			inTable || (i+1 < len(lines) && isTableDelimiter(lines[i+1]))) {
			inTable = true
			if cells := tableCells(cleaned); len(cells) > 0 {
				row := restoreCodeSpans(strings.Join(cells, " · "), spans)
				if !strings.HasSuffix(row, ";") {
					row += ";"
				}
				out = append(out, row)
			}
			continue
		}
		inTable = false
		if cleaned == protected {
			out = append(out, line)
			continue
		}
		rest := strings.TrimLeft(cleaned, " \t")
		indent := cleaned[:len(cleaned)-len(rest)]
		cleaned = indent + strings.TrimRightFunc(spaceRun.ReplaceAllString(rest, " "), unicode.IsSpace)
		if onlyTableRule.MatchString(cleaned) {
			continue
		}
		out = append(out, restoreCodeSpans(cleaned, spans))
	}
	return strings.Join(out, "\n")
}

// protectCodeSpans swaps inline code spans for placeholders. Opening and
// closing backtick runs must be the same length, so a shorter run inside a
// longer span stays protected.
func protectCodeSpans(line string) (string, []string) {
	var spans []string
	if strings.Contains(line, "\x00") {
		return line, spans
	}
	var b strings.Builder
	i := 0
	for i < len(line) {
		if line[i] != '`' {
			b.WriteByte(line[i])
			i++
			continue
		}
		j := i
		for j < len(line) && line[j] == '`' {
			j++
		}
		openLen := j - i
		k := j
		closer := -1
		for k < len(line) {
			if line[k] != '`' {
				k++
				continue
			}
			end := k
			for end < len(line) && line[end] == '`' {
				end++
			}
			if end-k == openLen {
				closer = end
				break
			}
			k = end
		}
		if closer < 0 {
			b.WriteString(line[i:j])
			i = j
			continue
		}
		spans = append(spans, line[i:closer])
		b.WriteByte(0)
		b.WriteString(strconv.Itoa(len(spans) - 1))
		b.WriteByte(0)
		i = closer
	}
	return b.String(), spans
}

func restoreCodeSpans(text string, spans []string) string {
	if len(spans) == 0 {
		return text
	}
	return placeholder.ReplaceAllStringFunc(text, func(p string) string {
		n, err := strconv.Atoi(p[1 : len(p)-1])
		if err != nil || n >= len(spans) {
			return p
		}
		return spans[n]
	})
}

// hasCellPipe reports whether line has a | that is not escaped as \|.
func hasCellPipe(line string) bool {
	for i := 0; i < len(line); i++ {
		if line[i] == '|' && (i == 0 || line[i-1] != '\\') {
			return true
		}
	}
	return false
}

// tableCells returns the non-empty cells of a table row, trimmed, with \|
// read as |.
func tableCells(line string) []string {
	var cells []string
	var cell strings.Builder
	flush := func() {
		c := strings.TrimSpace(spaceRun.ReplaceAllString(cell.String(), " "))
		if c != "" {
			cells = append(cells, c)
		}
		cell.Reset()
	}
	for i := 0; i < len(line); i++ {
		switch {
		case line[i] == '\\' && i+1 < len(line) && line[i+1] == '|':
			cell.WriteByte('|')
			i++
		case line[i] == '|':
			flush()
		default:
			cell.WriteByte(line[i])
		}
	}
	flush()
	return cells
}

func isTableDelimiter(line string) bool {
	return strings.Contains(line, "|") && strings.Contains(line, "-") &&
		onlyTableRule.MatchString(strings.TrimRightFunc(line, unicode.IsSpace))
}

func isWordByte(b byte) bool {
	return b == '_' || ('0' <= b && b <= '9') || ('a' <= b && b <= 'z') || ('A' <= b && b <= 'Z')
}

// replaceLinks rewrites every markdown link in line through resolveLink.
func replaceLinks(line string, base *url.URL) string {
	matches := mdLink.FindAllStringSubmatchIndex(line, -1)
	if matches == nil {
		return line
	}
	var b strings.Builder
	last := 0
	for _, m := range matches {
		b.WriteString(line[last:m[0]])
		match := line[m[0]:m[1]]
		href := line[m[4]:m[5]]
		// handlers[name](event) and fns[i]() are code, not links. Ordinary
		// adjacent links like docs[API](/api) still resolve.
		if m[0] > 0 && isWordByte(line[m[0]-1]) && codeIdent.MatchString(href) {
			b.WriteString(match)
		} else {
			b.WriteString(resolveLink(match, line[m[2]:m[3]], href, base))
		}
		last = m[1]
	}
	b.WriteString(line[last:])
	return b.String()
}

func resolveLink(match, text, href string, base *url.URL) string {
	// A code span inside the URL would not survive URL normalisation.
	if strings.Contains(href, "\x00") {
		return match
	}
	if strings.TrimSpace(text) == "" {
		return ""
	}
	if urlScheme.MatchString(href) {
		return match
	}
	if href == "" || base == nil {
		return text
	}
	ref, err := url.Parse(href)
	if err != nil {
		return text
	}
	return "[" + text + "](" + base.ResolveReference(ref).String() + ")"
}
