package project

import (
	"bytes"
	"context"
	"math/rand/v2"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
)

// Browsing the project from afar (the phone): listing, reading in chunks, the kind of each file,
// search, the log and an overview. Nothing leaves the project, secret files never leave the
// computer, and a file read in chunks is the file, byte for byte.

func browseRepo(t *testing.T, files map[string]string) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	for name, body := range files {
		p := filepath.Join(root, filepath.FromSlash(name))
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=Ada", "GIT_AUTHOR_EMAIL=a@a", "GIT_COMMITTER_NAME=Ada", "GIT_COMMITTER_EMAIL=a@a")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	run("add", ".")
	run("commit", "-q", "-m", "first: the parser")
	return root
}

var sample = map[string]string{
	"README.md":           "# Parser\n\nIt parses.\n",
	"go.mod":              "module x\n",
	"cmd/main.go":         "package main\n\nfunc main() {}\n",
	"internal/p/parse.go": "package p\n\n// Parse parses the TODO list.\nfunc Parse() {}\n",
	"internal/p/lex.go":   "package p\n\nfunc Lex() {}\n",
	"docs/guide.md":       "# Guide\n",
	"web/app.ts":          "export const todo = 1;\n",
	".env":                "OPENROUTER_API_KEY=sk-secret\n",
	"deploy/server.pem":   "-----BEGIN PRIVATE KEY-----\n",
	".gitignore":          "build/\n",
	"build/out.bin":       "ignored",
	"assets/logo.png":     "\x89PNG\r\n\x1a\n\x00\x00binary",
	"docs/manual.pdf":     "%PDF-1.7\n\x00binary",
}

// INVARIANT: no path a phone can send reads or lists anything outside the project.
func TestNothingOutsideTheProjectIsListedOrRead(t *testing.T) {
	root := browseRepo(t, sample)
	outside := t.TempDir()
	_ = os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("outside"), 0o644)
	if runtime.GOOS != "windows" {
		_ = os.Symlink(outside, filepath.Join(root, "escape"))
		_ = os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(root, "link.txt"))
	}
	bad := []string{"..", "../", "../x", "/etc/passwd", "a/../../x", "escape", "escape/secret.txt", "link.txt",
		"internal/../../" + filepath.Base(outside), "\x00", "C:\\Windows", "~", "~/x", "./../x"}
	for _, p := range bad {
		if _, err := ReadChunk(root, p, 0, 1024); err == nil {
			t.Errorf("read %q", p)
		}
		if p == "" {
			continue
		}
		if entries, err := List(context.Background(), root, p); err == nil && len(entries) > 0 {
			t.Errorf("listed %q: %v", p, entries)
		}
	}
}

// INVARIANT: secret files are never read, whatever case or folder; they are listed as such.
func TestSecretFilesNeverLeaveTheComputer(t *testing.T) {
	for _, name := range []string{".env", ".env.local", "prod.ENV", "a/b/.env.production", "key.pem", "id_rsa", "id_ed25519.pub.key",
		"server.KEY", "cert.p12", "x.pfx", ".npmrc", ".netrc", ".pypirc", "credentials.json", "aws/credentials", "app.secret", ".git-credentials", "release.keystore"} {
		if !Secret(name) {
			t.Errorf("%s is not treated as secret", name)
		}
	}
	for _, name := range []string{"env.go", "keyboard.go", "README.md", "docs/environment.md", "secrets_test_plan.md", "pem.go", "monkey.ts"} {
		if Secret(name) {
			t.Errorf("%s is treated as secret", name)
		}
	}
	root := browseRepo(t, sample)
	for _, p := range []string{".env", "deploy/server.pem"} {
		if _, err := ReadChunk(root, p, 0, 1024); err == nil {
			t.Fatalf("read the secret %s", p)
		}
	}
	entries, _ := List(context.Background(), root, "")
	for _, e := range entries {
		if e.Name == ".env" && !e.Secret {
			t.Fatal(".env is listed without being marked secret")
		}
	}
}

// INVARIANT: a file read in chunks of any size is the file, byte for byte, for every length.
func TestAFileReadInChunksIsTheFile(t *testing.T) {
	root := t.TempDir()
	r := rand.New(rand.NewPCG(5, 6))
	for _, size := range []int{0, 1, 2, 999, 1000, 1001, 4096, 70_001, 300_000} {
		data := make([]byte, size)
		for i := range data {
			data[i] = byte(r.IntN(256))
		}
		name := "f" + strconv.Itoa(size) + ".bin"
		_ = os.WriteFile(filepath.Join(root, name), data, 0o644)
		for _, chunk := range []int{1, 7, 1000, 65_536} {
			if size > 5000 && chunk < 1000 {
				continue
			}
			var got []byte
			var offset int64
			for {
				c, err := ReadChunk(root, name, offset, chunk)
				if err != nil {
					t.Fatalf("%d bytes in %d: %v", size, chunk, err)
				}
				if c.Size != int64(size) || c.Offset != offset || len(c.Data) > chunk {
					t.Fatalf("%d bytes in %d: chunk %+v", size, chunk, c.Offset)
				}
				got = append(got, c.Data...)
				offset += int64(len(c.Data))
				if !c.More {
					break
				}
			}
			if !bytes.Equal(got, data) {
				t.Fatalf("%d bytes in chunks of %d: not the file", size, chunk)
			}
		}
	}
	if _, err := ReadChunk(root, "f1.bin", 5, 10); err == nil {
		t.Fatal("an offset past the end was read")
	}
}

