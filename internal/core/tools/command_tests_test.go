package tools

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// A test run on a tree that has not changed since it passed is answered with that pass; an edit,
// a failure or fresh: true runs it again. The runner here is a fake pytest that counts its runs
// in a file outside the project, so the count itself never changes the tree.
func TestRunCommandReusesAPassOnAnUnchangedTree(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake runner is a shell script")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	counter := filepath.Join(t.TempDir(), "runs")
	w, tools := setup(t, map[string]string{
		"app.py":            "x = 1\n",
		"tests/test_app.py": "def test_x(): pass\n",
		".gitignore":        "bin/\n", // .archymedes/ not ignored: Friday's own writes must not count as changes
		"bin/pytest":        "#!/bin/sh\necho run >> " + counter + "\n[ -f fail ] && { echo '1 failed'; exit 1; }\necho '1 passed in 0.01s'\n",
	})
	if err := os.Chmod(filepath.Join(w.Root, "bin", "pytest"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, args := range [][]string{{"init", "-q"}, {"add", "."}, {"-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "start"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = w.Root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	runs := func() int {
		data, _ := os.ReadFile(counter)
		return strings.Count(string(data), "run")
	}
	command := `PATH="$PWD/bin:$PATH" pytest tests`
	rc := tools["run_command"]

	preview := rc.Preview(tool.Args{"command": command})
	if testRun, _ := preview["testRun"].(map[string]any); testRun["runner"] != "pytest" || testRun["basis"] != "guess" {
		t.Fatalf("preview before any run: %v", preview)
	}
	if rc.Preview(tool.Args{"command": "ls"}) != nil || rc.Preview(tool.Args{"command": command, "background": true}) != nil {
		t.Error("a preview for a command that runs no tests")
	}

	first := call(t, rc, tool.Args{"command": command})
	if first.IsError || first.Evidence == nil || runs() != 1 {
		t.Fatalf("first run: %+v (runs %d)", first, runs())
	}
	if testRun, _ := first.Data["testRun"].(map[string]any); testRun == nil || testRun["took"] == nil {
		t.Errorf("no timing on the result: %v", first.Data)
	}
	if testRun, _ := rc.Preview(tool.Args{"command": command})["testRun"].(map[string]any); testRun["basis"] != "history" {
		t.Errorf("after one run the preview is not from history: %v", testRun)
	}

	second := call(t, rc, tool.Args{"command": `PATH="$PWD/bin:$PATH"   pytest tests`})
	if runs() != 1 || second.Data["reused"] != true || second.Evidence == nil || !second.Evidence.Passed {
		t.Fatalf("same tree, run again: %+v (runs %d)", second, runs())
	}
	if !strings.Contains(second.Content, "Not run again") || !strings.Contains(second.Content, "1 passed") {
		t.Errorf("reused result: %q", second.Content)
	}

	call(t, rc, tool.Args{"command": command, "fresh": true})
	if runs() != 2 {
		t.Errorf("fresh: true did not run it (runs %d)", runs())
	}

	if err := os.WriteFile(filepath.Join(w.Root, "app.py"), []byte("x = 2\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	call(t, rc, tool.Args{"command": command})
	if runs() != 3 {
		t.Errorf("an edit did not run it again (runs %d)", runs())
	}

	// A failure on the same tree forgets the pass: the next run is real.
	if err := os.WriteFile(filepath.Join(w.Root, "fail"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if r := call(t, rc, tool.Args{"command": command}); !r.IsError || runs() != 4 {
		t.Fatalf("failing run: %+v (runs %d)", r, runs())
	}
	if r := call(t, rc, tool.Args{"command": command}); r.Data["reused"] == true || runs() != 5 {
		t.Errorf("a failure was answered with an old pass (runs %d)", runs())
	}
}
