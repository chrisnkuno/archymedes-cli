package hooks

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

func write(t *testing.T, path, text string, mode os.FileMode) {
	t.Helper()
	os.MkdirAll(filepath.Dir(path), 0o755)
	if err := os.WriteFile(path, []byte(text), mode); err != nil {
		t.Fatal(err)
	}
}

func shellOnly(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("these hooks are sh commands")
	}
}

func TestClaudeFormatHooksBlockAnswerBackAndAddContext(t *testing.T) {
	shellOnly(t)
	root, home := t.TempDir(), t.TempDir()
	log := filepath.Join(t.TempDir(), "payload.json")
	settings := map[string]any{"hooks": map[string]any{
		"PreToolUse": []any{
			map[string]any{"matcher": "Bash", "hooks": []any{map[string]any{"type": "command", "command": "cat > " + log + "; echo 'no rm here' >&2; exit 2"}}},
			map[string]any{"matcher": "Write|Edit", "hooks": []any{map[string]any{"type": "command", "command": `echo '{"decision":"block","reason":"generated files are read-only"}'`}}},
			map[string]any{"matcher": "Read", "hooks": []any{map[string]any{"type": "command", "command": `echo '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"secrets"}}'`}}},
		},
		"PostToolUse": []any{
			map[string]any{"matcher": "Grep", "hooks": []any{map[string]any{"type": "command", "command": "echo 'also check docs/' >&2; exit 2"}}},
			map[string]any{"matcher": "Glob", "hooks": []any{map[string]any{"type": "command", "command": "echo ignored >&2; exit 1"}}},
		},
		"Stop":             []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": `grep -q '"stop_hook_active":true' || { echo 'run the linter first' >&2; exit 2; }`}}}},
		"UserPromptSubmit": []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": `grep -q 'deploy' && { echo 'not from here' >&2; exit 2; }; echo 'branch: main'`}}}},
		"SessionStart":     []any{map[string]any{"hooks": []any{map[string]any{"type": "command", "command": "echo 'sprint 12'"}}}},
		"Notification":     []any{},
	}}
	data, _ := json.Marshal(settings)
	write(t, filepath.Join(root, ".claude", "settings.json"), string(data), 0o644)
	s := Load(root, "", home, "s1")
	ctx := context.Background()

	if why := s.BeforeTool(ctx, tool.Call{Name: "run_command", Args: tool.Args{"command": "rm -rf build"}}, nil); why != "no rm here" {
		t.Fatalf("Bash matcher on run_command: %q", why)
	}
	var payload map[string]any
	raw, _ := os.ReadFile(log)
	json.Unmarshal(raw, &payload)
	if payload["tool_name"] != "Bash" || payload["hook_event_name"] != "PreToolUse" || payload["cwd"] != root || payload["tool_input"].(map[string]any)["command"] != "rm -rf build" {
		t.Fatalf("payload %s", raw)
	}
	if why := s.BeforeTool(ctx, tool.Call{Name: "write_file", Args: tool.Args{"path": "gen.go"}}, nil); why != "generated files are read-only" {
		t.Fatalf("JSON block: %q", why)
	}
	if why := s.BeforeTool(ctx, tool.Call{Name: "read_file", Args: tool.Args{"path": ".env"}}, nil); why != "secrets" {
		t.Fatalf("deny: %q", why)
	}
	if why := s.BeforeTool(ctx, tool.Call{Name: "git_status"}, nil); why != "" {
		t.Fatalf("an unmatched tool was stopped: %q", why)
	}
	if said := s.AfterTool(ctx, tool.Call{Name: "grep_files"}, nil, tool.Result{Content: "x"}); said != "also check docs/" {
		t.Fatalf("post: %q", said)
	}
	if said := s.AfterTool(ctx, tool.Call{Name: "glob_files"}, nil, tool.Result{}); said != "" {
		t.Fatalf("exit 1 answered back: %q", said)
	}
	if why := s.BeforeStop(ctx, false); why != "run the linter first" {
		t.Fatalf("stop: %q", why)
	}
	if why := s.BeforeStop(ctx, true); why != "" {
		t.Fatalf("stop again: %q", why)
	}
	if refusal, extra := s.PromptSubmitted(ctx, "fix the parser"); refusal != "" || extra != "branch: main" {
		t.Fatalf("prompt: %q %q", refusal, extra)
	}
	if refusal, _ := s.PromptSubmitted(ctx, "deploy it"); refusal != "not from here" {
		t.Fatalf("refusal: %q", refusal)
	}
	if got := s.SessionStarted(ctx, "startup"); got != "sprint 12" {
		t.Fatalf("session start: %q", got)
	}
}

func TestFridaysScriptFoldersStillWork(t *testing.T) {
	shellOnly(t)
	root := t.TempDir()
	log := filepath.Join(t.TempDir(), "seen")
	write(t, filepath.Join(root, ".archymedes/hooks/pre-tool-use/guard.sh"), "#!/bin/sh\necho \"$ARCHYMEDES_HOOK_EVENT_B64\" | base64 -d > "+log+"\necho 'blocked by guard' >&2\nexit 1\n", 0o755)
	write(t, filepath.Join(root, ".archymedes/hooks/post-turn/lazy.sh"), "#!/bin/sh\nexit 0\n", 0o644)
	s := Load(root, "", "", "s1")
	if why := s.BeforeTool(context.Background(), tool.Call{Name: "write_file", Args: tool.Args{"path": "a"}}, nil); why != "blocked by guard" {
		t.Fatalf("script: %q", why)
	}
	raw, _ := os.ReadFile(log)
	if !strings.Contains(string(raw), `"event":"pre_tool_use"`) || !strings.Contains(string(raw), `"toolName":"write_file"`) {
		t.Fatalf("script payload %s", raw)
	}
	if len(s.Problems) != 1 || !strings.Contains(s.Problems[0], "not executable") {
		t.Fatalf("problems %v", s.Problems)
	}
}

func TestABrokenFileOrPatternIsReportedNotFatal(t *testing.T) {
	root := t.TempDir()
	write(t, filepath.Join(root, ".archymedes", "hooks.json"), `{"hooks":{"PreToolUse":[{"matcher":"(","hooks":[{"type":"command","command":"true"}]}]}}`, 0o644)
	write(t, filepath.Join(root, ".claude", "settings.json"), `{not json`, 0o644)
	s := Load(root, "", "", "s1")
	if len(s.Hooks()) != 0 || len(s.Problems) != 2 {
		t.Fatalf("hooks %v problems %v", s.Hooks(), s.Problems)
	}
}
