package server

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/claude/claudetest"
)

// claudeServer is a server whose `claude` is the fake, with a TypeScript agent that answers
// providers as it does when Anthropic's Agent SDK is missing, and records what reached it.
func claudeServer(t *testing.T, environ ...string) (*Server, *[]string) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv(claudetest.Env, "1")
	var forwarded []string
	forward := func(_ context.Context, method string, _ json.RawMessage) (json.RawMessage, error) {
		forwarded = append(forwarded, method)
		switch method {
		case "_archymedes/providers":
			return json.RawMessage(`{"providers":[{"id":"groq","configured":true,"missing":[]},` +
				`{"id":"claude","configured":false,"missing":["Anthropic's Agent SDK (installed when you connect)"],"note":"Signed in with Claude Max: turns use your plan's limits."}]}`), nil
		case "_archymedes/providers/connect":
			return json.RawMessage(`{"ok":true,"file":"/x","models":["llama"]}`), nil
		}
		return nil, nil
	}
	env := append(os.Environ(), append([]string{"ARCHYMEDES_CLAUDE_PATH=" + exe}, environ...)...)
	return New(nil, Options{ConfigDir: t.TempDir(), Environ: env, Forward: forward}), &forwarded
}

// TestProvidersShowsClaudeReadyWithoutTheAgentSDK: the Go engine drives Claude Code itself, so the
// Providers app must not say Claude needs the SDK.
func TestProvidersShowsClaudeReadyWithoutTheAgentSDK(t *testing.T) {
	s, _ := claudeServer(t)
	got, err := s.providers(context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	text := string(got.(json.RawMessage))
	if !strings.Contains(text, `"configured":true,"id":"claude"`) && !strings.Contains(text, `"id":"claude","missing":[]`) {
		var o struct{ Providers []map[string]any }
		_ = json.Unmarshal([]byte(text), &o)
		t.Fatalf("claude row: %v", o.Providers[1])
	}
	if !strings.Contains(text, "Claude Max") {
		t.Errorf("the plan note was lost: %s", text)
	}
}

// TestConnectingClaudeChecksTheSignInAndInstallsNothing: Claude is answered here, never forwarded
// (the TypeScript agent would install the Agent SDK); other providers are forwarded.
func TestConnectingClaudeChecksTheSignInAndInstallsNothing(t *testing.T) {
	s, forwarded := claudeServer(t)
	got, _ := s.connectProvider(context.Background(), json.RawMessage(`{"provider":"claude"}`))
	if r := got.(map[string]any); r["ok"] != true || len(r["models"].([]string)) == 0 {
		t.Fatalf("signed in: %v", r)
	}
	if _, err := s.connectProvider(context.Background(), json.RawMessage(`{"provider":"groq","values":{}}`)); err != nil {
		t.Fatal(err)
	}
	if strings.Join(*forwarded, ",") != "_archymedes/providers/connect" {
		t.Fatalf("forwarded %v; only groq's connect should be", *forwarded)
	}

	out, _ := claudeServer(t, "FAKE_CLAUDE_SIGNED_OUT=1")
	got, _ = out.connectProvider(context.Background(), json.RawMessage(`{"provider":"claude"}`))
	if r := got.(map[string]any); r["ok"] != false || !strings.Contains(r["error"].(string), "claude auth login") {
		t.Fatalf("signed out: %v", r)
	}
}
