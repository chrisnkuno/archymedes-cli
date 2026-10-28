package agents

import (
	"context"
	"strings"
	"testing"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// assistantCall is an assistant message that makes one tool call.
func assistantCall(id, input string) fantasy.Message {
	return fantasy.Message{Role: fantasy.MessageRoleAssistant, Content: []fantasy.MessagePart{
		fantasy.ToolCallPart{ToolCallID: id, ToolName: "run_command", Input: input},
	}}
}

// toolResult is the tool message that answers a call.
func toolResult(id, text string) fantasy.Message {
	return fantasy.Message{Role: fantasy.MessageRoleTool, Content: []fantasy.MessagePart{
		fantasy.ToolResultPart{ToolCallID: id, Output: fantasy.ToolResultOutputContentText{Text: text}},
	}}
}

func TestRecentCutLandsOnAStepBoundaryNotInsideAPair(t *testing.T) {
	big := strings.Repeat("x", 4000) // ~1000 tokens each
	messages := []fantasy.Message{
		fantasy.NewUserMessage("do the whole task"),
	}
	for i := 0; i < 6; i++ {
		messages = append(messages, assistantCall("c"+string(rune('0'+i)), `{"command":"go test ./..."}`), toolResult("c"+string(rune('0'+i)), big))
	}
	cut := recentCut(messages, 2500) // room for ~2 recent results
	if cut <= 0 || cut >= len(messages) {
		t.Fatalf("cut %d is not inside the conversation of %d", cut, len(messages))
	}
	if messages[cut].Role == fantasy.MessageRoleTool {
		t.Fatalf("cut %d starts the kept tail on tool results split from their call", cut)
	}
}

// TestCompactionShrinksALongAutoRunWithNoHumanTurns is the stall: a run that grinds through many
// commands without the person saying anything keeps its one user message at the start, so before
// the fix the tail was kept whole and compaction never shrank it. It must shrink now.
func TestCompactionShrinksALongAutoRunWithNoHumanTurns(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		_, text := lastOf(call)
		if strings.HasPrefix(text, "Summarize the conversation") {
			return reply{text: "ran the suite; it passes"}
		}
		return reply{text: "ok"}
	})
	h.cfg.Budgets.ContextLimit = 8000 // keep ~2000 tokens verbatim
	s := h.create()

	big := strings.Repeat("x", 4000)
	messages := []fantasy.Message{fantasy.NewUserMessage("do the whole task")}
	for i := 0; i < 8; i++ {
		id := "c" + string(rune('0'+i))
		messages = append(messages, assistantCall(id, `{"command":"go test ./..."}`), toolResult(id, big))
	}

	shorter, err := s.compactorFocused("")(context.Background(), messages)
	if err != nil {
		t.Fatalf("compaction errored on a long auto run: %v", err)
	}
	if len(shorter) >= len(messages) {
		t.Fatalf("compaction did not shrink: %d → %d", len(messages), len(shorter))
	}
	if shorter[0].Role != fantasy.MessageRoleUser {
		t.Fatalf("compacted conversation does not open with the person: role %q", shorter[0].Role)
	}
	if first := textOf(shorter[0]); !strings.Contains(first, "Summary of the conversation so far") {
		t.Fatalf("summary is not carried into the first message: %q", first)
	}
}
