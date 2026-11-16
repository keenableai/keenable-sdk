package keenable_test

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/keenableai/keenable-sdk/go"
)

// The anonymous client ID of a keyless client. Every test here has its own
// temporary config directory; TestMain gives the other tests one.

const (
	clientToken = "kc1.AbC-dEf_123.s1x2y3.q9"
	otherToken  = "kc1.other-token"
	clientIDHdr = "X-Keenable-Client"
)

// configDir points the config directory at a new temporary one and returns
// the client-id file inside it.
func configDir(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	t.Setenv("KEENABLE_NO_CLIENT_ID", "")
	return filepath.Join(dir, "keenable", "client-id")
}

func storeID(t *testing.T, file, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readID(t *testing.T, file string) string {
	t.Helper()
	got, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(got)
}

// issuing answers every request with status, sending each of ids as an
// X-Keenable-Client header.
func issuing(status int, ids ...string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		for _, id := range ids {
			w.Header().Add(clientIDHdr, id)
		}
		body := `{"query":"q","results":[],"content":"c"}`
		if status != http.StatusOK {
			body = `{"error":"e"}`
		}
		raw(status, body)(w, r)
	})
}

// sentIDs is the X-Keenable-Client values each request carried, "" for none.
func sentIDs(seen *[]captured) []string {
	captureMu.Lock()
	defer captureMu.Unlock()
	out := []string{}
	for _, req := range *seen {
		out = append(out, strings.Join(req.Header.Values(clientIDHdr), "|"))
	}
	return out
}

func searches(t *testing.T, c *keenable.Client, times int) {
	t.Helper()
	for i := 0; i < times; i++ {
		_, _ = c.Search(context.Background(), "q", nil)
	}
}

func wantIDs(t *testing.T, seen *[]captured, want ...string) {
	t.Helper()
	if got := sentIDs(seen); !reflect.DeepEqual(got, want) {
		t.Fatalf("sent client IDs %q, want %q", got, want)
	}
}

func TestClientIDIssuedIsSentNextAndWritten(t *testing.T) {
	file := configDir(t)
	c, seen := startKeyless(t, issuing(http.StatusOK, clientToken), nil)
	searches(t, c, 2)
	if _, err := c.Fetch(context.Background(), "https://example.com/"); err != nil {
		t.Fatal(err)
	}
	wantIDs(t, seen, "", clientToken, clientToken)
	if !strings.HasSuffix((*seen)[0].Path, "/public") {
		t.Fatalf("path %q is not keyless", (*seen)[0].Path)
	}
	if got := readID(t, file); got != clientToken+"\n" {
		t.Fatalf("file holds %q", got)
	}
	entries, err := os.ReadDir(filepath.Dir(file))
	if err != nil || len(entries) != 1 {
		t.Fatalf("directory entries: %v %v", entries, err)
	}
	if runtime.GOOS != "windows" {
		for path, want := range map[string]os.FileMode{file: 0o600, filepath.Dir(file): 0o700} {
			info, err := os.Stat(path)
			if err != nil {
				t.Fatal(err)
			}
			if got := info.Mode().Perm(); got != want {
				t.Errorf("%s has mode %o, want %o", path, got, want)
			}
		}
	}
}

func TestClientIDFromAnErrorResponseIsCarriedByTheRetry(t *testing.T) {
	file := configDir(t)
	c, seen := startKeyless(t, issuing(http.StatusTooManyRequests, clientToken), &keenable.Options{MaxRetries: intPtr(1)})
	searches(t, c, 1)
	keenable.TakeWaits()
	wantIDs(t, seen, "", clientToken)
	if got := readID(t, file); got != clientToken+"\n" {
		t.Fatalf("file holds %q", got)
	}
}

