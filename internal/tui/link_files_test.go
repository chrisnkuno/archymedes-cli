package tui

import (
	"bytes"
	"encoding/base64"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/phone"
)

// The project from the phone: folders, files of every kind read in chunks, search, what changed
// and its diffs, the log, and an overview. Through the same sealed link; secret files and keys
// never leave the computer.

func linkedProject(t *testing.T, files map[string]string) (*linked, string) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		_ = os.WriteFile(p, []byte(body), 0o644)
	}
	for _, args := range [][]string{{"init", "-q", "-b", "main"}, {"add", "."}, {"commit", "-q", "-m", "start"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=a", "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=a", "GIT_COMMITTER_EMAIL=a@a")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v %s", args, err, out)
		}
	}
	l := newLinked(t)
	l.m.opts.Cwd, l.m.session.Info.Root = root, root
	l.hello(t)
	return l, root
}

// fetch reads a whole file from the phone, chunk by chunk, as the page does.
func (l *linked) fetch(t *testing.T, path string) (data []byte, info map[string]any) {
	t.Helper()
	offset := 0.0
	for {
		ack := l.ask(t, map[string]any{"type": "file", "path": path, "offset": offset})
		if ack["ok"] != true {
			t.Fatalf("file %s at %v: %v", path, offset, ack["text"])
		}
		d := ack["data"].(map[string]any)
		chunk, err := base64.StdEncoding.DecodeString(d["data"].(string))
		if err != nil {
			t.Fatal(err)
		}
		if d["offset"].(float64) != offset {
			t.Fatalf("asked for %v, got %v", offset, d["offset"])
		}
		data = append(data, chunk...)
		offset += float64(len(chunk))
		info = d
		if d["more"] != true {
			return data, info
		}
	}
}

var projectFiles = map[string]string{
	"README.md":           "# The parser\n\nParses **things**.\n",
	"internal/p/parse.go": "package p\n\n// TODO: errors\nfunc Parse() {}\n",
	"docs/big.txt":        strings.Repeat("a line of the big text file, long enough to need chunks\n", 9000),
	"assets/logo.png":     "\x89PNG\r\n\x1a\n" + string(bytes.Repeat([]byte{0, 1, 2, 250, 255}, 50_000)),
	".env":                "OPENROUTER_API_KEY=sk-or-v1-FILE-SECRET\n",
	"config.yml":          "api_key: sk-or-v1-NEVER-ON-THE-PHONE\nport: 8080\n",
}

// FUNCTIONAL: the phone browses the project and opens files of every kind, which arrive whole.
func TestThePhoneBrowsesTheProjectAndOpensItsFiles(t *testing.T) {
	l, root := linkedProject(t, projectFiles)
	ack := l.ask(t, map[string]any{"type": "files", "path": ""})
	if ack["ok"] != true {
		t.Fatal(ack)
	}
	var names []string
	for _, e := range ack["data"].(map[string]any)["entries"].([]any) {
		names = append(names, e.(map[string]any)["name"].(string))
	}
	if strings.Join(names, " ") != "assets docs internal .env README.md config.yml" {
		t.Fatalf("top: %v", names)
	}
	readme, info := l.fetch(t, "README.md")
	if string(readme) != projectFiles["README.md"] || info["mime"] != "text/markdown" || info["text"] != true {
		t.Fatalf("README: %q %v", readme, info["mime"])
	}
	big, _ := l.fetch(t, "docs/big.txt")
	if string(big) != projectFiles["docs/big.txt"] {
		t.Fatalf("the big file came back %d bytes, not %d", len(big), len(projectFiles["docs/big.txt"]))
	}
	logo, info := l.fetch(t, "assets/logo.png")
	disk, _ := os.ReadFile(filepath.Join(root, "assets/logo.png"))
	if !bytes.Equal(logo, disk) || info["mime"] != "image/png" || info["text"] != false {
		t.Fatalf("the image came back changed (%d of %d bytes, %v)", len(logo), len(disk), info["mime"])
	}
}

