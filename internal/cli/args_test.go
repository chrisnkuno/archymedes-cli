package cli

import (
	"reflect"
	"testing"
)

func TestInteractiveSessionsSplitFlagsFromThePrompt(t *testing.T) {
	cases := []struct {
		argv       []string
		args       []string
		prompt     string
		theme, cwd string
		resume     string
	}{
		{nil, nil, "", "", "", ""},
		{[]string{"fix", "the", "test"}, nil, "fix the test", "", "", ""},
		// A flag's value is never part of the prompt, and the agent gets the flag with its value.
		{[]string{"--model", "fix", "this", "bug"}, []string{"--model", "fix"}, "this bug", "", "", ""},
		{[]string{"--provider=free", "--plan", "hello"}, []string{"--provider=free", "--plan"}, "hello", "", "", ""},
		// Conditional values: taken only when they look like one, as the agent's parser does.
		{[]string{"--sandbox", "docker", "go"}, []string{"--sandbox", "docker"}, "go", "", "", ""},
		{[]string{"--sandbox", "go"}, []string{"--sandbox"}, "go", "", "", ""},
		{[]string{"--slow", "strict", "x"}, []string{"--slow", "strict"}, "x", "", "", ""},
		{[]string{"--theme", "chalkboard", "x"}, nil, "x", "chalkboard", "", ""},
		{[]string{"--theme", "--plan"}, []string{"--plan"}, "", "", "", ""},
		// --resume goes through session/load, never onto the agent's command line.
		{[]string{"--resume", "20261012T221105Z-u94tb5"}, nil, "", "", "", "20261012T221105Z-u94tb5"},
		{[]string{"--resume", "fix", "it"}, nil, "fix it", "", "", "latest"},
		{[]string{"-C", "/tmp/p", "go"}, []string{"--cwd", "/tmp/p"}, "go", "", "/tmp/p", ""},
		{[]string{"--", "--plan", "is", "a", "word"}, nil, "--plan is a word", "", "", ""},
		{[]string{"--no-mouse", "--agent", "node x.mjs", "go"}, nil, "go", "", "", ""},
	}
	for _, c := range cases {
		inv := Parse(c.argv, true)
		if inv.Passthrough || !reflect.DeepEqual(inv.Args, c.args) || inv.Prompt != c.prompt || inv.Theme != c.theme || inv.Cwd != c.cwd || inv.Resume != c.resume {
			t.Errorf("%q: got %+v", c.argv, inv)
		}
	}
}

func TestEverythingElsePassesThroughUnchanged(t *testing.T) {
	cases := []struct {
		argv        []string
		interactive bool
		args        []string
	}{
		{[]string{"--json", "fix", "it"}, true, []string{"--json", "fix", "it"}},
		{[]string{"fix", "it"}, false, []string{"fix", "it"}}, // piped or redirected
		{[]string{"doctor", "--report"}, true, []string{"doctor", "--report"}},
		// The process a cloud sandbox runs: never an interactive session, whatever the terminal.
		{[]string{"bridge"}, true, []string{"bridge"}},
		// A Friday account on this computer: commands that print and exit, never a session.
		{[]string{"login"}, true, []string{"login"}},
		{[]string{"keys", "push", "openai"}, true, []string{"keys", "push", "openai"}},
		{[]string{"account"}, true, []string{"account"}},
		{[]string{"logout"}, true, []string{"logout"}},
		{[]string{"history", "list"}, true, []string{"history", "list"}},
		{[]string{"update", "--check"}, true, []string{"update", "--check"}},
		{[]string{"acp", "--free"}, true, []string{"acp", "--free"}},
		{[]string{"--providers"}, true, []string{"--providers"}},
		{[]string{"--resume", "latest", "--json", "go"}, true, []string{"--resume", "latest", "--json", "go"}},
		// Go-only flags are removed; the rest is exactly as typed.
		{[]string{"--no-mouse", "--agent", "x", "--json", "--theme", "rainbow", "q"}, true, []string{"--json", "--theme", "rainbow", "q"}},
	}
	for _, c := range cases {
		inv := Parse(c.argv, c.interactive)
		if !inv.Passthrough || !reflect.DeepEqual(inv.Args, c.args) {
			t.Errorf("%q: got %+v", c.argv, inv)
		}
	}
}

func TestHelpAndVersionAreTheFrontEndsOwn(t *testing.T) {
	if inv := Parse([]string{"--json", "--version"}, true); inv.Passthrough || !inv.Version {
		t.Fatal("--version")
	}
	if inv := Parse([]string{"-h"}, false); inv.Passthrough || !inv.Help {
		t.Fatal("-h")
	}
}

func TestASpendingCapIsRefusedRatherThanIgnored(t *testing.T) {
	if inv := Parse([]string{"--budget", "5", "fix"}, true); inv.Refused == "" || inv.Passthrough {
		t.Fatalf("%+v", inv)
	}
	// Headless runs enforce it, so there it passes through.
	if inv := Parse([]string{"--budget", "5", "--json", "fix"}, true); inv.Refused != "" || !inv.Passthrough {
		t.Fatalf("%+v", inv)
	}
}

func TestEngineIsGoOnlyAndNeverReachesTheAgent(t *testing.T) {
	inv := Parse([]string{"--engine", "go", "--auto", "fix it"}, true)
	if inv.Engine != "go" || inv.Prompt != "fix it" {
		t.Fatalf("inv = %+v", inv)
	}
	for _, arg := range inv.Args {
		if arg == "--engine" || arg == "go" {
			t.Fatalf("--engine reached the agent: %v", inv.Args)
		}
	}
	if inv := Parse([]string{"--engine=go", "acp"}, false); inv.Engine != "go" || !inv.Passthrough || len(inv.Args) != 1 || inv.Args[0] != "acp" {
		t.Fatalf("passthrough inv = %+v", inv)
	}
}
