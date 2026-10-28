package agents

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// TestAnOffloadedResultIsWrittenWhereReadFileCanReadIt is the correctness hinge: a saved result is
// no use unless read_file can open it, which it only does for a path inside the project.
func TestAnOffloadedResultIsWrittenWhereReadFileCanReadIt(t *testing.T) {
	root := t.TempDir()
	h := newHarness(t, root, policy.Build, func(string, fantasy.Call) reply { return reply{text: "ok"} })
	s := h.create()

	rel := s.resultStore("t-root")("call-1", strings.Repeat("q", 5000))
	if rel == "" {
		t.Fatal("the store saved nothing")
	}
	if filepath.IsAbs(rel) || rel == ".." || strings.HasPrefix(rel, "../") {
		t.Fatalf("path %q is outside the project; read_file would refuse it", rel)
	}
	data, err := os.ReadFile(filepath.Join(root, rel))
	if err != nil {
		t.Fatalf("the saved result is unreadable: %v", err)
	}
	if len(data) != 5000 {
		t.Fatalf("saved %d bytes, want the full 5000", len(data))
	}
}

func TestStaleOffloadedResultsAreSweptButFreshOnesKept(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".archymedes", "results", "root")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	old, fresh := filepath.Join(dir, "old.txt"), filepath.Join(dir, "fresh.txt")
	for _, f := range []string{old, fresh} {
		if err := os.WriteFile(f, []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	stale := time.Now().Add(-resultTTL - time.Hour)
	if err := os.Chtimes(old, stale, stale); err != nil {
		t.Fatal(err)
	}
	cleanStaleResults(root)
	if _, err := os.Stat(old); !os.IsNotExist(err) {
		t.Fatalf("the stale result was not swept: %v", err)
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Fatalf("a fresh result was removed: %v", err)
	}
}
