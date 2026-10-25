// Package claude runs a Go-engine session on the person's own Claude Code, the way the TypeScript
// engine does (packages/friday-cli/src/engines/claude), but without Anthropic's Agent SDK: the SDK
// is a Node wrapper around the `claude` program's stream-JSON protocol, and this package speaks
// that protocol itself (process.go). Claude Code does the work with its own prompt, tools and
// project instructions; Friday shows it, asks the person what Claude Code asks, and keeps the
// transcript so another model can carry on from it.
//
// Friday never sees a Claude credential. Signing in is Claude Code's own (`claude auth login`), and
// the only thing read back is whether the person is signed in.
package claude

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// Provider and Label are how Claude is named to the rest of Friday (llm.ClaudeCode).
const (
	Provider = "claude"
	Label    = "Claude (your subscription)"
)

// InstallURL is where to get Claude Code.
const InstallURL = "https://code.claude.com/docs/en/setup"

// Aliases are Claude Code's model aliases, offered until a session has asked it for its own list.
var Aliases = []string{"default", "opus", "sonnet", "haiku"}

var (
	learnedMu sync.Mutex
	learned   []string
)

// Models are the models Claude Code offers: what a session learned from it, else the aliases.
func Models() []string {
	learnedMu.Lock()
	defer learnedMu.Unlock()
	if len(learned) == 0 {
		return append([]string(nil), Aliases...)
	}
	out := []string{"default"}
	for _, m := range learned {
		if m != "default" {
			out = append(out, m)
		}
	}
	return out
}

func learn(models []string) {
	learnedMu.Lock()
	defer learnedMu.Unlock()
	learned = models
}

// PermissionMode is a Friday mode as Claude Code's permission mode. Defender asks like build does.
func PermissionMode(mode policy.Mode) string {
	switch mode {
	case policy.Plan:
		return "plan"
	case policy.Auto:
		return "acceptEdits"
	}
	return "default"
}

// Find is Claude Code's path: ARCHYMEDES_CLAUDE_PATH, else the PATH, else where its installers put
// it (~/.local/bin, ~/.claude/local). "" when it is not installed.
func Find(getenv func(string) string) string {
	exists := func(file string) bool {
		info, err := os.Stat(file)
		return err == nil && !info.IsDir()
	}
	if override := strings.TrimSpace(getenv("ARCHYMEDES_CLAUDE_PATH")); override != "" {
		if exists(override) {
			return override
		}
		return ""
	}
	names := []string{"claude"}
	if runtime.GOOS == "windows" {
		names = []string{"claude.exe", "claude.cmd", "claude"}
	}
	dirs := filepath.SplitList(getenv("PATH"))
	if home, err := os.UserHomeDir(); err == nil {
		dirs = append(dirs, filepath.Join(home, ".local", "bin"), filepath.Join(home, ".claude", "local"))
	}
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

// Environment is what Claude Code runs in: this process's environment ("KEY=value"), minus
// ANTHROPIC_API_KEY. With that variable set, Claude Code bills the key instead of the plan the
// person signed in with, and says so nowhere a person would look; ARCHYMEDES_CLAUDE_BILLING=api
// keeps it. Keys Friday holds in its settings file for other providers are never added: Claude
// Code's shell commands would see them.
func Environment(environ []string) []string {
	keepKey := false
	for _, kv := range environ {
		if k, v, _ := strings.Cut(kv, "="); k == "ARCHYMEDES_CLAUDE_BILLING" && strings.EqualFold(strings.TrimSpace(v), "api") {
			keepKey = true
		}
	}
	var out []string
	for _, kv := range environ {
		k, _, _ := strings.Cut(kv, "=")
		switch {
		case k == "ANTHROPIC_API_KEY" && !keepKey:
		case k == "NODE_OPTIONS", k == "CLAUDE_CODE_ENTRYPOINT", k == "CLAUDE_AGENT_SDK_CLIENT_APP", k == "CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING":
		default:
			out = append(out, kv)
		}
	}
	return append(out,
		"CLAUDE_CODE_ENTRYPOINT=sdk-go",
		"CLAUDE_AGENT_SDK_CLIENT_APP=archymedes",
		// Each turn's edits can be put back (/undo), as the SDK's enableFileCheckpointing does.
		"CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING=true",
	)
}

// Auth is whether the person is signed in to Claude Code, and how.
type Auth struct {
	LoggedIn bool `json:"loggedIn"`
	// AuthMethod is "claude.ai" for a plan; another method bills an API key.
	AuthMethod string `json:"authMethod"`
	// SubscriptionType is "pro", "max", "team" or "enterprise"; empty for API billing.
	SubscriptionType string `json:"subscriptionType"`
}

// SignedIn asks `claude auth status --json`, in the environment Claude Code will run in, so the
// answer is about the billing it will use. Only the three fields above are read; the account's
// email and organisation, which it also prints, are not.
func SignedIn(ctx context.Context, executable string, environ []string) (Auth, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "auth", "status", "--json")
	cmd.Env = environ
	out, err := cmd.Output()
	start, end := strings.Index(string(out), "{"), strings.LastIndex(string(out), "}")
	var auth Auth
	if start < 0 || end < start || json.Unmarshal(out[start:end+1], &auth) != nil {
		if err == nil {
			err = errors.New("claude auth status gave no answer Friday could read")
		}
		return Auth{}, err
	}
	return auth, nil
}
