// Package codex is the person's own Codex CLI as Friday sees it before a session: where it is,
// whether it is signed in, and its row in Providers (ported from engines/codex/backend.ts,
// WS-50.3). Running a session on Codex is still the TypeScript engine's until WS-50.8.
package codex

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// Provider and Label are how Codex is named to the rest of Friday.
const (
	Provider = "codex"
	Label    = "Codex (your ChatGPT plan)"
)

// InstallURL is where to get Codex.
const InstallURL = "https://developers.openai.com/codex/cli"

// LoginArgs sign in to Codex: its own flow, which the interface runs in the terminal.
var LoginArgs = []string{"login"}

// About says what Codex is, for the connect dialog.
const About = "Runs your own Codex on your ChatGPT plan. Signing in is Codex's own; Friday never sees your account."

// Find is Codex's path: ARCHYMEDES_CODEX_PATH, else the PATH, else where npm and Homebrew put it.
// "" when it is not installed.
func Find(getenv func(string) string) string {
	exists := func(file string) bool {
		info, err := os.Stat(file)
		return err == nil && !info.IsDir()
	}
	if override := strings.TrimSpace(getenv("ARCHYMEDES_CODEX_PATH")); override != "" {
		if exists(override) {
			return override
		}
		return ""
	}
	names := []string{"codex"}
	if runtime.GOOS == "windows" {
		names = []string{"codex.exe", "codex.cmd", "codex"}
	}
	dirs := filepath.SplitList(getenv("PATH"))
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".local", "bin"))
	}
	dirs = append(dirs, "/opt/homebrew/bin", "/usr/local/bin")
	for _, dir := range dirs {
		if dir == "" {
			continue
		}
		for _, name := range names {
			if candidate := filepath.Join(dir, name); exists(candidate) {
				return candidate
			}
		}
	}
	return ""
}

// Auth is whether Codex is signed in, and with what: "chatgpt" or "apiKey".
type Auth struct {
	LoggedIn bool
	Method   string
}

var loggedIn = regexp.MustCompile(`(?i)logged in`)
var apiKey = regexp.MustCompile(`(?i)api key`)

// ParseLoginStatus reads `codex login status`: "Logged in using ChatGPT" or "… an API key".
func ParseLoginStatus(exitCode int, output string) Auth {
	text := strings.TrimSpace(output)
	if exitCode == 0 && loggedIn.MatchString(text) {
		if apiKey.MatchString(text) {
			return Auth{LoggedIn: true, Method: "apiKey"}
		}
		return Auth{LoggedIn: true, Method: "chatgpt"}
	}
	return Auth{}
}

// Environment is what Codex runs in: the person's environment without Friday's own OpenAI key
// (Codex has its sign-in), unless ARCHYMEDES_CODEX_BILLING=api keeps it.
func Environment(environ []string) []string {
	keepKey := false
	for _, kv := range environ {
		if k, v, _ := strings.Cut(kv, "="); k == "ARCHYMEDES_CODEX_BILLING" && strings.EqualFold(strings.TrimSpace(v), "api") {
			keepKey = true
		}
	}
	var out []string
	for _, kv := range environ {
		if k, _, _ := strings.Cut(kv, "="); k == "OPENAI_API_KEY" && !keepKey {
			continue
		}
		out = append(out, kv)
	}
	return out
}

// Readiness is whether Codex can run a session, and if not what it needs ("codex" or "sign-in").
type Readiness struct {
	Ready      bool
	Executable string
	Auth       Auth
	Needs      string
	Missing    string
}

const authTTL = 30 * time.Second

var (
	authMu    sync.Mutex
	authCache struct {
		key  string // the executable and the environment it runs in
		at   time.Time
		auth Auth
	}
)

// Check finds Codex and asks whether it is signed in (cached half a minute; fresh skips the cache).
func Check(ctx context.Context, getenv func(string) string, environ []string, fresh bool) Readiness {
	executable := Find(getenv)
	if executable == "" {
		return Readiness{Needs: "codex", Missing: "Codex installed (" + InstallURL + ")"}
	}
	authMu.Lock()
	cached := authCache
	authMu.Unlock()
	auth := cached.auth
	key := executable + "\x00" + strings.Join(Environment(environ), "\x00")
	if fresh || cached.key != key || time.Since(cached.at) >= authTTL {
		auth = loginStatus(ctx, executable, environ)
		authMu.Lock()
		authCache.key, authCache.at, authCache.auth = key, time.Now(), auth
		authMu.Unlock()
	}
	if !auth.LoggedIn {
		return Readiness{Executable: executable, Auth: auth, Needs: "sign-in", Missing: "signing in to Codex (codex login)"}
	}
	return Readiness{Ready: true, Executable: executable, Auth: auth}
}

func loginStatus(ctx context.Context, executable string, environ []string) Auth {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "login", "status")
	cmd.Env = Environment(environ)
	out, err := cmd.CombinedOutput()
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if !asExit(err, &exit) {
			return Auth{}
		}
		code = exit.ExitCode()
	}
	return ParseLoginStatus(code, string(out))
}

func asExit(err error, target **exec.ExitError) bool {
	e, ok := err.(*exec.ExitError)
	if ok {
		*target = e
	}
	return ok
}

// Note is a line on how Codex is signed in, "" when it is not.
func Note(auth Auth) string {
	switch {
	case !auth.LoggedIn:
		return ""
	case auth.Method == "apiKey":
		return "Codex is signed in with an API key: turns are billed per token."
	}
	return "Signed in with ChatGPT: turns use your plan's Codex limits."
}

// Models are Codex's models as Friday offers them before a session has asked Codex: its default.
func Models() []string { return []string{"default"} }
