package agents

import (
	"context"
	"os"
	"strings"
	"testing"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/conform"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// TestConformRootTools holds every tool the main conversation can have, in every mode, to the
// standard: the coordinator's own (delegation, questions) as well as the built-ins.
func TestConformRootTools(t *testing.T) {
	docs, err := os.ReadFile("../../../docs/engine/TOOLS.md")
	if err != nil {
		t.Fatal(err)
	}
	h := newHarness(t, t.TempDir(), policy.Build, func(string, fantasy.Call) reply { return reply{text: "x"} })
	h.cfg.Ask = func(context.Context, string, []string, bool) (string, error) { return "", nil }
	s := h.create()
	seen := map[string]bool{}
	for _, mode := range []policy.Mode{policy.Plan, policy.Build, policy.Auto, policy.Defender} {
		for _, tl := range s.rootTools(mode).All() {
			if seen[tl.Name] {
				continue
			}
			seen[tl.Name] = true
			problems := append(append(conform.Name("tool", tl.Name), conform.ToolDescription(tl.Description)...), tool.Contract(tl)...)
			if !strings.Contains(string(docs), "`"+tl.Name+"`") {
				problems = append(problems, "not in docs/engine/TOOLS.md")
			}
			for _, p := range problems {
				t.Errorf("%s: %s", tl.Name, p)
			}
		}
	}
	for _, want := range []string{"ask_user", "delegate_task", "delegate_readonly_task", "wait_agents", "send_agent", "close_agent"} {
		if !seen[want] {
			t.Errorf("%s was not offered in any mode", want)
		}
	}
}
