package tools

import (
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Nested instruction files (AGENTS.md and its kin in a subdirectory) are honoured: the first time a
// file tool touches a file under that directory, its instructions come with the result, once a
// session. The root's file is in the system prompt already, so it never comes again here.

func TestANestedAgentsFileComesWithTheFirstReadUnderIt(t *testing.T) {
	_, tools := setup(t, map[string]string{
		"AGENTS.md":            "root rules",
		"pkg/AGENTS.md":        "use tabs in pkg",
		"pkg/parser/AGENTS.md": "parser: no regexes",
		"pkg/parser/lex.go":    "package parser\n",
		"pkg/parser/parse.go":  "package parser\n",
	})
	r := call(t, tools["read_file"], tool.Args{"path": "pkg/parser/lex.go"})
	if r.IsError {
		t.Fatal(r.Content)
	}
	outer, inner := strings.Index(r.Content, "use tabs in pkg"), strings.Index(r.Content, "parser: no regexes")
	if outer < 0 || inner < 0 {
		t.Fatalf("nested instructions missing:\n%s", r.Content)
	}
	if outer > inner {
		t.Fatal("the outer directory's instructions should come before the inner, more specific ones")
	}
	if strings.Contains(r.Content, "root rules") {
		t.Fatal("the root's instructions are in the system prompt; they must not repeat here")
	}
	if !strings.HasPrefix(r.Content, "1\tpackage parser") {
		t.Fatalf("the file's own lines must come first:\n%s", r.Content)
	}
	if got := r.Data["instructions"]; got == nil {
		t.Fatal("the result's data does not name the instruction files it carried")
	}

	again := call(t, tools["read_file"], tool.Args{"path": "pkg/parser/parse.go"})
	if strings.Contains(again.Content, "no regexes") || strings.Contains(again.Content, "use tabs") {
		t.Fatalf("instructions repeated within a session:\n%s", again.Content)
	}
}

func TestWritesAndEditsCarryNestedInstructionsToo(t *testing.T) {
	_, tools := setup(t, map[string]string{
		"web/CLAUDE.md": "web: run prettier",
		"web/app.ts":    "let a = 1\n",
		"api/AGENTS.md": "api: errors wrap",
	})
	w := call(t, tools["write_file"], tool.Args{"path": "api/new.go", "content": "package api\n"})
	if !strings.Contains(w.Content, "api: errors wrap") {
		t.Fatalf("write_file did not carry api/AGENTS.md:\n%s", w.Content)
	}
	call(t, tools["read_file"], tool.Args{"path": "web/app.ts"}) // shows web's once, and makes the edit allowed
	e := call(t, tools["edit_file"], tool.Args{"path": "web/app.ts", "oldText": "1", "newText": "2"})
	if e.IsError || strings.Contains(e.Content, "prettier") {
		t.Fatalf("edit after a read repeated or failed:\n%s", e.Content)
	}
}

func TestInstructionFilePrecedenceAndOddCases(t *testing.T) {
	_, tools := setup(t, map[string]string{
		"a/AGENTS.override.md": "override wins",
		"a/AGENTS.md":          "plain loses",
		"a/x.txt":              "x",
		"b/AGENTS.md":          "   \n\t\n", // empty: nothing to say
		"b/y.txt":              "y",
		"c/AGENTS.md":          "c rules",
		"top.txt":              "t",
		"日本/AGENTS.md":         "ユニコード ok",
		"日本/z.txt":             "z",
	})
	if r := call(t, tools["read_file"], tool.Args{"path": "a/x.txt"}); !strings.Contains(r.Content, "override wins") || strings.Contains(r.Content, "plain loses") {
		t.Fatalf("first file found in precedence order should win:\n%s", r.Content)
	}
	if r := call(t, tools["read_file"], tool.Args{"path": "b/y.txt"}); r.Content != "1\ty" {
		t.Fatalf("an empty instruction file added text: %q", r.Content)
	}
	if r := call(t, tools["read_file"], tool.Args{"path": "top.txt"}); r.Content != "1\tt" {
		t.Fatalf("a file at the root carried instructions: %q", r.Content)
	}
	// Reading the instruction file itself shows it; it must not come a second time as an attachment.
	if r := call(t, tools["read_file"], tool.Args{"path": "c/AGENTS.md"}); strings.Count(r.Content, "c rules") != 1 {
		t.Fatalf("instruction file doubled:\n%s", r.Content)
	}
	if r := call(t, tools["read_file"], tool.Args{"path": "日本/z.txt"}); !strings.Contains(r.Content, "ユニコード ok") {
		t.Fatalf("unicode directory:\n%s", r.Content)
	}
	if r := call(t, tools["read_file"], tool.Args{"path": "missing/nothing.txt"}); !r.IsError {
		t.Fatal("a missing file should still be an error")
	}
}

func TestALongNestedFileIsCut(t *testing.T) {
	_, tools := setup(t, map[string]string{
		"big/AGENTS.md": strings.Repeat("rule ", InstructionsMax),
		"big/f.txt":     "f",
	})
	r := call(t, tools["read_file"], tool.Args{"path": "big/f.txt"})
	if len(r.Content) > InstructionsMax+500 || !strings.Contains(r.Content, "[… cut]") {
		t.Fatalf("not cut: %d bytes", len(r.Content))
	}
}

func TestRootInstructionsKeepTheirPrecedence(t *testing.T) {
	w, _ := setup(t, map[string]string{"CLAUDE.md": "claude", "AGENTS.md": "agents"})
	name, text := ReadInstructions(w.Root)
	if name != "AGENTS.md" || text != "agents" {
		t.Fatalf("got %q %q", name, text)
	}
}
