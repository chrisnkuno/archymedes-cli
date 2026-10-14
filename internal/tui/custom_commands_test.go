package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeCommand(t *testing.T, dir, name, text string) {
	t.Helper()
	path := filepath.Join(dir, "commands", name)
	if strings.Contains(dir, "project") {
		path = filepath.Join(dir, ".archymedes", "commands", name)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCustomCommandsLoadWithProjectWinningAndBuiltinsProtected(t *testing.T) {
	root := t.TempDir()
	project, config := filepath.Join(root, "project"), filepath.Join(root, "config")
	writeCommand(t, config, "review.md", "---\ndescription: from the user\n---\nUser review $ARGUMENTS")
	writeCommand(t, project, "review.md", "---\ndescription: Review a change for data-loss risks\n---\nReview $ARGUMENTS for data-loss risks.")
	writeCommand(t, config, "notes.md", "# Notes\nWrite notes")
	writeCommand(t, project, "help.md", "pretend help")  // a built-in: refused
	writeCommand(t, project, "Bad Name.md", "nope")      // not a command name
	writeCommand(t, project, "empty.md", "---\n---\n  ") // nothing to send

	got := loadCustomCommands(project, config)
	names := []string{}
	for _, c := range got {
		names = append(names, c.name)
	}
	if strings.Join(names, ",") != "notes,review" {
		t.Fatalf("commands %v", names)
	}
	review := got[1]
	if review.description != "Review a change for data-loss risks" || !strings.HasPrefix(review.source, project) {
		t.Fatalf("project file should win: %+v", review)
	}
	if got[0].description != "Notes" {
		t.Fatalf("a missing description is the first line: %q", got[0].description)
	}
	if p := review.prompt("the auth module"); p != "Review the auth module for data-loss risks." {
		t.Fatalf("prompt %q", p)
	}
	if p := got[0].prompt("today"); p != "# Notes\nWrite notes\n\ntoday" {
		t.Fatalf("a body without $ARGUMENTS gets the text appended: %q", p)
	}
}

func TestACustomCommandCompletesAndRunsAsAPrompt(t *testing.T) {
	m, agent := unconfigured(t)
	m.overlay = nil
	m.phase = ready
	m.session.ID = "s1"
	m.custom = []command{customCommand{name: "ship", description: "Ship it", body: "Ship $ARGUMENTS now"}.asCommand()}
	m.input.custom = m.custom
	typeText(m, "/sh")
	if len(m.input.complete) != 1 || m.input.complete[0].name != "ship" {
		t.Fatalf("completions %+v", m.input.complete)
	}
	cmd, ok := m.runCommand("/ship the release")
	if !ok || cmd == nil {
		t.Fatal("a custom command should run")
	}
	run(m, cmd)
	if len(agent.prompts) == 0 || agent.prompts[len(agent.prompts)-1] != "Ship the release now" {
		t.Fatalf("prompts %q", agent.prompts)
	}
}

func TestRetryContinueExportAndWhere(t *testing.T) {
	m, agent := unconfigured(t)
	m.overlay = nil
	m.phase = ready
	m.session.ID = "s1"
	m.cmdRetry("")
	if len(m.toasts) == 0 || !strings.Contains(m.toasts[len(m.toasts)-1].text, "Nothing to retry") {
		t.Fatalf("toasts %+v", m.toasts)
	}
	run(m, m.send("build it"))
	a := &assistantItem{}
	a.append("Done.")
	m.tr.items = append(m.tr.items, a, &toolItem{name: "run_command", done: true, isError: true})
	m.phase = ready
	run(m, m.cmdRetry(""))
	run(m, m.cmdContinue(""))
	if got := strings.Join(agent.prompts, "|"); got != "build it|build it|Continue from where you stopped." {
		t.Fatalf("prompts %q", got)
	}
	m.opts.Cwd = t.TempDir()
	m.cmdExport("out.md")
	raw, err := os.ReadFile(filepath.Join(m.opts.Cwd, "out.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"## You", "build it", "## Archymedes", "Done.", "tool `run_command`: failed"} {
		if !strings.Contains(string(raw), want) {
			t.Errorf("export lacks %q:\n%s", want, raw)
		}
	}
	m.cmdWhere("")
	if !strings.Contains(m.toasts[len(m.toasts)-1].text, "session s1") {
		t.Fatalf("where: %+v", m.toasts)
	}
}
