package main

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/roles"
	"github.com/chrisnkuno/friday-cli/internal/core/tools"
)

// thousands writes n as the documents do: 128,000.
func thousands(n int) string {
	s := fmt.Sprint(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func seconds(d time.Duration) int { return int(d / time.Second) }

var spelled = map[int]string{2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 8: "eight"}

// TestConformDocumentedMeasures: every number a document states about the engine is the number
// in the code. A measure is written as the document writes it, so a change to either side shows.
func TestConformDocumentedMeasures(t *testing.T) {
	b := loop.DefaultBudgets()
	measures := []struct{ doc, text string }{
		{"USER_GUIDE.md", fmt.Sprintf("| Steps in a turn | %d |", b.MaxSteps)},
		{"USER_GUIDE.md", fmt.Sprintf("| Tool calls in a turn | %d |", b.MaxToolCalls)},
		{"USER_GUIDE.md", fmt.Sprintf("| Tool calls in one step | %d |", b.MaxToolCallsPerStep)},
		{"USER_GUIDE.md", fmt.Sprintf("| One tool result | %s characters |", thousands(b.MaxResultChars))},
		{"USER_GUIDE.md", fmt.Sprintf("| One reply | %s tokens |", thousands(int(b.MaxOutputTokens)))},
		{"USER_GUIDE.md", fmt.Sprintf("| A silent stream | %d minutes |", int(loop.IdleTimeout/time.Minute))},
		{"USER_GUIDE.md", fmt.Sprintf("assumed to be %s tokens", thousands(llm.DefaultContextLimit))},
		{"USER_GUIDE.md", fmt.Sprintf("up to %d\ntimes for an outage, %d for a rate limit", loop.RetryAttempts, loop.RateLimitAttempts)},
		{"USER_GUIDE.md", fmt.Sprintf("up to %d seconds", seconds(loop.MaxWait))},
		{"USER_GUIDE.md", fmt.Sprintf("At most %s run at once", spelled[agents.DefaultMaxChildren])},
		{"ARCHITECTURE.md", fmt.Sprintf("up to %d attempts, %d for a rate", loop.RetryAttempts, loop.RateLimitAttempts)},
		{"ARCHITECTURE.md", fmt.Sprintf("at most %d) and the provider's", seconds(loop.MaxBackoff))},
		{"ARCHITECTURE.md", fmt.Sprintf("at most %d s", seconds(loop.MaxWait))},
		{"ARCHITECTURE.md", fmt.Sprintf("compacts past %.0f%% of the window", b.CompactAt*100)},
		{"CONFIGURATION.md", fmt.Sprintf("| `ARCHYMEDES_CONTEXT_LIMIT` | `%d` |", llm.DefaultContextLimit)},
		{"TOOLS.md", fmt.Sprintf("how many lines; default %s", thousands(tools.ReadLimit))},
		{"TOOLS.md", fmt.Sprintf("default %d, at most %s |", seconds(tools.CommandTimeout), thousands(seconds(tools.CommandCeiling)))},
		{"TOOLS.md", fmt.Sprintf("default %d, at most %s |", seconds(agents.WaitDefault), thousands(seconds(agents.WaitCeiling)))},
		{"TOOLS.md", fmt.Sprintf("over %s characters (%s for a sub-agent)", thousands(b.MaxResultChars), thousands(roles.SubagentResultChars))},
		{"SUBAGENTS.md", fmt.Sprintf("(default %d, at most %s)", seconds(agents.WaitDefault), thousands(seconds(agents.WaitCeiling)))},
		{"SUBAGENTS.md", fmt.Sprintf("tool results to %s characters each", thousands(roles.SubagentResultChars))},
	}
	for _, m := range measures {
		data, err := os.ReadFile("../../docs/engine/" + m.doc)
		if err != nil {
			t.Fatal(err)
		}
		if !strings.Contains(string(data), m.text) {
			t.Errorf("docs/engine/%s does not say %q, which is what the code holds", m.doc, m.text)
		}
	}
}