func TestClientIDStoredIsSentOnTheFirstRequest(t *testing.T) {
	file := configDir(t)
	storeID(t, file, "  "+clientToken+"  \n")
	c, seen := startKeyless(t, issuing(http.StatusOK, clientToken), nil)
	searches(t, c, 2)
	wantIDs(t, seen, clientToken, clientToken)
	// Nothing changed, so nothing was written.
	if got := readID(t, file); got != "  "+clientToken+"  \n" {
		t.Fatalf("file was rewritten: %q", got)
	}
}

func TestClientIDNewOneReplacesTheStoredOne(t *testing.T) {
	file := configDir(t)
	storeID(t, file, clientToken+"\n")
	c, seen := startKeyless(t, issuing(http.StatusOK, otherToken), nil)
	searches(t, c, 2)
	wantIDs(t, seen, clientToken, otherToken)
	if got := readID(t, file); got != otherToken+"\n" {
		t.Fatalf("file holds %q", got)
	}
}

func TestClientIDFileIsReadOncePerClient(t *testing.T) {
	file := configDir(t)
	storeID(t, file, clientToken+"\n")
	c, seen := startKeyless(t, issuing(http.StatusOK), nil)
	searches(t, c, 1)
	storeID(t, file, otherToken+"\n")
	searches(t, c, 1)
	wantIDs(t, seen, clientToken, clientToken)
}

func TestClientIDInvalidFileIsNoID(t *testing.T) {
	for _, stored := range []string{"", "not a token", "a/b", strings.Repeat("a", 129), "one\ntwo"} {
		t.Run(stored, func(t *testing.T) {
			file := configDir(t)
			storeID(t, file, stored+"\n")
			c, seen := startKeyless(t, issuing(http.StatusOK), nil)
			searches(t, c, 1)
			wantIDs(t, seen, "")
		})
	}
}

func TestClientIDIsNotUsedWithAnAPIKey(t *testing.T) {
	file := configDir(t)
	storeID(t, file, clientToken+"\n")
	key := "k"
	c, seen := start(t, issuing(http.StatusOK, otherToken), &keenable.Options{APIKey: &key})
	searches(t, c, 2)
	wantIDs(t, seen, "", "")
	if strings.HasSuffix((*seen)[0].Path, "/public") {
		t.Fatalf("path %q is keyless", (*seen)[0].Path)
	}
	if got := readID(t, file); got != clientToken+"\n" {
		t.Fatalf("file holds %q", got)
	}
}

func TestClientIDIsNotUsedWithAKeyFromTheEnvironment(t *testing.T) {
	file := configDir(t)
	t.Setenv("KEENABLE_API_KEY", "k")
	c, seen := start(t, issuing(http.StatusOK, clientToken), nil)
	searches(t, c, 2)
	wantIDs(t, seen, "", "")
	if _, err := os.Stat(filepath.Dir(file)); !os.IsNotExist(err) {
		t.Fatalf("the config directory was created: %v", err)
	}
}

func TestClientIDOptOut(t *testing.T) {
	off := false
	for name, tc := range map[string]struct {
		opts *keenable.Options
		env  string
	}{
		"option": {&keenable.Options{AnonymousClientID: &off}, ""},
		"env":    {nil, "1"},
	} {
		t.Run(name, func(t *testing.T) {
			file := configDir(t)
			// A stored ID that is not sent was not read, and a file that
			// still holds it was not written.
			storeID(t, file, clientToken+"\n")
			t.Setenv("KEENABLE_NO_CLIENT_ID", tc.env)
			c, seen := startKeyless(t, issuing(http.StatusOK, otherToken), tc.opts)
			searches(t, c, 2)
			wantIDs(t, seen, "", "")
			if got := readID(t, file); got != clientToken+"\n" {
				t.Fatalf("file holds %q", got)
			}
		})
	}
}

func TestClientIDOptionTrueAndEmptyEnvLeaveItOn(t *testing.T) {
	configDir(t)
	on := true
	c, seen := startKeyless(t, issuing(http.StatusOK, clientToken), &keenable.Options{AnonymousClientID: &on})
	searches(t, c, 2)
	wantIDs(t, seen, "", clientToken)
}

