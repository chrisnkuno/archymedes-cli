package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

func setup(t *testing.T, files map[string]string) (*Workspace, map[string]*tool.Tool) {
	t.Helper()
	root := t.TempDir()
	for name, content := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	w := NewWorkspace(root)
	byName := map[string]*tool.Tool{}
	for _, tl := range w.Builtins() {
		byName[tl.Name] = tl
	}
	return w, byName
}

func call(t *testing.T, tl *tool.Tool, args tool.Args) tool.Result {
	t.Helper()
	return tl.Run(context.Background(), tool.Context{}, args)
}

func TestReadIsNumberedAndWindowed(t *testing.T) {
	_, tools := setup(t, map[string]string{"a.txt": "one\ntwo\nthree\n"})
	whole := call(t, tools["read_file"], tool.Args{"path": "a.txt"})
	if whole.Content != "1\tone\n2\ttwo\n3\tthree" {
		t.Fatalf("whole = %q", whole.Content)
	}
	part := call(t, tools["read_file"], tool.Args{"path": "a.txt", "offset": 2.0, "limit": 1.0})
	if part.Content != "a.txt (lines 2-2 of 3)\n2\ttwo" {
		t.Fatalf("part = %q", part.Content)
	}
	for _, bad := range []string{"../outside", "/etc/passwd", "~/x"} {
		if r := call(t, tools["read_file"], tool.Args{"path": bad}); !r.IsError || !strings.Contains(r.Content, "outside the project") {
			t.Fatalf("read %s: %+v", bad, r)
		}
	}
}

func TestEditIsExactUniqueAllOrNothingAndRefusesAStaleFile(t *testing.T) {
	w, tools := setup(t, map[string]string{"f.go": "a := 1\nb := 1\n"})
	edit := tools["edit_file"]
	if r := call(t, edit, tool.Args{"path": "f.go", "oldText": " := 1", "newText": " := 2"}); !r.IsError || !strings.Contains(r.Content, "occurs 2 times") {
		t.Fatalf("ambiguous edit: %+v", r)
	}
	r := call(t, edit, tool.Args{"path": "f.go", "edits": []any{
		map[string]any{"oldText": "a := 1", "newText": "a := 2"},
		map[string]any{"oldText": "missing", "newText": "x"},
	}})
	data, _ := os.ReadFile(filepath.Join(w.Root, "f.go"))
	if !r.IsError || string(data) != "a := 1\nb := 1\n" {
		t.Fatalf("a failed batch changed the file: %+v %q", r, data)
	}
	if r := call(t, edit, tool.Args{"path": "f.go", "oldText": "1\tb := 1", "newText": "1\tb := 3"}); r.IsError {
		t.Fatalf("a pasted line number should be stripped: %+v", r)
	}
	call(t, tools["read_file"], tool.Args{"path": "f.go"})
	_ = os.WriteFile(filepath.Join(w.Root, "f.go"), []byte("someone else\n"), 0o644)
	if r := call(t, edit, tool.Args{"path": "f.go", "oldText": "someone", "newText": "x"}); !r.IsError || !strings.Contains(r.Content, "changed since you last read it") {
		t.Fatalf("stale edit: %+v", r)
	}
}

func TestWriteCreatesDirectoriesAndIsRemembered(t *testing.T) {
	w, tools := setup(t, nil)
	if r := call(t, tools["write_file"], tool.Args{"path": "deep/dir/x.sh", "content": "echo hi"}); r.IsError {
		t.Fatal(r.Content)
	}
	if !w.Written()["deep/dir/x.sh"] {
		t.Fatal("not recorded as written")
	}
}

func TestGlobAndList(t *testing.T) {
	_, tools := setup(t, map[string]string{"src/a.go": "", "src/sub/b.go": "", "README.md": "", "node_modules/x/y.go": ""})
	got := call(t, tools["glob_files"], tool.Args{"pattern": "**/*.go"}).Content
	if !strings.Contains(got, "src/a.go") || !strings.Contains(got, "src/sub/b.go") || strings.Contains(got, "node_modules") {
		t.Fatalf("glob = %q", got)
	}
	if got := call(t, tools["glob_files"], tool.Args{"pattern": "*.md"}).Content; got != "README.md" {
		t.Fatalf("glob *.md = %q", got)
	}
	list := call(t, tools["list_files"], tool.Args{"depth": 1.0}).Content
	if strings.Contains(list, "src/a.go") || !strings.Contains(list, "src/") {
		t.Fatalf("list depth 1 = %q", list)
	}
	for pattern, name := range map[string]string{"src/**/*.go": "src/sub/b.go", "**/b.go": "src/sub/b.go", "src/*.go": "src/a.go"} {
		if !MatchGlob(pattern, name) {
			t.Fatalf("%s should match %s", pattern, name)
		}
	}
	if MatchGlob("src/*.go", "src/sub/b.go") {
		t.Fatal("* crossed a directory")
	}
}

