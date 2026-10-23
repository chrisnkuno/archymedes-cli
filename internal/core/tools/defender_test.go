package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

func TestPlaybooksAreEmbeddedInOrderWithIDsFromTheirTitles(t *testing.T) {
	books := Playbooks()
	if len(books) != 19 {
		t.Fatalf("%d playbooks embedded, want 19", len(books))
	}
	if books[0].ID != "access-control" || books[0].Title != "Access control" {
		t.Fatalf("first playbook = %+v", books[0].ID)
	}
	index := PlaybookIndex()
	for _, p := range books {
		if !strings.HasPrefix(p.Text, "## ") || !strings.Contains(index, "- "+p.ID+" — "+p.Title) {
			t.Errorf("playbook %s is not headed or not in the index", p.ID)
		}
	}
}

func TestReadPlaybook(t *testing.T) {
	read := NewWorkspace(t.TempDir()).readPlaybook()
	got := read.Run(context.Background(), tool.Context{}, tool.Args{"id": "Injection"})
	if got.IsError || !strings.HasPrefix(got.Content, "## Injection") {
		t.Fatalf("by title: %+v", got.Content[:min(40, len(got.Content))])
	}
	if got := read.Run(context.Background(), tool.Context{}, tool.Args{"id": "injection"}); got.IsError {
		t.Fatal("by id failed")
	}
	missing := read.Run(context.Background(), tool.Context{}, tool.Args{"id": "nope"})
	if !missing.IsError || !strings.Contains(missing.Content, "access-control") {
		t.Fatalf("an unknown id should list the ids: %q", missing.Content)
	}
	if read.Capability != tool.CapPlaybooks {
		t.Fatal("read_playbook must be defender's alone")
	}
}

func TestScanSecretsFindsMasksAndRanksWorstFirst(t *testing.T) {
	root := t.TempDir()
	write := func(name, text string) {
		if err := os.WriteFile(filepath.Join(root, name), []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlc2lnbmF0dXJl"
	write("token.js", "const session = \""+jwt+"\";\n")
	write("aws.py", "\nkey = 'AKIAABCDEFGHIJKLMNOP'\n")
	write("clean.go", "package clean\n")
	findings, err := NewWorkspace(root).ScanSecrets(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	if len(findings) != 2 {
		t.Fatalf("findings = %+v", findings)
	}
	if f := findings[0]; f.Path != "aws.py" || f.Line != 2 || f.Severity != "critical" || f.Kind != "AWS access key" {
		t.Errorf("worst first: %+v", f)
	}
	for _, f := range findings {
		if strings.Contains(f.Masked, "ABCDEFGHIJKL") || strings.Contains(f.Masked, jwt) {
			t.Errorf("a value was shown in full: %q", f.Masked)
		}
	}
	scan := NewWorkspace(root).scanSecrets()
	if got := scan.Run(context.Background(), tool.Context{}, tool.Args{"include": "*.go"}); !strings.HasPrefix(got.Content, "No likely secrets") {
		t.Errorf("include should narrow the scan: %q", got.Content)
	}
}

func TestMaskSecret(t *testing.T) {
	if got := maskSecret("short"); got != "[redacted]" {
		t.Errorf("short = %q", got)
	}
	if got := maskSecret("AKIAABCDEFGHIJKLMNOP"); got != "AKIA…MNOP (20 chars)" {
		t.Errorf("long = %q", got)
	}
}
