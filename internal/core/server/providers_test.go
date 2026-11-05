package server

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/claude/claudetest"
)

// claudeServer is a server whose `claude` is the fake (signed in with Claude Max unless
// FAKE_CLAUDE_SIGNED_OUT=1), with no Codex and no TypeScript agent: nothing may be forwarded.
func claudeServer(t *testing.T, environ ...string) *Server {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(claudetest.Env, "1")
	home := t.TempDir()
	t.Setenv("HOME", home)
	env := append([]string{claudetest.Env + "=1", "HOME=" + home, "PATH=" + home, "ARCHYMEDES_CLAUDE_PATH=" + exe, "ARCHYMEDES_CODEX_PATH=/nonexistent/codex"}, environ...)
	s := New(nil, Options{ConfigDir: t.TempDir(), Environ: env, Net: (&portNet{}).get, Forward: func(_ context.Context, method string, _ json.RawMessage) (json.RawMessage, error) {
		t.Errorf("%s was forwarded", method)
		return nil, errors.New("forwarded")
	}})
	s.initialized.Store(true)
	return s
}

// TestProvidersShowsClaudeReadyWithoutTheAgentSDK: the Go engine drives Claude Code itself, so
// Claude is ready when Claude Code is installed and signed in, and its row says with which plan.
// It comes right after free; Codex, not installed, after it.
func TestProvidersShowsClaudeReadyWithoutTheAgentSDK(t *testing.T) {
	s := claudeServer(t)
	rows, _ := call(t, s, "_archymedes/providers", json.RawMessage(`{}`))["providers"].([]any)
	if len(rows) < 3 {
		t.Fatalf("rows %v", rows)
	}
	free, claudeRow, codexRow := rows[0].(map[string]any), rows[1].(map[string]any), rows[2].(map[string]any)
	if free["id"] != "free" || claudeRow["id"] != "claude" || codexRow["id"] != "codex" {
		t.Fatalf("order: %v, %v, %v", free["id"], claudeRow["id"], codexRow["id"])
	}
	if claudeRow["configured"] != true || len(claudeRow["missing"].([]any)) != 0 || claudeRow["note"] != "Signed in with Claude Max: turns use your plan's limits." {
		t.Fatalf("claude row: %v", claudeRow)
	}
	if codexRow["configured"] != false || codexRow["keyUrl"] != "https://developers.openai.com/codex/cli" || !strings.Contains(codexRow["about"].(string), "ChatGPT plan") {
		t.Fatalf("codex row: %v", codexRow)
	}
}

// TestConnectingClaudeChecksTheSignInAndInstallsNothing: connecting Claude asks Claude Code whether
// it is signed in, and says how to sign in when it is not.
func TestConnectingClaudeChecksTheSignInAndInstallsNothing(t *testing.T) {
	got := call(t, claudeServer(t), "_archymedes/providers/connect", json.RawMessage(`{"provider":"claude"}`))
	if got["ok"] != true || len(got["models"].([]any)) == 0 || !strings.Contains(got["note"].(string), "Claude Max") {
		t.Fatalf("signed in: %v", got)
	}
	got = call(t, claudeServer(t, "FAKE_CLAUDE_SIGNED_OUT=1"), "_archymedes/providers/connect", json.RawMessage(`{"provider":"claude"}`))
	if got["ok"] != false || !strings.Contains(got["error"].(string), "claude auth login") {
		t.Fatalf("signed out: %v", got)
	}
	got = call(t, claudeServer(t), "_archymedes/providers/connect", json.RawMessage(`{"provider":"codex"}`))
	if got["ok"] != false || !strings.Contains(got["error"].(string), "Install Codex first") {
		t.Fatalf("codex: %v", got)
	}
}

// TestARememberedClaudeIsReadyWhenClaudeCodeIs: a start on a remembered Claude opens a session when
// Claude Code is installed and signed in, and the first-run screen with the reason otherwise.
func TestARememberedClaudeIsReadyWhenClaudeCodeIs(t *testing.T) {
	status := func(s *Server) map[string]any {
		t.Helper()
		return call(t, s, "_archymedes/setup/status", json.RawMessage(`{}`))
	}
	if got := status(claudeServer(t, "ARCHYMEDES_PROVIDER=claude", "CLAUDE_MODEL=sonnet")); got["configured"] != true || got["reason"] != nil {
		t.Fatalf("Claude Code is installed and signed in, yet: %v", got)
	}
	if got := status(claudeServer(t, "ARCHYMEDES_PROVIDER=claude", "ARCHYMEDES_CLAUDE_PATH=/nonexistent/claude")); got["configured"] != false ||
		got["reason"] != "Claude needs Claude Code installed (https://code.claude.com/docs/en/setup)." {
		t.Fatalf("no Claude Code: %v", got)
	}
	if got := status(claudeServer(t, "ARCHYMEDES_PROVIDER=claude", "FAKE_CLAUDE_SIGNED_OUT=1")); got["configured"] != false || !strings.Contains(got["reason"].(string), "claude auth login") {
		t.Fatalf("signed out: %v", got)
	}
	if got := status(claudeServer(t, "ARCHYMEDES_PROVIDER=codex")); got["configured"] != false || !strings.HasPrefix(got["reason"].(string), "Codex needs Codex installed") {
		t.Fatalf("codex: %v", got)
	}
	if got := status(claudeServer(t, "GROQ_API_KEY=k")); got["configured"] != true {
		t.Fatalf("groq: %v", got)
	}
	if got := status(claudeServer(t)); got["configured"] != false || !strings.Contains(got["reason"].(string), "no model provider") {
		t.Fatalf("nothing set up: %v", got)
	}
}

// TestClaudeAndCodexInTheModelList: Claude's models are usable once Claude Code is, between the
// usable models and the locked ones; Codex's, not installed, come last, locked, with what is missing.
