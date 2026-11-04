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
	fenceLine     = regexp.MustCompile("^[ \t]*(`{3,}|~{3,})(.*)$")
	codeSpan      = regexp.MustCompile("`+[^`\n]*`+")
	placeholder   = regexp.MustCompile("\x00([0-9]+)\x00")
)

// cleanContextText strips markup a model cannot use from page text bound for
// a prompt.
//
// Markdown images and <img> tags are removed. Links with an absolute URL are
// kept as written; relative links are resolved against baseURL (the page the
// text came from), or reduced to their text when that is not possible. Fenced
// code blocks and inline code spans are left alone, and so is name[i](x),
// which is code rather than a link. Only lines that changed are tidied: runs
// of spaces squeezed, and the line dropped if nothing but table pipes and
// dashes is left (unless it is a table's header row). Text without such markup
// is returned unchanged.
func cleanContextText(text, baseURL string) string {
	var base *url.URL
	if u, err := url.Parse(baseURL); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
		base = u
	}
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	fence := ""
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
			out = append(out, line)
			continue
		}

		var spans []string
		protected := line
		if !strings.Contains(line, "\x00") {
			protected = codeSpan.ReplaceAllStringFunc(line, func(span string) string {
				spans = append(spans, span)
				return "\x00" + strconv.Itoa(len(spans)-1) + "\x00"
			})
		}
		cleaned := htmlImage.ReplaceAllString(mdImage.ReplaceAllString(protected, ""), "")
		cleaned = replaceLinks(cleaned, base)
		if cleaned == protected {
			out = append(out, line)
			continue
		}
		rest := strings.TrimLeft(cleaned, " \t")
		indent := cleaned[:len(cleaned)-len(rest)]
		cleaned = indent + strings.TrimRightFunc(spaceRun.ReplaceAllString(rest, " "), unicode.IsSpace)
		if onlyTableRule.MatchString(cleaned) &&
			!(strings.Contains(cleaned, "|") && i+1 < len(lines) && isTableDelimiter(lines[i+1])) {
			continue
		}
		if len(spans) > 0 {
			cleaned = placeholder.ReplaceAllStringFunc(cleaned, func(p string) string {
				n, err := strconv.Atoi(p[1 : len(p)-1])
				if err != nil || n >= len(spans) {
					return p
				}
				return spans[n]
			})
		}
		out = append(out, cleaned)
	}
	return strings.Join(out, "\n")
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
		// handlers[name](event) and fns[i]() are code, not links.
		if m[0] > 0 && isWordByte(line[m[0]-1]) {
			b.WriteString(match)
		} else {
			b.WriteString(resolveLink(match, line[m[2]:m[3]], line[m[4]:m[5]], base))
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