// BEHAVIOUR: a file too large to send is refused, not cut.
func TestAFileTooLargeToViewIsRefused(t *testing.T) {
	root := t.TempDir()
	f, _ := os.Create(filepath.Join(root, "huge.bin"))
	_ = f.Truncate(MaxView + 1)
	f.Close()
	if _, err := ReadChunk(root, "huge.bin", 0, 1024); err == nil {
		t.Fatal("a file over MaxView was read")
	}
}

// BEHAVIOUR: a folder lists its folders first, then its files, each sorted, with sizes; git's
// ignores are kept; the root lists the top.
func TestAFolderListsWhatBelongsToTheProject(t *testing.T) {
	root := browseRepo(t, sample)
	top, err := List(context.Background(), root, "")
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, e := range top {
		names = append(names, e.Name)
	}
	got := strings.Join(names, " ")
	if !strings.HasPrefix(got, "assets cmd deploy docs internal web ") || strings.Contains(got, "build") {
		t.Fatalf("top: %s", got)
	}
	for _, want := range []string{"README.md", "go.mod", ".gitignore"} {
		if !strings.Contains(got, want) {
			t.Fatalf("top lacks %s: %s", want, got)
		}
	}
	inner, _ := List(context.Background(), root, "internal/p")
	if len(inner) != 2 || inner[0].Path != "internal/p/lex.go" || inner[0].Dir || inner[0].Size != int64(len(sample["internal/p/lex.go"])) {
		t.Fatalf("internal/p: %+v", inner)
	}
}

// BEHAVIOUR: each file's kind decides how the phone shows it.
func TestEachFileHasItsKind(t *testing.T) {
	root := browseRepo(t, sample)
	for path, want := range map[string]string{
		"README.md": "text/markdown", "internal/p/parse.go": "text/plain", "web/app.ts": "text/plain",
		"assets/logo.png": "image/png", "docs/manual.pdf": "application/pdf",
	} {
		c, err := ReadChunk(root, path, 0, 1<<16)
		if err != nil {
			t.Fatal(err)
		}
		if c.Mime != want {
			t.Errorf("%s: %s, want %s", path, c.Mime, want)
		}
		if c.Text != strings.HasPrefix(want, "text/") {
			t.Errorf("%s: text %v", path, c.Text)
		}
	}
}

// BEHAVIOUR: search finds text in the project's files, any case, with paths and lines; never in
// secret, ignored or binary files; and stops at its limit.
func TestSearchFindsTextWhereItIs(t *testing.T) {
	root := browseRepo(t, sample)
	hits, truncated := Search(context.Background(), root, "todo", 50)
	var where []string
	for _, h := range hits {
		where = append(where, h.Path+":"+strconv.Itoa(h.Line))
	}
	if strings.Join(where, " ") != "internal/p/parse.go:3 web/app.ts:1" || truncated {
		t.Fatalf("hits %v (truncated %v)", where, truncated)
	}
	if hits, _ := Search(context.Background(), root, "sk-secret", 50); len(hits) != 0 {
		t.Fatalf("search read a secret file: %v", hits)
	}
	if hits, _ := Search(context.Background(), root, "ignored", 50); len(hits) != 0 {
		t.Fatalf("search read an ignored file: %v", hits)
	}
	if hits, truncated := Search(context.Background(), root, "package", 2); len(hits) != 2 || !truncated {
		t.Fatalf("limit: %d hits, truncated %v", len(hits), truncated)
	}
	if hits, _ := Search(context.Background(), root, "  ", 50); len(hits) != 0 {
		t.Fatal("a blank search found something")
	}
}

// BEHAVIOUR: the overview says what the project is: its name, branch, files and languages, its
// README, its latest commits and how much has changed.
func TestTheOverviewSaysWhatTheProjectIs(t *testing.T) {
	root := browseRepo(t, sample)
	_ = os.WriteFile(filepath.Join(root, "internal/p/lex.go"), []byte("package p\n\nfunc Lex() { /* new */ }\n"), 0o644)
	o, err := Overview(context.Background(), root)
	if err != nil {
		t.Fatal(err)
	}
	if o.Branch != "main" || o.Readme != "README.md" || o.Files < 10 || o.Changed != 1 {
		t.Fatalf("overview %+v", o)
	}
	if len(o.Commits) != 1 || o.Commits[0].Subject != "first: the parser" || o.Commits[0].Author != "Ada" || len(o.Commits[0].SHA) < 7 {
		t.Fatalf("commits %+v", o.Commits)
	}
	if len(o.Languages) == 0 || o.Languages[0].Language != "go" || o.Languages[0].Files != 3 {
		t.Fatalf("languages %+v", o.Languages)
	}
}
