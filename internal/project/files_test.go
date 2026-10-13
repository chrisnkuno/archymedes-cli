package project

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func write(t *testing.T, root, rel, content string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestFilesInARepositoryAreWhatGitConsidersTheProject(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	write(t, root, ".gitignore", "build/\n*.log\n")
	write(t, root, "src/app.go", "package app")
	write(t, root, "README.md", "# hi")
	write(t, root, "build/out.bin", "x")
	write(t, root, "debug.log", "x")
	for _, args := range [][]string{{"init", "-q"}, {"add", "src", "README.md", ".gitignore"}} {
		if out, err := exec.Command("git", append([]string{"-C", root}, args...)...).CombinedOutput(); err != nil {
			t.Fatal(string(out))
		}
	}
	write(t, root, "notes.txt", "untracked but not ignored")
	files, truncated, err := Files(context.Background(), root)
	if err != nil || truncated {
		t.Fatal(err, truncated)
	}
	if want := []string{".gitignore", "README.md", "notes.txt", "src/app.go"}; !reflect.DeepEqual(files, want) {
		t.Fatalf("got %v", files)
	}
}

func TestFilesOutsideARepositorySkipDependenciesAndDotDirectories(t *testing.T) {
	root := t.TempDir()
	write(t, root, "main.py", "")
	write(t, root, "node_modules/x/index.js", "")
	write(t, root, ".cache/y", "")
	write(t, root, "pkg/mod.py", "")
	files, _, err := Files(context.Background(), root)
	if err != nil || !reflect.DeepEqual(files, []string{"main.py", "pkg/mod.py"}) {
		t.Fatalf("%v %v", files, err)
	}
}

func TestPreviewRefusesBinaryLargeAndEscapingFiles(t *testing.T) {
	root := t.TempDir()
	write(t, root, "a.txt", "one\ntwo\nthree\n")
	write(t, root, "b.bin", "MZ\x00\x01")
	write(t, root, "big.txt", strings.Repeat("line\n", 100))
	if text, note := Preview(root, "a.txt", 1000); text != "one\ntwo\nthree\n" || note != "" {
		t.Fatalf("%q %q", text, note)
	}
	if _, note := Preview(root, "b.bin", 1000); !strings.Contains(note, "binary") {
		t.Fatal(note)
	}
	if text, note := Preview(root, "big.txt", 22); text != "line\nline\nline\nline" || note == "" {
		t.Fatalf("%q %q", text, note)
	}
	if _, note := Preview(root, "../../etc/passwd", 1000); note == "" {
		t.Fatal("escaped the project")
	}
	outside := t.TempDir()
	write(t, outside, "secret", "s")
	if err := os.Symlink(filepath.Join(outside, "secret"), filepath.Join(root, "link")); err == nil {
		if _, note := Preview(root, "link", 1000); note != "outside the project" {
			t.Fatalf("symlink out of the project: %q", note)
		}
	}
}

func TestLanguage(t *testing.T) {
	for file, want := range map[string]string{"a.ts": "typescript", "b.go": "go", "c.PY": "python", "Dockerfile": "dockerfile", "x.unknown": ""} {
		if got := Language(file); got != want {
			t.Errorf("%s: %q", file, got)
		}
	}
}
