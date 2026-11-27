package keenable

import (
	"runtime"
	"strings"
)

// userAgent is the User-Agent the client sends:
// "keenable-go/<Version> go/<Go version> <GOOS>/<GOARCH>", for example
// "keenable-go/0.4.0 go/1.23.4 linux/amd64". Nothing else is sent: no host
// name, user, path, key or locale. A caller's User-Agent in Options.Headers
// or RequestOptions.Headers replaces it. The formatting rule is shared with
// the other SDKs (scripts/conformance/README.md).
var userAgent = formatUserAgent([][2]string{
	{"keenable-go", Version},
	{"go", strings.TrimPrefix(runtime.Version(), "go")},
	{runtime.GOOS, runtime.GOARCH},
})

const maxUserAgentPart = 64

func isUserAgentByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return c == '.' || c == '_' || c == '+' || c == '-'
}

// cleanUserAgentPart turns every run of characters other than ASCII letters,
// digits, ".", "_", "+" and "-" into one "-", cuts the result to 64
// characters, then drops leading and trailing "-".
func cleanUserAgentPart(s string) string {
	var b strings.Builder
	dash := false
	for _, r := range s {
		if r < 0x80 && isUserAgentByte(byte(r)) {
			b.WriteRune(r)
			dash = false
		} else if !dash {
			b.WriteByte('-')
			dash = true
		}
	}
	out := b.String()
	if len(out) > maxUserAgentPart {
		out = out[:maxUserAgentPart]
	}
	return strings.Trim(out, "-")
}

// formatUserAgent writes "name/version" per part, space-separated, each half
// cleaned. A part whose name cleans to nothing is left out; one whose version
// cleans to nothing is its name alone.
func formatUserAgent(parts [][2]string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		name, version := cleanUserAgentPart(p[0]), cleanUserAgentPart(p[1])
		switch {
		case name == "":
		case version == "":
			out = append(out, name)
		default:
			out = append(out, name+"/"+version)
		}
	}
	return strings.Join(out, " ")
}
