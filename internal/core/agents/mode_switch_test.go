package agents

import (
	"context"
	"sync/atomic"
	"testing"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// TestAutoTakesOverTheRunningTurn: the person switches from build to auto while a turn runs; the
// edit after the switch is not asked about, and the session is saved in auto. A switch to plan, which
// changes the tools, waits for the next turn instead.
func TestAutoTakesOverTheRunningTurn(t *testing.T) {
	var s *Session
	var step atomic.Int64
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		switch step.Add(1) {
		case 1:
			return reply{calls: [][2]string{{"write_file", `{"path":"a.txt","content":"a"}`}}}
		case 2:
			s.SetMode(policy.Auto) // as the person presses shift+tab between two calls
			return reply{calls: [][2]string{{"write_file", `{"path":"b.txt","content":"b"}`}}}
		}
		return reply{text: "done"}
	})
	var asked []string
	h.cfg.Prompt = func(_ context.Context, r policy.Request) (policy.Decision, error) {
		asked = append(asked, r.Call.Args["path"].(string))
		return policy.Allow, nil
	}
	s = h.create()
	h.prompt(s, "write two files")
	if len(asked) != 1 || asked[0] != "a.txt" {
		t.Fatalf("asked about %v; in auto the second edit runs unasked", asked)
	}
	if s.Mode() != policy.Auto || s.Meta().Mode != "auto" {
		t.Fatalf("mode %s, saved %q", s.Mode(), s.Meta().Mode)
	}

	// Plan changes the tools: the ledger the running turn holds is left as it was.
	before := s.ledger
	s.SetMode(policy.Plan)
	if s.ledger == before || before.Mode() != policy.Auto || s.Mode() != policy.Plan {
		t.Fatalf("plan: same ledger %v, old ledger in %s, session in %s", s.ledger == before, before.Mode(), s.Mode())
	}
}
