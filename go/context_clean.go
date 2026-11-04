package keenable

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

// Markup that means nothing to a model once the page is flattened into a
// prompt. The patterns are kept in step with the Python and TypeScript SDKs.
var (
	mdImage       = regexp.MustCompile(`!\[[^\]\n]*\]\([^)\n]*\)`)
	htmlImage     = regexp.MustCompile(`(?i)<img\b[^>]*>`)
	mdLink        = regexp.MustCompile(`\[([^\[\]\n]*)\]\(([^()\s]*)(?:\s+"[^"\n]*")?\)`)
	urlScheme     = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9+.-]*:`)
	spaceRun      = regexp.MustCompile(`[ \t]+`)
	onlyTableRule = regexp.MustCompile(`^[\s|:-]*$`)
)

// cleanContextText strips markup a model cannot use from page text bound for
// a prompt.
//
// Markdown images and <img> tags are removed. Links with an absolute URL are
// kept as written; relative links are resolved against baseURL (the page the
// text came from), or reduced to their text when that is not possible. Only
// lines that changed are tidied: runs of spaces squeezed, and the line dropped
// if nothing but table pipes and dashes is left. Text without such markup is
// returned unchanged.
func cleanContextText(text, baseURL string) string {
	var base *url.URL
	if u, err := url.Parse(baseURL); err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != "" {
		base = u
	}
	lines := strings.Split(text, "\n")
	out := make([]string, 0, len(lines))
	for _, line := range lines {
		cleaned := htmlImage.ReplaceAllString(mdImage.ReplaceAllString(line, ""), "")
		cleaned = mdLink.ReplaceAllStringFunc(cleaned, func(match string) string {
			return resolveLink(match, base)
		})
		if cleaned == line {
			out = append(out, line)
			continue
		}
		rest := strings.TrimLeft(cleaned, " \t")
		indent := cleaned[:len(cleaned)-len(rest)]
		cleaned = indent + strings.TrimRightFunc(spaceRun.ReplaceAllString(rest, " "), unicode.IsSpace)
		if onlyTableRule.MatchString(cleaned) {
			continue
		}
		out = append(out, cleaned)
	}
	return strings.Join(out, "\n")
}

func resolveLink(match string, base *url.URL) string {
	parts := mdLink.FindStringSubmatch(match)
	text, href := parts[1], parts[2]
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
