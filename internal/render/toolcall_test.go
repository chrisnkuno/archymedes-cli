package render

import (
	"strings"
	"testing"
	"unicode/utf8"
)

// Cases ported from packages/friday-cli/src/render/transcript.test.ts, so both front ends agree.

func TestTruncateMiddle(t *testing.T) {
	if got := TruncateMiddle("npm test", 40); got != "npm test" {
		t.Fatal(got)
	}
	got := TruncateMiddle("src/components/deeply/nested/folder/app.ts", 20)
	if utf8.RuneCountInString(got) != 20 || !strings.HasPrefix(got, "src/") || !strings.HasSuffix(got, ".ts") || !strings.Contains(got, "…") {
		t.Fatal(got)
	}
	if got := TruncateMiddle("npm run\n  build", 40); got != "npm run build" {
		t.Fatal(got)
	}
	if utf8.RuneCountInString(TruncateMiddle("abcdef", 1)) > 1 || TruncateMiddle("abcdef", 0) != "" {
		t.Fatal("overflowed at a tiny width")
	}
}

func TestDescribeToolCall(t *testing.T) {
	cases := []struct {
		tool string
		args map[string]any
		want string
	}{
		{"read_file", map[string]any{"path": "src/app.ts"}, "src/app.ts"},
		{"read_file", map[string]any{"path": "a.ts", "offset": 10.0, "limit": 20.0}, "a.ts:10-29"},
		{"read_file", map[string]any{"path": "a.ts", "offset": 10.0}, "a.ts:10+"},
		{"grep_files", map[string]any{"query": "TODO"}, `"TODO"`},
		{"grep_files", map[string]any{"query": "TODO", "include": "**/*.ts"}, `"TODO" in **/*.ts`},
		{"scan_secrets", map[string]any{"include": "src/**"}, "src/**"},
		{"scan_secrets", map[string]any{}, ""},
		{"run_command", map[string]any{"command": "npm test -- --watch=false"}, "npm test -- --watch=false"},
		{"write_file", map[string]any{"path": "big.ts", "content": strings.Repeat("x", 5000)}, "big.ts"},
		{"todo_write", map[string]any{"items": []any{"a", "b", "c"}}, "3 steps"},
		{"todo_write", map[string]any{"items": []any{"a"}}, "1 step"},
		{"todo_write", map[string]any{"start": []any{1.0}, "complete": []any{2.0, 3.0}}, "1 started, 2 done"},
		{"list_files", map[string]any{}, "."},
		{"todo_read", map[string]any{}, ""},
		{"some_future_tool", map[string]any{"count": 3.0, "target": "the thing"}, "the thing"},
		{"some_future_tool", map[string]any{"count": 3.0}, ""},
		{"start_application", map[string]any{"command": "bun run dev", "port": 4173.0}, "bun run dev :4173"},
		{"stop_application", map[string]any{"id": "app-1"}, "app-1"},
		{"application_status", map[string]any{}, ""},
	}
	for _, c := range cases {
		if got := DescribeToolCall(c.tool, c.args); got != c.want {
			t.Errorf("%s %v: got %q want %q", c.tool, c.args, got, c.want)
		}
	}
}

func TestSummarizeToolResult(t *testing.T) {
	todos := "[x] one\n[~] two\n[ ] three"
	cases := []struct {
		tool, body string
		isError    bool
		want       string
	}{
		{"run_command", "exit 0\n3 tests passed", false, "exit 0"},
		{"grep_files", "a.ts:1:x\nb.ts:2:y", false, "2 matches"},
		{"grep_files", "a.ts:1:x", false, "1 match"},
		{"glob_files", "a.ts\nb.ts\nc.ts", false, "3 files"},
		{"read_file", "one\ntwo\nthree\n", false, "3 lines"},
		{"list_files", "src/\nREADME.md", false, "2 entries"},
		{"grep_files", "No matches.", false, "no matches"},
		{"glob_files", "No files matched.", false, "no files"},
		{"scan_secrets", "No likely secrets found by pattern in the scanned files.", false, "clean"},
		{"scan_secrets", "1 possible secret found by pattern — verify each.\nsrc/config.ts:1: AWS", false, "1 possible secret"},
		{"scan_secrets", "2 possible secrets found by pattern — verify each.\n...", false, "2 possible secrets"},
		{"write_file", "Wrote tetris.py (6249 bytes).", false, "Wrote tetris.py (6249 bytes)."},
		{"edit_file", "Edited app.ts (2 replacements).", false, "Edited app.ts (2 replacements)."},
		{"todo_write", todos, false, "1/3 done"},
		{"some_future_tool", "\n\nit worked\nmore detail", false, "it worked"},
		{"start_application", "Started app-1. Preview verified at http://127.0.0.1:4173/.", false, "ready at http://127.0.0.1:4173/"},
		{"application_status", "No managed applications.", false, "none"},
		{"application_status", "app-1: running at http://127.0.0.1:4173/ (port 4173)\nRecent logs:\nready", false, "running at http://127.0.0.1:4173/"},
		{"application_status", "app-2: running in the background (node worker.js)", false, "running in the background"},
		{"ask_user", "The user answered: Postgres", false, "Postgres"},
		{"ask_user", "The user dismissed the question without answering. Do not ask it again.", false, "dismissed"},
		{"application_status", "app-1: running at http://127.0.0.1:1/ (port 1)\n\napp-2: exited at http://127.0.0.1:2/ (port 2)", false, "2 applications"},
	}
	for _, c := range cases {
		if got := SummarizeToolResult(c.tool, c.body, c.isError); got != c.want {
			t.Errorf("%s: got %q want %q", c.tool, got, c.want)
		}
	}
	failing := SummarizeToolResult("run_command", "exit 1\n\nTypeError: x is not a function\n  at y", false)
	if !strings.Contains(failing, "exit 1") || !strings.Contains(failing, "TypeError") {
		t.Fatal(failing)
	}
	failed := SummarizeToolResult("start_application", "\nProcess exited before port 4173 accepted connections.\nlogs", true)
	if !strings.Contains(failed, "exited before port 4173") || strings.Contains(failed, "\n") {
		t.Fatal(failed)
	}
	for _, tool := range []string{"run_command", "grep_files", "write_file", "todo_write", "unknown"} {
		if strings.Contains(SummarizeToolResult(tool, "a\nb\nc", false), "\n") {
			t.Fatalf("%s summary spans lines", tool)
		}
	}
}