func TestGrepFallbackInGo(t *testing.T) {
	w, _ := setup(t, map[string]string{"a.go": "func Foo() {}\nfunc bar() {}\n", "b.txt": "Foo here\n"})
	lines, err := w.grepGo(context.Background(), w.Root, grepQuery{query: "Foo", output: "content", limit: 10})
	if err != nil || len(lines) != 2 || lines[0] != "a.go:1:func Foo() {}" {
		t.Fatalf("lines = %v %v", lines, err)
	}
	files, _ := w.grepGo(context.Background(), w.Root, grepQuery{query: "foo", ignoreCase: true, include: "*.go", output: "files", limit: 10})
	if len(files) != 1 || files[0] != "a.go" {
		t.Fatalf("files = %v", files)
	}
}

func TestRunCommandEffectEvidenceAndRefusals(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	w, tools := setup(t, nil)
	run := tools["run_command"]
	if run.CallEffect(tool.Args{"command": "git status"}) != tool.EffectNone || run.CallEffect(tool.Args{"command": "npm install"}) != tool.EffectWorkspace {
		t.Fatal("read-only commands change nothing; installs do")
	}
	if !run.ParallelSafe {
		t.Fatal("read-only commands should batch: the loop runs effect-free, parallel-safe calls together")
	}
	ok := call(t, run, tool.Args{"command": "echo hello"})
	if ok.IsError || ok.Content != "exit 0\nhello" || ok.Evidence != nil {
		t.Fatalf("echo = %+v", ok)
	}
	fail := call(t, run, tool.Args{"command": "exit 3"})
	if !fail.IsError || fail.Data["exitCode"] != 3 {
		t.Fatalf("exit 3 = %+v", fail)
	}
	if r := call(t, run, tool.Args{"command": "rm -rf /"}); !r.IsError || !strings.Contains(r.Content, "Refused") {
		t.Fatalf("rm -rf / = %+v", r)
	}
	_ = os.WriteFile(filepath.Join(w.Root, "probe.sh"), []byte("exit 0"), 0o755)
	w.markWritten("probe.sh")
	if r := call(t, run, tool.Args{"command": "sh probe.sh"}); r.Evidence == nil || r.Evidence.Kind != tool.EvidenceSmoke {
		t.Fatalf("running a written script is smoke evidence: %+v", r)
	}
	w.Rules = []policy.CommandRule{{Prefix: []policy.PrefixWord{policy.Word("curl")}, Decision: "forbid", Source: "test"}}
	if r := call(t, run, tool.Args{"command": "curl example.com"}); !r.IsError || r.Data["reason"] != "command_rule" {
		t.Fatalf("forbidden by rule = %+v", r)
	}
	if r := call(t, run, tool.Args{"command": "definitely-not-a-program-xyz"}); r.Data["missingProgram"] != "definitely-not-a-program-xyz" {
		t.Fatalf("missing program = %+v", r)
	}
}

func TestRunCommandTimesOut(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	_, tools := setup(t, nil)
	r := call(t, tools["run_command"], tool.Args{"command": "sleep 5", "timeoutSeconds": 1.0})
	if !strings.Contains(r.Content, "exceeded its 1s limit") {
		t.Fatalf("timeout = %+v", r)
	}
}

func TestTodos(t *testing.T) {
	_, tools := setup(t, nil)
	write := tools["todo_write"]
	call(t, write, tool.Args{"items": []any{"read", "fix"}})
	r := call(t, write, tool.Args{"complete": []any{1.0, 9.0}, "start": 2.0})
	if !strings.Contains(r.Content, "[x] 1. read") || !strings.Contains(r.Content, "[~] 2. fix") || !strings.Contains(r.Content, "No todo with id [9]") {
		t.Fatalf("todos = %q", r.Content)
	}
	if r := call(t, write, tool.Args{"complete": []any{1.0}}); !strings.Contains(r.Content, "Already recorded") {
		t.Fatalf("redundant = %q", r.Content)
	}
}

func TestGitReaders(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	w, tools := setup(t, map[string]string{"a.txt": "1\n"})
	for _, args := range [][]string{{"init", "-q"}, {"-c", "user.email=a@b", "-c", "user.name=a", "add", "."}, {"-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "first"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = w.Root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	_ = os.WriteFile(filepath.Join(w.Root, "a.txt"), []byte("2\n"), 0o644)
	if r := call(t, tools["git_diff"], tool.Args{}); !strings.Contains(r.Content, "+2") {
		t.Fatalf("diff = %q", r.Content)
	}
	if r := call(t, tools["git_log"], tool.Args{}); !strings.Contains(r.Content, "first") {
		t.Fatalf("log = %q", r.Content)
	}
	if r := call(t, tools["git_diff"], tool.Args{"ref": "--output=/tmp/x"}); !r.IsError {
		t.Fatal("an option was accepted as a ref")
	}
}
