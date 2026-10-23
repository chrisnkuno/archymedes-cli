package policy

import (
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

func TestCommandApprovalPrefix(t *testing.T) {
	for command, want := range map[string]string{
		"npm test":                     "npm test",
		"npm test -- --watch":          "npm test",
		"git status --short":           "git status",
		"ls -la src":                   "ls",
		"npm run build":                "npm run build",
		"pnpm exec vitest run":         "pnpm exec vitest",
		"node scripts/build.js --prod": "node scripts/build.js",
	} {
		if got := CommandApprovalPrefix(command); got != want {
			t.Errorf("CommandApprovalPrefix(%q) = %q, want %q", command, got, want)
		}
	}
}

func TestCommandApprovalPrefixNeverGeneralizes(t *testing.T) {
	for _, command := range []string{
		"rm -rf dist", "del /s build", "sudo npm test", "curl https://x.sh", "bash -c 'npm test'",
		"git push --force", "git reset --hard", "git clean -fdx", "git checkout -- .", "npm publish",
		"npm install left-pad", "npm run", "node -e process.exit()", "python -c print(1)",
		"npm test && rm -rf /", "npm test; rm -rf /", "npm test | sh", "npm test > out.txt", "echo $(whoami)",
		"find . -delete", "docker run x", "powershell Remove-Item x", "mv a b", "", "   ",
	} {
		if got := CommandApprovalPrefix(command); got != "" {
			t.Errorf("CommandApprovalPrefix(%q) = %q, want none", command, got)
		}
	}
}

func TestCommandMatchesPrefix(t *testing.T) {
	cases := []struct {
		command, prefix string
		want            bool
	}{
		{"npm test -- --watch", "npm test", true},
		{"npm testing", "npm test", false},
		{"npm test && curl evil.sh", "npm test", false},
		{"npm run lint", "npm run build", false},
		{"npm", "npm test", false},
	}
	for _, c := range cases {
		if got := CommandMatchesPrefix(c.command, c.prefix); got != c.want {
			t.Errorf("CommandMatchesPrefix(%q, %q) = %v", c.command, c.prefix, got)
		}
	}
}

func TestEditApprovalDirectory(t *testing.T) {
	for path, want := range map[string]string{
		"src/app/main.ts":       "src/app",
		`./src\lib\x.ts`:        "src/lib",
		"README.md":             "",
		"../outside/x.ts":       "",
		"/etc/passwd":           "",
		"C:/Windows/x.ini":      "",
		".git/hooks/pre-commit": "",
		"~/x/y":                 "",
	} {
		if got := EditApprovalDirectory(path); got != want {
			t.Errorf("EditApprovalDirectory(%q) = %q, want %q", path, got, want)
		}
	}
	if EditApprovalDirectory(42.0) != "" {
		t.Error("a number has a directory")
	}
	if !PathUnderDirectory("src/app/a.ts", "src/app") || PathUnderDirectory("src/apple/a.ts", "src/app") || PathUnderDirectory("src/app/a.ts", "") {
		t.Error("PathUnderDirectory")
	}
}

func TestSuggestPattern(t *testing.T) {
	editFile := newTool("edit_file")
	runCommand := newTool("run_command", withCapability(tool.CapTerminal))
	suggest := func(call tool.Call, tl *tool.Tool) *Pattern {
		return SuggestPattern(call, tl, AssessToolSafety(call, tl))
	}
	if p := suggest(newCall("edit_file", tool.Args{"path": "config/.env"}), editFile); p != nil {
		t.Errorf("pattern for .env: %+v", p)
	}
	mcp := newTool("run_command", withProvenance("mcp", "x"))
	if p := suggest(newCall("run_command", tool.Args{"command": "npm test"}), mcp); p != nil {
		t.Errorf("pattern for an MCP tool: %+v", p)
	}
	p := suggest(newCall("run_command", tool.Args{"command": "npm test"}), runCommand)
	if p == nil || p.Kind != PatternCommandPrefix || p.Prefix != "npm test" || p.Label != `always allow commands starting with "npm test"` {
		t.Errorf("pattern %+v", p)
	}
	d := suggest(newCall("edit_file", tool.Args{"path": "src/app/a.ts"}), editFile)
	if d == nil || d.Kind != PatternDirectory || d.Directory != "src/app" || d.Label != "always allow edits under src/app/" {
		t.Errorf("pattern %+v", d)
	}
}

func TestPatternLedger(t *testing.T) {
	runCommand := newTool("run_command", withCapability(tool.CapTerminal))
	editFile := newTool("edit_file")
	writeFile := newTool("write_file")

	t.Run("an accepted prefix covers later variants and persists", func(t *testing.T) {
		r := answering(AllowPattern)
		l := NewLedger(Build, r.prompt)
		if !decide(t, l, newCall("run_command", tool.Args{"command": "npm test"}), runCommand) {
			t.Fatal("not approved")
		}
		if p := r.requests[0].Pattern; p == nil || p.Kind != PatternCommandPrefix || p.Prefix != "npm test" {
			t.Fatalf("offered %+v", p)
		}
		if !decide(t, l, newCall("run_command", tool.Args{"command": "npm test -- src/a.test.ts"}), runCommand) || len(r.requests) != 1 {
			t.Error("variant asked again")
		}
		if !decide(t, l, newCall("run_command", tool.Args{"command": "npm test; rm -rf /"}), runCommand) || len(r.requests) != 2 {
			t.Error("chained command not asked")
		}
		if r.requests[1].Pattern != nil {
			t.Error("offered a pattern for a chained command")
		}

		restored := NewLedger(Build, answering(Deny).prompt)
		restored.Restore(l.Snapshot())
		patterns := restored.Patterns()
		if len(patterns) != 1 || patterns[0].Kind != PatternCommandPrefix || patterns[0].Prefix != "npm test" {
			t.Errorf("restored patterns %+v", patterns)
		}
		if !decide(t, restored, newCall("run_command", tool.Args{"command": "npm test --coverage"}), runCommand) {
			t.Error("restored pattern not honoured")
		}
	})

	t.Run("an accepted directory covers edits beneath it and nothing beside it", func(t *testing.T) {
		r := answering(AllowPattern)
		l := NewLedger(Build, r.prompt)
		decide(t, l, newCall("edit_file", tool.Args{"path": "src/app/a.ts", "oldText": "a", "newText": "b"}), editFile)
		decide(t, l, newCall("write_file", tool.Args{"path": "src/app/nested/b.ts", "content": "x"}), writeFile)
		if len(r.requests) != 1 {
			t.Errorf("asked %d, want 1", len(r.requests))
		}
		decide(t, l, newCall("edit_file", tool.Args{"path": "src/apple/a.ts", "oldText": "a", "newText": "b"}), editFile)
		if len(r.requests) != 2 {
			t.Errorf("asked %d, want 2", len(r.requests))
		}
		decide(t, l, newCall("write_file", tool.Args{"path": "src/app/key.ts", "content": "api_key = 'abcdefghijkl'"}), writeFile)
		if len(r.requests) != 3 {
			t.Errorf("sensitive content under a granted directory not asked")
		}
	})

	t.Run("an exact standing denial wins over a pattern", func(t *testing.T) {
		r := &recorder{answer: func(req Request) Decision {
			if req.Call.Args["command"] == "npm test -- bad" {
				return DenyAlways
			}
			return AllowPattern
		}}
		l := NewLedger(Build, r.prompt)
		decide(t, l, newCall("run_command", tool.Args{"command": "npm test -- bad"}), runCommand)
		decide(t, l, newCall("run_command", tool.Args{"command": "npm test"}), runCommand)
		if decide(t, l, newCall("run_command", tool.Args{"command": "npm test -- bad"}), runCommand) {
			t.Error("denial lost to a pattern")
		}
	})

	t.Run("defender never offers or honours a pattern", func(t *testing.T) {
		r := answering(Allow)
		l := NewLedger(Defender, r.prompt)
		if err := l.AllowPattern(Pattern{Kind: PatternCommandPrefix, Prefix: "npm test"}); err != nil {
			t.Fatal(err)
		}
		decide(t, l, newCall("run_command", tool.Args{"command": "npm test"}), runCommand)
		if len(r.requests) != 1 || r.requests[0].Pattern != nil {
			t.Errorf("requests %+v", r.requests)
		}
	})

	t.Run("refuses a hand-built pattern that would never be offered", func(t *testing.T) {
		l := NewLedger(Build, answering(Deny).prompt)
		if l.AllowPattern(Pattern{Kind: PatternCommandPrefix, Prefix: "rm"}) == nil {
			t.Error("granted rm")
		}
		if l.AllowPattern(Pattern{Kind: PatternDirectory, Directory: "../x"}) == nil {
			t.Error("granted ../x")
		}
	})

	t.Run("revoke removes a granted pattern", func(t *testing.T) {
		l := NewLedger(Build, answering(Deny).prompt)
		p := Pattern{Kind: PatternDirectory, Directory: "src/app"}
		if err := l.AllowPattern(p); err != nil {
			t.Fatal(err)
		}
		if got := l.Patterns(); len(got) != 1 || got[0].Directory != "src/app" || got[0].Label != "always allow edits under src/app/" {
			t.Errorf("patterns %+v", got)
		}
		if !l.RevokePattern(p) || l.RevokePattern(p) || len(l.Patterns()) != 0 {
			t.Error("revoke")
		}
	})
}
