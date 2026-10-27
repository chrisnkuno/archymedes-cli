package checkpoint

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func repo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"config", "user.email", "t@t"}, {"config", "user.name", "t"}} {
		if out, err := exec.Command("git", append([]string{"-C", root}, args...)...).CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	return root
}

func put(t *testing.T, root, name, text string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(filepath.Join(root, name)), 0o755)
	if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func read(root, name string) string {
	data, err := os.ReadFile(filepath.Join(root, name))
	if err != nil {
		return "<gone>"
	}
	return string(data)
}

func run(t *testing.T, root string, args ...string) string {
	t.Helper()
	out, err := exec.Command("git", append([]string{"-C", root}, args...)...).CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v %s", args, err, out)
	}
	return string(out)
}

func TestUndoPutsBackChangedDeletedAndCreatedFilesAndLeavesStagingAlone(t *testing.T) {
	root := repo(t)
	put(t, root, "a.go", "package a // v1\n")
	put(t, root, "gone.txt", "keep me\n")
	run(t, root, "add", "a.go")
	run(t, root, "commit", "-qm", "init")
	put(t, root, "staged.txt", "the person staged this\n")
	run(t, root, "add", "staged.txt")
	stagedBefore := run(t, root, "diff", "--cached", "--name-only")

	ctx := context.Background()
	s := Open(root, filepath.Join(root, ".archymedes", "go-sessions", "s1"), "s1")
	if s == nil {
		t.Fatal("no store in a git repository")
	}
	if _, ok := s.Capture(ctx, "fix a", 4); !ok {
		t.Fatal("capture failed")
	}
	put(t, root, "a.go", "package a // v2\n")
	os.Remove(filepath.Join(root, "gone.txt"))
	put(t, root, "new/b.go", "package b\n")
	put(t, root, ".archymedes/go-sessions/s1/notes", "Friday's own state\n")

	if stat := s.Diff(ctx, true); !strings.Contains(stat, "a.go") || !strings.Contains(stat, "new/b.go") || !strings.Contains(stat, "gone.txt") || strings.Contains(stat, ".archymedes") {
		t.Fatalf("diff stat:\n%s", stat)
	}
	if patch := s.Diff(ctx, false); !strings.Contains(patch, "+package a // v2") {
		t.Fatalf("patch:\n%s", patch)
	}

	c, err := s.Back(ctx, len(s.List())-1, Both)
	if err != nil || c.Label != "fix a" || c.MessageCount != 4 {
		t.Fatalf("back = %+v, %v", c, err)
	}
	if read(root, "a.go") != "package a // v1\n" || read(root, "gone.txt") != "keep me\n" || read(root, "new/b.go") != "<gone>" {
		t.Fatalf("after undo: a=%q gone=%q b=%q", read(root, "a.go"), read(root, "gone.txt"), read(root, "new/b.go"))
	}
	if read(root, ".archymedes/go-sessions/s1/notes") != "Friday's own state\n" {
		t.Fatal("undo deleted Friday's own state")
	}
	if got := run(t, root, "diff", "--cached", "--name-only"); got != stagedBefore {
		t.Fatalf("the person's staging changed: %q, was %q", got, stagedBefore)
	}
	if len(s.List()) != 0 {
		t.Fatalf("the checkpoint gone back to is still listed: %+v", s.List())
	}
	if _, err := s.Back(ctx, 0, Both); err == nil {
		t.Fatal("going back with no checkpoints worked")
	}
}

func TestEachTurnsPatchAndTheConversationOnlyScope(t *testing.T) {
	root := repo(t)
	ctx := context.Background()
	dir := filepath.Join(root, ".archymedes", "s")
	s := Open(root, dir, "s")
	put(t, root, "x.txt", "one\n")
	s.Capture(ctx, "turn 1", 0)
	put(t, root, "x.txt", "two\n")
	s.Capture(ctx, "turn 2", 2)
	put(t, root, "x.txt", "three\n")

	if p := s.TurnPatch(ctx, 0); !strings.Contains(p, "-one") || !strings.Contains(p, "+two") {
		t.Fatalf("turn 0:\n%s", p)
	}
	if p := s.TurnPatch(ctx, 1); !strings.Contains(p, "+three") {
		t.Fatalf("turn 1:\n%s", p)
	}
	if _, err := s.Back(ctx, 1, Conversation); err != nil || read(root, "x.txt") != "three\n" {
		t.Fatalf("conversation only touched the files: %q, %v", read(root, "x.txt"), err)
	}
	s.ForgetConversation()
	reopened := Open(root, dir, "s")
	if list := reopened.List(); len(list) != 1 || list[0].Label != "turn 1" || list[0].MessageCount != -1 {
		t.Fatalf("reopened list = %+v", list)
	}
	if _, err := reopened.Back(ctx, 0, Code); err != nil || read(root, "x.txt") != "one\n" {
		t.Fatalf("code only: %q, %v", read(root, "x.txt"), err)
	}
}

func TestNoUndoOutsideAGitRepository(t *testing.T) {
	if Open(t.TempDir(), t.TempDir(), "s") != nil {
		t.Fatal("a store outside git")
	}
}
