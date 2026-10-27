package conform

import (
	"strings"
	"testing"
)

func has(t *testing.T, problems []string, want string) {
	t.Helper()
	for _, p := range problems {
		if strings.Contains(p, want) {
			return
		}
	}
	t.Fatalf("problems %q lack %q", problems, want)
}

func clean(t *testing.T, problems []string) {
	t.Helper()
	if len(problems) > 0 {
		t.Fatalf("unexpected problems: %q", problems)
	}
}

func TestNames(t *testing.T) {
	for kind, good := range map[string][]string{
		"command": {"help", "goal-check", "subagents"},
		"action":  {"next-window", "files"},
		"tool":    {"read_file", "tool_search", "git_diff"},
		"role":    {"explore", "db-migrations"},
		"flag":    {"--no-mouse", "-p", "--engine"},
		"method":  {"session/prompt", "_archymedes/providers/remember-model", "initialize"},
		"setting": {"ARCHYMEDES_ENGINE", "GROQ_API_KEY"},
		"event":   {"tool_result", "runtime_stop"},
	} {
		for _, n := range good {
			clean(t, Name(kind, n))
		}
	}
	for kind, bad := range map[string][]string{
		"command": {"Help", "goal_check", "a-very-long-command-name-x"},
		"tool":    {"readFile", "read-file"},
		"flag":    {"-pp", "--No-mouse"},
		"method":  {"session/Prompt", "foo/bar"},
		"setting": {"archymedes_engine"},
	} {
		for _, n := range bad {
			if len(Name(kind, n)) == 0 {
				t.Fatalf("%s %q passed", kind, n)
			}
		}
	}
	has(t, Name("nope", "x"), "no grammar")
}

func TestHelpLines(t *testing.T) {
	clean(t, Help("Pick a model, or switch straight to one; the conversation carries on"))
	clean(t, Help("/resume, with an id"))
	has(t, Help("pick a model"), "lower case")
	has(t, Help("The same: earlier sessions"), "stand alone")
	has(t, Help("Leave Friday."), "full stop")
	has(t, Help("Leave Friday!"), "calm")
	has(t, Help(" Leave"), "leading or trailing")
	has(t, Help("Leave  Friday"), "doubled space")
	has(t, Help(strings.Repeat("a", 101)), "at most 100")
	has(t, Help("Shows WARNINGS"), "shouts")
	clean(t, Help("Read the JSON and the README"))
	clean(t, Help("中文")) // a script without letter case starts as it is written
	clean(t, Help("العربية"))
	has(t, Help(""), "empty")
}

func TestMessages(t *testing.T) {
	clean(t, Message("Nowhere to push: this repository has no remote (git remote add origin <url>)"))
	clean(t, Message("/goal between turns; esc stops this one"))
	has(t, Message("Error: something"), "say what happened")
	has(t, Message("failed: x"), "lower case")
	has(t, Message(strings.Repeat("x", 121)), "at most 120")
}

func TestLabels(t *testing.T) {
	clean(t, Label("next window"))
	has(t, Label("Next window"), "not lower case")
	has(t, Label("a label that is far too long for the dock"), "at most 24")
}

func TestToolDescriptions(t *testing.T) {
	clean(t, ToolDescription("Read a file. Lines come numbered."))
	has(t, ToolDescription("read a file."), "lower case")
	has(t, ToolDescription("Read a file"), "does not end a sentence")
	has(t, ToolDescription(strings.Repeat("A", 401)+"."), "at most 400")
}

func TestArgHints(t *testing.T) {
	for _, good := range []string{"", "[name]", "<path>[:line]", "[code|conversation]", "[base <ref>|commit <ref>|branch <ref>|focus]", "[add <text> | forget <n> | clear]", "[turn [code|conversation]]", "[condition|stop]", "[plan|build|auto|defender]"} {
		clean(t, ArgHint(good))
	}
	has(t, ArgHint("[name"), "open")
	has(t, ArgHint("name]"), "did not open")
	has(t, ArgHint("[Name]"), "lower-case")
	has(t, ArgHint("[a [b [c]]]"), "deeper than two")
}

func TestUnique(t *testing.T) {
	clean(t, Unique("command", []string{"a", "b"}))
	has(t, Unique("command", []string{"a", "a"}), "defined twice")
}
