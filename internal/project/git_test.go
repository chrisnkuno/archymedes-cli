package project

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(rel, content string) {
		os.MkdirAll(filepath.Dir(filepath.Join(root, rel)), 0o755)
		os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644)
	}
	run("init", "-q")
	write("keep.go", "package a\n\nfunc A() {}\n")
	write("edit.go", "one\ntwo\nthree\n")
	write("gone.txt", "bye\n")
	write("old name.md", "same content, renamed\nline two\nline three\n")
	run("add", ".")
	run("commit", "-q", "-m", "init")

	write("edit.go", "one\n2\nthree\nfour\n")
	os.Remove(filepath.Join(root, "gone.txt"))
	run("mv", "old name.md", "new name.md")
	write("staged.go", "package a\n")
	run("add", "staged.go")
	write("fresh/notes.txt", "a\nb\nc\n")
	return root
}

func TestChangesListsEveryKindWithLineCounts(t *testing.T) {
	root := gitRepo(t)
	changes, err := Changes(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Change{}
	for _, c := range changes {
		got[c.Path] = c
	}
	want := map[string]struct {
		status         string
		added, removed int
	}{
		"edit.go":         {"modified", 2, 1},
		"gone.txt":        {"deleted", 0, 1},
		"new name.md":     {"renamed", 0, 0},
		"staged.go":       {"added", 1, 0},
		"fresh/notes.txt": {"untracked", 3, 0},
	}
	if len(changes) != len(want) {
		t.Fatalf("changes: %+v", changes)
	}
	for path, w := range want {
		c, ok := got[path]
		if !ok || c.Status != w.status || c.Added != w.added || c.Removed != w.removed {
			t.Errorf("%s: %+v, want %+v", path, c, w)
		}
	}
	if got["new name.md"].From != "old name.md" || !got["staged.go"].Staged || got["edit.go"].Staged {
		t.Fatalf("rename source or staged flags wrong: %+v", changes)
	}
	for i := 1; i < len(changes); i++ {
		if changes[i-1].Path > changes[i].Path {
			t.Fatal("not sorted by path")
		}
	}
}

func TestDiffShowsAFilesChangeIncludingNewFiles(t *testing.T) {
	root := gitRepo(t)
	changes, _ := Changes(context.Background(), root)
	for _, c := range changes {
		text, truncated, err := Diff(context.Background(), root, c)
		if err != nil || truncated {
			t.Fatalf("%s: %v %v", c.Path, err, truncated)
		}
		switch c.Path {
		case "edit.go":
			if !strings.Contains(text, "-two") || !strings.Contains(text, "+2") || !strings.Contains(text, "+four") {
				t.Fatalf("edit.go diff:\n%s", text)
			}
		case "fresh/notes.txt":
			if !strings.Contains(text, "+a\n+b\n+c") {
				t.Fatalf("untracked diff:\n%s", text)
			}
		case "new name.md":
			if !strings.Contains(text, "rename from old name.md") {
				t.Fatalf("rename diff:\n%s", text)
			}
		}
	}
}

func TestChangesOutsideARepositorySaysSo(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	if _, err := Changes(context.Background(), t.TempDir()); !errors.Is(err, ErrNotRepository) {
		t.Fatalf("got %v", err)
	}
}
