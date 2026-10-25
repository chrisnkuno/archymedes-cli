package agents

import (
	"strings"
	"testing"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// waitFor waits for the first notice of kind, sent in the background after the turn.
func (h *harness) waitFor(kind string) []Notice {
	h.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if got := h.of(kind); len(got) > 0 {
			return got
		}
		time.Sleep(10 * time.Millisecond)
	}
	h.t.Fatalf("no %s notice", kind)
	return nil
}

func TestATurnThatEditsCodeEndsWithNotesAndNextSteps(t *testing.T) {
	var proposed bool
	h := newHarness(t, t.TempDir(), policy.Auto, func(model string, call fantasy.Call) reply {
		if model == "little" && strings.Contains(textOf(call.Prompt[0]), "You suggest what a developer") {
			proposed = true
			return reply{text: `[{"ask":"Handle a missing token in Refresh","why":"it returns nil for every token"}]`}
		}
		role, text := lastOf(call)
		if role == fantasy.MessageRoleUser && text == "add a refresh" {
			return reply{calls: [][2]string{{"write_file", `{"path":"auth.go","content":"package auth\n\n// TODO: expiry\nfunc Refresh(token string) error { return nil }\n"}`}}}
		}
		return reply{text: "Added Refresh."}
	})
	h.cfg.Env["ARCHYMEDES_SUGGEST_MODEL"] = "on"
	s := h.create()
	h.prompt(s, "add a refresh")

	notes := h.waitFor("edit_notes")
	if n := notes[0]; n.Path != "auth.go" || n.ToolCallID == "" || len(n.Notes) != 2 ||
		n.Notes[0].Text != "Leaves a TODO behind" || n.Notes[1].Text != "No test file beside it" {
		t.Fatalf("edit notes = %+v", n)
	}
	steps := h.waitFor("suggestions")[0].Steps
	var texts []string
	for _, st := range steps {
		texts = append(texts, st.Text)
	}
	if !proposed || len(steps) != 3 || steps[0].Text != "Run the tests that cover auth.go" {
		t.Fatalf("steps = %v (model asked: %v)", texts, proposed)
	}
}

func TestSuggestionsOffSendsNothing(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Auto, func(_ string, call fantasy.Call) reply {
		if role, text := lastOf(call); role == fantasy.MessageRoleUser && text == "go" {
			return reply{calls: [][2]string{{"write_file", `{"path":"a.go","content":"package a // TODO"}`}}}
		}
		return reply{text: "done"}
	})
	h.cfg.Env["ARCHYMEDES_SUGGEST"] = "off"
	h.prompt(h.create(), "go")
	time.Sleep(50 * time.Millisecond)
	if len(h.of("edit_notes"))+len(h.of("suggestions")) != 0 {
		t.Fatal("ARCHYMEDES_SUGGEST=off still suggested")
	}
}

func TestAPlainAnswerHasNoNextSteps(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Auto, func(string, fantasy.Call) reply { return reply{text: "It is a CLI."} })
	h.prompt(h.create(), "what is this")
	time.Sleep(50 * time.Millisecond)
	if len(h.of("suggestions")) != 0 {
		t.Fatal("a turn that changed and ran nothing got next steps")
	}
}