func TestClientIDMalformedHeaderIsIgnored(t *testing.T) {
	for name, ids := range map[string][]string{
		"empty":       {""},
		"a space":     {"has space"},
		"a slash":     {"a/b"},
		"too long":    {strings.Repeat("a", 129)},
		"two in one":  {"kc1.a, kc1.b"},
		"two headers": {"kc1.a", "kc1.b"},
	} {
		t.Run(name, func(t *testing.T) {
			file := configDir(t)
			c, seen := startKeyless(t, issuing(http.StatusOK, ids...), nil)
			searches(t, c, 2)
			wantIDs(t, seen, "", "")
			if _, err := os.Stat(filepath.Dir(file)); !os.IsNotExist(err) {
				t.Fatalf("the config directory was created: %v", err)
			}
		})
	}
}

func TestClientIDMalformedHeaderKeepsTheStoredOne(t *testing.T) {
	file := configDir(t)
	storeID(t, file, clientToken+"\n")
	c, seen := startKeyless(t, issuing(http.StatusOK, "not a token"), nil)
	searches(t, c, 2)
	wantIDs(t, seen, clientToken, clientToken)
	if got := readID(t, file); got != clientToken+"\n" {
		t.Fatalf("file holds %q", got)
	}
}

func TestClientIDServerThatNeverSendsItChangesNothing(t *testing.T) {
	file := configDir(t)
	c, seen := startKeyless(t, issuing(http.StatusOK), nil)
	searches(t, c, 2)
	wantIDs(t, seen, "", "")
	if _, err := os.Stat(filepath.Dir(file)); !os.IsNotExist(err) {
		t.Fatalf("the config directory was created: %v", err)
	}
}

func TestClientIDUnwritableConfigDirKeepsItInMemory(t *testing.T) {
	// A file where the directory should be: nothing under it can be created.
	blocker := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocker, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("XDG_CONFIG_HOME", blocker)
	t.Setenv("KEENABLE_NO_CLIENT_ID", "")
	c, seen := startKeyless(t, issuing(http.StatusOK, clientToken), nil)
	if _, err := c.Search(context.Background(), "q", nil); err != nil {
		t.Fatalf("an unwritable config directory failed the call: %v", err)
	}
	searches(t, c, 1)
	wantIDs(t, seen, "", clientToken)
}

func TestClientIDFailedRenameLeavesNoTemporaryFile(t *testing.T) {
	file := configDir(t)
	// The target is a directory, so it cannot be read and the rename fails.
	if err := os.MkdirAll(file, 0o700); err != nil {
		t.Fatal(err)
	}
	c, seen := startKeyless(t, issuing(http.StatusOK, clientToken), nil)
	searches(t, c, 2)
	wantIDs(t, seen, "", clientToken)
	entries, err := os.ReadDir(filepath.Dir(file))
	if err != nil || len(entries) != 1 || entries[0].Name() != "client-id" {
		t.Fatalf("directory entries: %v %v", entries, err)
	}
}

func TestClientIDIsSharedByConcurrentCalls(t *testing.T) {
	file := configDir(t)
	c, seen := startKeyless(t, issuing(http.StatusOK, clientToken), nil)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = c.Search(context.Background(), "q", nil)
		}()
	}
	wg.Wait()
	searches(t, c, 1)
	ids := sentIDs(seen)
	if ids[len(ids)-1] != clientToken {
		t.Fatalf("the last request carried %q", ids[len(ids)-1])
	}
	for _, id := range ids {
		if id != "" && id != clientToken {
			t.Fatalf("a request carried %q", id)
		}
	}
	if got := readID(t, file); got != clientToken+"\n" {
		t.Fatalf("file holds %q", got)
	}
	if entries, _ := os.ReadDir(filepath.Dir(file)); len(entries) != 1 {
		t.Fatalf("directory entries: %v", entries)
	}
}