// INVARIANT: no file request leaves the project or reads a secret file, and keys inside text files
// are hidden.
func TestTheProjectFromThePhoneKeepsItsSecrets(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "sk-or-v1-NEVER-ON-THE-PHONE")
	l, _ := linkedProject(t, projectFiles)
	for _, p := range []string{".env", "../../etc/passwd", "/etc/passwd", "internal/../../x", ""} {
		if ack := l.ask(t, map[string]any{"type": "file", "path": p, "offset": 0}); ack["ok"] != false {
			t.Fatalf("%q was read: %v", p, ack)
		}
	}
	if ack := l.ask(t, map[string]any{"type": "files", "path": "../.."}); ack["ok"] != false {
		t.Fatalf("listed outside the project: %v", ack)
	}
	cfg, _ := l.fetch(t, "config.yml")
	if strings.Contains(string(cfg), "NEVER-ON-THE-PHONE") || !strings.Contains(string(cfg), "port: 8080") {
		t.Fatalf("config.yml on the phone: %q", cfg)
	}
	if ack := l.ask(t, map[string]any{"type": "search", "query": "FILE-SECRET"}); len(ack["data"].(map[string]any)["hits"].([]any)) != 0 {
		t.Fatalf("search reached a secret file: %v", ack)
	}
}

// INVARIANT: every message a file read makes fits the link.
func TestFileChunksFitTheLink(t *testing.T) {
	l, _ := linkedProject(t, projectFiles)
	l.fetch(t, "docs/big.txt")
	l.fetch(t, "assets/logo.png")
	for _, m := range l.drain(t).all {
		if raw := normal(m); len(raw) > phone.MaxMessage {
			t.Fatalf("a message of %d bytes", len(raw))
		}
	}
}

// BEHAVIOUR: search, what changed with its diff, the log and the overview, from the phone.
func TestThePhoneSearchesAndSeesChangesTheLogAndAnOverview(t *testing.T) {
	l, root := linkedProject(t, projectFiles)
	hits := l.ask(t, map[string]any{"type": "search", "query": "todo"})["data"].(map[string]any)["hits"].([]any)
	if len(hits) != 1 || hits[0].(map[string]any)["path"] != "internal/p/parse.go" || hits[0].(map[string]any)["line"] != 3.0 {
		t.Fatalf("hits %v", hits)
	}
	_ = os.WriteFile(filepath.Join(root, "internal/p/parse.go"), []byte("package p\n\nfunc Parse() error { return nil }\n"), 0o644)
	changes := l.ask(t, map[string]any{"type": "changes"})["data"].(map[string]any)["changes"].([]any)
	if len(changes) != 1 || changes[0].(map[string]any)["path"] != "internal/p/parse.go" || changes[0].(map[string]any)["status"] != "modified" {
		t.Fatalf("changes %v", changes)
	}
	diff := l.ask(t, map[string]any{"type": "diff", "path": "internal/p/parse.go"})["data"].(map[string]any)["diff"].(string)
	if !strings.Contains(diff, "-// TODO: errors") || !strings.Contains(diff, "+func Parse() error { return nil }") {
		t.Fatalf("diff %q", diff)
	}
	overview := l.ask(t, map[string]any{"type": "overview"})["data"].(map[string]any)
	if overview["readme"] != "README.md" || overview["branch"] != "main" || overview["changed"] != 1.0 || len(overview["commits"].([]any)) != 1 {
		t.Fatalf("overview %v", overview)
	}
	_ = os.Remove(filepath.Join(root, "README.md"))
	gone := l.ask(t, map[string]any{"type": "diff", "path": "README.md"})
	if gone["ok"] != true || !strings.Contains(gone["data"].(map[string]any)["diff"].(string), "-# The parser") {
		t.Fatalf("a deleted file's diff: %v", gone)
	}
	if ack := l.ask(t, map[string]any{"type": "diff", "path": "../x"}); ack["ok"] != false {
		t.Fatalf("a diff outside the project: %v", ack)
	}
}
