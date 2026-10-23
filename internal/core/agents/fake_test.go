package agents

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// reply is what the fake model says to one call: text and tool calls (name, JSON arguments).
type reply struct {
	text  string
	calls [][2]string
}

// brain answers every call; it sees which model was called and the whole request.
type brain func(model string, call fantasy.Call) reply

type fakeModel struct {
	id    string
	brain brain
	calls *atomic.Int64
}

func (m fakeModel) Model() string    { return m.id }
func (m fakeModel) Provider() string { return "fake" }
func (m fakeModel) Generate(context.Context, fantasy.Call) (*fantasy.Response, error) {
	return nil, errors.New("not used")
}
func (m fakeModel) GenerateObject(context.Context, fantasy.ObjectCall) (*fantasy.ObjectResponse, error) {
	return nil, errors.New("not used")
}
func (m fakeModel) StreamObject(context.Context, fantasy.ObjectCall) (fantasy.ObjectStreamResponse, error) {
	return nil, errors.New("not used")
}

func (m fakeModel) Stream(ctx context.Context, call fantasy.Call) (fantasy.StreamResponse, error) {
	n := m.calls.Add(1)
	r := m.brain(m.id, call)
	return func(yield func(fantasy.StreamPart) bool) {
		if ctx.Err() != nil {
			return
		}
		if r.text != "" && !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeTextDelta, Delta: r.text}) {
			return
		}
		for i, c := range r.calls {
			id := fmt.Sprintf("c%d-%d", n, i)
			if !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeToolCall, ID: id, ToolCallName: c[0], ToolCallInput: c[1]}) {
				return
			}
		}
		yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeFinish, FinishReason: fantasy.FinishReasonStop, Usage: fantasy.Usage{InputTokens: 10, OutputTokens: 5}})
	}, nil
}

// harness is a session on a fake provider with the notices it sent.
type harness struct {
	t       *testing.T
	root    string
	cfg     Config
	mu      sync.Mutex
	notices []Notice
	calls   atomic.Int64
}

func newHarness(t *testing.T, root string, mode policy.Mode, b brain) *harness {
	t.Helper()
	h := &harness{t: t, root: root}
	open := func(_ context.Context, _ llm.Selection, _ llm.Env, id string) (fantasy.LanguageModel, error) {
		return fakeModel{id: id, brain: b, calls: &h.calls}, nil
	}
	sel := llm.Selection{Provider: llm.Provider{ID: "fake", Label: "Fake"}, Model: "big", Small: "little"}
	models, err := llm.NewModels(context.Background(), sel, llm.Env{}, open)
	if err != nil {
		t.Fatal(err)
	}
	h.cfg = Config{
		Root: root, ConfigDir: t.TempDir(), Env: llm.Env{"ARCHYMEDES_TITLES": "off"}, Models: models, Mode: mode,
		Prompt: func(context.Context, policy.Request) (policy.Decision, error) { return policy.Allow, nil },
		Notify: func(n Notice) { h.mu.Lock(); h.notices = append(h.notices, n); h.mu.Unlock() },
	}
	return h
}

func (h *harness) create() *Session {
	h.t.Helper()
	s, err := Create(context.Background(), h.cfg, "")
	if err != nil {
		h.t.Fatal(err)
	}
	h.t.Cleanup(s.Close)
	return s
}

func (h *harness) prompt(s *Session, text string) loop.Result {
	return s.Prompt(context.Background(), s.Accept(), text)
}

func (h *harness) of(kind string) []Notice {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []Notice
	for _, n := range h.notices {
		if n.Kind == kind {
			out = append(out, n)
		}
	}
	return out
}

// isChild tells a sub-agent's request from the root's by its system prompt.
func isChild(call fantasy.Call) bool {
	return len(call.Prompt) > 0 && call.Prompt[0].Role == fantasy.MessageRoleSystem && strings.Contains(textOf(call.Prompt[0]), "Friday sub-agent")
}

func textOf(m fantasy.Message) string {
	var b strings.Builder
	for _, p := range m.Content {
		if t, ok := p.(fantasy.TextPart); ok {
			b.WriteString(t.Text)
		}
	}
	return b.String()
}

// lastOf is the newest message's text and tool results, for a brain deciding what to do next.
func lastOf(call fantasy.Call) (role fantasy.MessageRole, text string) {
	m := call.Prompt[len(call.Prompt)-1]
	if m.Role == fantasy.MessageRoleTool {
		var parts []string
		for _, p := range m.Content {
			r := p.(fantasy.ToolResultPart)
			switch o := r.Output.(type) {
			case fantasy.ToolResultOutputContentText:
				parts = append(parts, o.Text)
			case fantasy.ToolResultOutputContentError:
				parts = append(parts, "ERROR "+o.Error.Error())
			}
		}
		return m.Role, strings.Join(parts, "\n")
	}
	return m.Role, textOf(m)
}

func userTexts(call fantasy.Call) []string {
	var out []string
	for _, m := range call.Prompt {
		if m.Role == fantasy.MessageRoleUser {
			out = append(out, textOf(m))
		}
	}
	return out
}
