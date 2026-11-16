package keenable

import (
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// The anonymous client ID a keyless client keeps.
//
// The API issues an opaque token to a keyless caller in the X-Keenable-Client
// response header, and the client sends it back on later keyless requests, so
// keyless traffic is told apart by an ID the server issued rather than by
// address. It identifies an installation, not a person, is not a credential
// and grants nothing. It is kept in <config dir>/keenable/client-id, the file
// the Keenable MCP bridge uses too, so one machine keeps one ID.
//
// The rules (which values are a token, where the file lives) are the same in
// the Python and TypeScript SDKs: see scripts/conformance/README.md.
const (
	clientIDHeader = "X-Keenable-Client"
	// clientIDOptOutEnv, set to any non-empty value, turns the ID off: never
	// read, written, sent or captured.
	clientIDOptOutEnv = "KEENABLE_NO_CLIENT_ID"
	maxClientIDLen    = 128
)

// validClientID reports whether v is a token: 1 to 128 characters of
// A-Z a-z 0-9 . _ -. The token is never parsed.
func validClientID(v string) bool {
	if v == "" || len(v) > maxClientIDLen {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.', c == '_', c == '-':
		default:
			return false
		}
	}
	return true
}

func isPathSeparator(c byte, windows bool) bool {
	return c == '/' || (windows && c == '\\')
}

func isAbsolutePath(p string, windows bool) bool {
	if p == "" {
		return false
	}
	if isPathSeparator(p[0], windows) {
		return true
	}
	if !windows || len(p) < 3 {
		return false
	}
	letter := p[0] | 0x20
	return letter >= 'a' && letter <= 'z' && p[1] == ':' && isPathSeparator(p[2], true)
}

func trimTrailingSeparators(p string, windows bool) string {
	for p != "" && isPathSeparator(p[len(p)-1], windows) {
		p = p[:len(p)-1]
	}
	return p
}

// clientIDPath is the client-id file, or "" when there is no directory to
// keep it in: $XDG_CONFIG_HOME when it is set and absolute; else %APPDATA% on
// Windows, falling back to ~/AppData/Roaming; else ~/.config.
func clientIDPath(env func(string) string, windows bool, home string) string {
	sep := "/"
	if windows {
		sep = `\`
	}
	var base string
	xdg, appData := env("XDG_CONFIG_HOME"), env("APPDATA")
	switch {
	case isAbsolutePath(xdg, windows):
		base = xdg
	case windows && appData != "":
		base = appData
	case home == "":
		return ""
	case windows:
		base = trimTrailingSeparators(home, windows) + sep + "AppData" + sep + "Roaming"
	default:
		base = trimTrailingSeparators(home, windows) + sep + ".config"
	}
	return trimTrailingSeparators(base, windows) + sep + "keenable" + sep + "client-id"
}

func defaultClientIDPath() string {
	// An unknown home directory is "": XDG_CONFIG_HOME or APPDATA can still
	// name the directory.
	home, _ := os.UserHomeDir()
	return clientIDPath(os.Getenv, runtime.GOOS == "windows", home)
}

// clientIDStore is one client's ID: loaded from the file once, then held in
// memory. It is safe for concurrent use. No filesystem failure is returned or
// logged: the ID then lives in memory for the client's lifetime.
type clientIDStore struct {
	mu     sync.Mutex
	loaded bool
	path   string
	token  string
}

// get is the ID to send, or "". It reads the file before the first request.
func (s *clientIDStore) get() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	return s.token
}

// capture keeps the ID a response carried. Anything that is not a token is
// ignored, as is more than one header.
func (s *clientIDStore) capture(h http.Header) {
	token := strings.Join(h.Values(clientIDHeader), ", ")
	if !validClientID(token) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.load()
	if token == s.token {
		return
	}
	s.token = token
	s.write(token)
}

func (s *clientIDStore) load() {
	if s.loaded {
		return
	}
	s.loaded = true
	s.path = defaultClientIDPath()
	if s.path == "" {
		return
	}
	file, err := os.Open(s.path)
	if err != nil {
		return
	}
	defer file.Close()
	// A token is at most 128 characters; a larger file is not one.
	buf := make([]byte, 1024)
	n, _ := file.Read(buf)
	if token := strings.TrimSpace(string(buf[:n])); validClientID(token) {
		s.token = token
	}
}

func (s *clientIDStore) write(token string) {
	if s.path == "" {
		return
	}
	dir := filepath.Dir(s.path)
	if os.MkdirAll(dir, 0o700) != nil {
		return
	}
	// CreateTemp makes the file readable and writable by its owner only.
	temp, err := os.CreateTemp(dir, "client-id.*.tmp")
	if err != nil {
		return
	}
	_, werr := temp.WriteString(token + "\n")
	cerr := temp.Close()
	if werr != nil || cerr != nil || os.Rename(temp.Name(), s.path) != nil {
		os.Remove(temp.Name())
	}
}
