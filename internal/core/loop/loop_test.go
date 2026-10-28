package loop

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// turn is one scripted model reply: text, calls (name → arguments), or an error before anything.
type turn struct {
	text   string
	calls  []scriptCall
	err    error
	finish fantasy.FinishReason
	// cacheRead is how many prompt tokens the provider says came from its cache.
	cacheRead int64
	// during runs while the reply streams, after its text and before its calls.
	during func()
}

type scriptCall struct {
	name string
	args string
}

// scripted plays turns in order and records every prompt it was sent.
type scripted struct {
	mu      sync.Mutex
	turns   []turn
	prompts []fantasy.Call
}

func (s *scripted) Model() string { return "scripted" }

func (s *scripted) Stream(_ context.Context, call fantasy.Call) (fantasy.StreamResponse, error) {
	s.mu.Lock()
	s.prompts = append(s.prompts, call)
	if len(s.turns) == 0 {
		s.mu.Unlock()
		return nil, fmt.Errorf("script ran out after %d calls", len(s.prompts)-1)
	}
	t := s.turns[0]
	s.turns = s.turns[1:]
	n := len(s.prompts)
	s.mu.Unlock()
	if t.err != nil {
		return nil, t.err
	}
	return func(yield func(fantasy.StreamPart) bool) {
		if t.text != "" && !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeTextDelta, Delta: t.text}) {
			return
		}
		if t.during != nil {
			t.during()
		}
		for i, c := range t.calls {
			id := fmt.Sprintf("call-%d-%d", n, i)
			if !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeToolInputStart, ID: id, ToolCallName: c.name}) {
				return
			}
			if !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeToolCall, ID: id, ToolCallName: c.name, ToolCallInput: c.args}) {
				return
			}
		}
		finish := t.finish
		if finish == "" {
			finish = fantasy.FinishReasonStop
		}
		yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeFinish, FinishReason: finish, Usage: fantasy.Usage{InputTokens: 100, OutputTokens: 10, CacheReadTokens: t.cacheRead}})
	}, nil
}

func (s *scripted) lastPrompt() fantasy.Call {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.prompts[len(s.prompts)-1]
}

type recorder struct {
	mu     sync.Mutex
	events []Event
}

func (r *recorder) emit(ev Event) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.events = append(r.events, ev)
}

func (r *recorder) types() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []string
	for _, ev := range r.events {
		out = append(out, ev.Type)
	}
	return out
}

func (r *recorder) of(kind string) []Event {
	r.mu.Lock()
	defer r.mu.Unlock()
	var out []Event
	for _, ev := range r.events {
		if ev.Type == kind {
			out = append(out, ev)
		}
	}
	return out
}

func readTool(name string, run func(tool.Args) tool.Result) *tool.Tool {
	return &tool.Tool{Name: name, Description: name, Capability: tool.CapRead, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(_ context.Context, _ tool.Context, args tool.Args) tool.Result { return run(args) }}
}

func writeTool(name string, ran *atomic.Int32) *tool.Tool {
	return &tool.Tool{Name: name, Description: name, Capability: tool.CapWrite, Effect: tool.EffectWorkspace,
		Run: func(_ context.Context, _ tool.Context, args tool.Args) tool.Result {
			ran.Add(1)
			return tool.Result{Content: "wrote " + tool.StringArg(args, "path")}
		}}
}

func allow(context.Context, tool.Call, *tool.Tool) (bool, error) { return true, nil }

func lastToolResults(t *testing.T, msgs []fantasy.Message) []string {
	t.Helper()
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].Role != fantasy.MessageRoleTool {
			continue
		}
		var out []string
		for _, part := range msgs[i].Content {
			p := part.(fantasy.ToolResultPart)
			switch o := p.Output.(type) {
			case fantasy.ToolResultOutputContentText:
				out = append(out, o.Text)
			case fantasy.ToolResultOutputContentError:
				out = append(out, "ERR:"+o.Error.Error())
			}
		}
		return out
	}
	t.Fatal("no tool message")
	return nil
}

func TestAnswerWithoutToolsCompletesAndStreams(t *testing.T) {
	model := &scripted{turns: []turn{{text: "hello"}}}
	rec := &recorder{}
	res := Run(context.Background(), Request{Model: model, System: "sys", Prompt: "hi", Tools: tool.NewCatalog(), Emit: rec.emit})
	if res.Status != Completed || res.Text != "hello" {
		t.Fatalf("result = %+v", res)
	}
	if got := strings.Join(rec.types(), ","); got != "assistant_delta,model_turn,runtime_stop" {
		t.Fatalf("events = %s", got)
	}
	prompt := model.lastPrompt().Prompt
	if prompt[0].Role != fantasy.MessageRoleSystem || prompt[1].Role != fantasy.MessageRoleUser {
		t.Fatal("system then user")
	}
	if res.Usage.InputTokens != 100 {
		t.Fatalf("usage = %+v", res.Usage)
	}
}

func TestReadOnlyCallsInOneStepRunTogether(t *testing.T) {
	var started sync.WaitGroup
	started.Add(2)
	release := make(chan struct{})
	both := func(args tool.Args) tool.Result {
		started.Done()
		select {
		case <-release:
		case <-time.After(2 * time.Second):
			return tool.Error("ran alone")
		}
		return tool.Text("read " + tool.StringArg(args, "path"))
	}
	go func() { started.Wait(); close(release) }()
	model := &scripted{turns: []turn{
		{calls: []scriptCall{{"read", `{"path":"a"}`}, {"read", `{"path":"b"}`}}},
		{text: "done"},
	}}
	res := Run(context.Background(), Request{Model: model, Prompt: "go", Tools: tool.NewCatalog(readTool("read", both)), Emit: (&recorder{}).emit})
	got := lastToolResults(t, res.Messages)
	if res.Status != Completed || len(got) != 2 || got[0] != "read a" || got[1] != "read b" {
		t.Fatalf("status %s, results %v", res.Status, got)
	}
}

func TestEffectfulCallsAskAndADeclineIsAResultNotAFailure(t *testing.T) {
	var ran atomic.Int32
	asked := 0
	deny := func(_ context.Context, call tool.Call, _ *tool.Tool) (bool, error) { asked++; return false, nil }
	model := &scripted{turns: []turn{{calls: []scriptCall{{"write", `{"path":"x"}`}}}, {text: "ok, not writing"}}}
	res := Run(context.Background(), Request{Model: model, Prompt: "go", Tools: tool.NewCatalog(writeTool("write", &ran)), Approve: deny})
	if asked != 1 || ran.Load() != 0 || res.Status != Completed {
		t.Fatalf("asked %d, ran %d, status %s", asked, ran.Load(), res.Status)
	}
	if got := lastToolResults(t, res.Messages); !strings.HasPrefix(got[0], "ERR:The person declined") {
		t.Fatalf("result = %v", got)
	}
}

func TestNoApproverMeansEffectfulCallsDoNotRun(t *testing.T) {
	var ran atomic.Int32
	model := &scripted{turns: []turn{{calls: []scriptCall{{"write", `{}`}}}, {text: "x"}}}
	Run(context.Background(), Request{Model: model, Prompt: "go", Tools: tool.NewCatalog(writeTool("write", &ran))})
	if ran.Load() != 0 {
		t.Fatal("an effectful call ran without anyone to approve it")
	}
}

func TestSteeringIsFoldedIntoTheNextStep(t *testing.T) {
	inbox := NewInbox()
	model := &scripted{turns: []turn{
		{calls: []scriptCall{{"read", `{"path":"a"}`}}, during: func() {
			if !inbox.Steer("also check b") {
				panic("steer refused while running")
			}
		}},
		{text: "checked a and b"},
	}}
	rec := &recorder{}
	res := Run(context.Background(), Request{Model: model, Prompt: "check a", Inbox: inbox, Emit: rec.emit,
		Tools: tool.NewCatalog(readTool("read", func(tool.Args) tool.Result { return tool.Text("ok") }))})
	if res.Status != Completed || len(rec.of(EventSteered)) != 1 {
		t.Fatalf("status %s, steered %v", res.Status, rec.of(EventSteered))
	}
	last := model.lastPrompt().Prompt
	user := last[len(last)-1]
	if user.Role != fantasy.MessageRoleUser || user.Content[0].(fantasy.TextPart).Text != "also check b" {
		t.Fatalf("last message = %+v", user)
	}
	if inbox.Steer("late") {
		t.Fatal("steering accepted after the run ended")
	}
}

func TestSteeringThatArrivesAsTheModelFinishesKeepsTheTurnGoing(t *testing.T) {
	inbox := NewInbox()
	model := &scripted{turns: []turn{
		{text: "done", during: func() { inbox.Steer("one more thing") }},
		{text: "did the one more thing"},
	}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Inbox: inbox, Tools: tool.NewCatalog()})
	if res.Text != "did the one more thing" || len(res.Unread) != 0 {
		t.Fatalf("result = %+v", res)
	}
}

func TestNoticesWaitForTheNextRunAndSteeringIsHandedBack(t *testing.T) {
	inbox := NewInbox()
	if inbox.Steer("x") {
		t.Fatal("steer accepted with no run")
	}
	inbox.Notify("[report from explore] found it")
	inbox.Open()
	inbox.Steer("typed late")
	if unread := inbox.Close(); len(unread) != 1 || unread[0] != "typed late" {
		t.Fatalf("unread = %v", unread)
	}
	if !inbox.HasNotices() {
		t.Fatal("a notice was dropped with the run")
	}
	model := &scripted{turns: []turn{{text: "thanks"}}}
	Run(context.Background(), Request{Model: model, Prompt: "next", Inbox: inbox, Tools: tool.NewCatalog()})
	prompt := model.lastPrompt().Prompt
	texts := []string{}
	for _, m := range prompt {
		if m.Role == fantasy.MessageRoleUser {
			texts = append(texts, m.Content[0].(fantasy.TextPart).Text)
		}
	}
	if strings.Join(texts, "|") != "next|[report from explore] found it" {
		t.Fatalf("user messages = %v", texts)
	}
}

func TestTheGateHoldsAnUnverifiedChangeOnce(t *testing.T) {
	var ran atomic.Int32
	model := &scripted{turns: []turn{
		{calls: []scriptCall{{"write", `{"path":"config.yaml"}`}}},
		{text: "done"},
		{text: "nothing to run: config only"},
	}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Approve: allow, Gate: gate.New(false), Tools: tool.NewCatalog(writeTool("write", &ran))})
	if res.Status != Completed || res.Text != "nothing to run: config only" {
		t.Fatalf("result = %+v", res)
	}
}

func TestRepeatingOneCallWithNothingChangingWarnsThenStops(t *testing.T) {
	same := scriptCall{"read", `{"path":"a"}`}
	var turns []turn
	for range 6 {
		turns = append(turns, turn{calls: []scriptCall{same}})
	}
	model := &scripted{turns: turns}
	rec := &recorder{}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Emit: rec.emit, Tools: tool.NewCatalog(readTool("read", func(tool.Args) tool.Result { return tool.Text("same") }))})
	if res.Status != Stuck || res.Steps != 5 {
		t.Fatalf("status %s after %d steps", res.Status, res.Steps)
	}
	results := rec.of(EventToolResult)
	if !strings.Contains(results[2].Content, "same arguments 3 times") {
		t.Fatalf("third result has no note: %q", results[2].Content)
	}
	stop := rec.of(EventStop)[0]
	if stop.Status != "stuck" || !strings.Contains(stop.Summary, "5 times") {
		t.Fatalf("stop = %+v", stop)
	}
}

func TestRerunningAfterAnEditIsNotALoop(t *testing.T) {
	var ran atomic.Int32
	var turns []turn
	for i := range 6 {
		turns = append(turns, turn{calls: []scriptCall{{"write", fmt.Sprintf(`{"path":"f%d"}`, i)}, {"read", `{"path":"a"}`}}})
	}
	turns = append(turns, turn{text: "fine"})
	model := &scripted{turns: turns}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Approve: allow, Tools: tool.NewCatalog(writeTool("write", &ran), readTool("read", func(tool.Args) tool.Result { return tool.Text("r") }))})
	if res.Status != Completed {
		t.Fatalf("status %s", res.Status)
	}
}

func TestRetriesARateLimitBeforeAnythingStreamed(t *testing.T) {
	model := &scripted{turns: []turn{{err: &fantasy.ProviderError{StatusCode: 429, Message: "slow down"}}, {text: "ok"}}}
	rec := &recorder{}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Tools: tool.NewCatalog(), Emit: rec.emit, RetryDelay: func(int) time.Duration { return time.Millisecond }})
	retries := rec.of(EventRetry)
	if res.Status != Completed || len(retries) != 1 || retries[0].Reason != "rate_limit" || retries[0].NextAttempt != 2 {
		t.Fatalf("status %s, retries %+v", res.Status, retries)
	}
}

func TestAnUnretryableErrorFailsTheRun(t *testing.T) {
	model := &scripted{turns: []turn{{err: &fantasy.ProviderError{StatusCode: 401, Message: "bad key"}}}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Tools: tool.NewCatalog(), RetryDelay: func(int) time.Duration { return 0 }})
	if res.Status != Failed || res.Err == nil {
		t.Fatalf("result = %+v", res)
	}
}

func TestBudgetEndsWithAWrapUpReport(t *testing.T) {
	model := &scripted{turns: []turn{
		{calls: []scriptCall{{"read", `{"path":"1"}`}}},
		{calls: []scriptCall{{"read", `{"path":"2"}`}}},
		{text: "report: found 1 and 2"},
	}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Budgets: Budgets{MaxSteps: 2}, WrapUp: "report now", Tools: tool.NewCatalog(readTool("read", func(tool.Args) tool.Result { return tool.Text("r") }))})
	if res.Status != BudgetExhausted || res.Text != "report: found 1 and 2" {
		t.Fatalf("result = %+v", res)
	}
	if len(model.lastPrompt().Tools) != 0 {
		t.Fatal("the wrap-up call offered tools")
	}
}

func TestUnknownToolAndBadArgumentsAreResultsTheModelCanFix(t *testing.T) {
	model := &scripted{turns: []turn{{calls: []scriptCall{{"nope", `{}`}, {"read", `not json`}}}, {text: "sorry"}}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Tools: tool.NewCatalog(readTool("read", func(tool.Args) tool.Result { return tool.Text("r") }))})
	got := lastToolResults(t, res.Messages)
	if !strings.Contains(got[0], `no tool named "nope"`) || !strings.Contains(got[0], "read") || !strings.Contains(got[1], "not a JSON object") {
		t.Fatalf("results = %v", got)
	}
}

func TestCallsPastThePerStepCapAreNotRun(t *testing.T) {
	var n atomic.Int32
	model := &scripted{turns: []turn{{calls: []scriptCall{{"read", `{"path":"1"}`}, {"read", `{"path":"2"}`}, {"read", `{"path":"3"}`}}}, {text: "ok"}}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Budgets: Budgets{MaxToolCallsPerStep: 2}, Tools: tool.NewCatalog(readTool("read", func(tool.Args) tool.Result { n.Add(1); return tool.Text("r") }))})
	got := lastToolResults(t, res.Messages)
	if n.Load() != 2 || !strings.Contains(got[2], "at most 2 tool calls") {
		t.Fatalf("ran %d, results %v", n.Load(), got)
	}
}

func TestDeferredToolCalledByNameRuns(t *testing.T) {
	hidden := readTool("jira", func(tool.Args) tool.Result { return tool.Text("issue made") })
	hidden.Deferred = true
	catalog := tool.NewCatalog(hidden)
	model := &scripted{turns: []turn{{calls: []scriptCall{{"jira", `{}`}}}, {text: "ok"}}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Tools: catalog})
	if got := lastToolResults(t, res.Messages); got[0] != "issue made" {
		t.Fatalf("results = %v", got)
	}
	first := model.prompts[0].Tools
	if len(first) != 1 || first[0].GetName() != tool.SearchToolName {
		t.Fatalf("first request offered %v", first)
	}
	if model.lastPrompt().Tools[0].GetName() != "jira" {
		t.Fatal("a tool called by name was not loaded for later steps")
	}
}

func TestCancelStopsTheRun(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	model := &scripted{turns: []turn{{text: "working", calls: []scriptCall{{"read", `{}`}}, during: cancel}, {text: "never"}}}
	res := Run(ctx, Request{Model: model, Prompt: "x", Tools: tool.NewCatalog(readTool("read", func(tool.Args) tool.Result { return tool.Text("r") }))})
	if res.Status != Cancelled {
		t.Fatalf("status %s", res.Status)
	}
}

func TestCompactionReplacesALongConversation(t *testing.T) {
	model := &scripted{turns: []turn{{calls: []scriptCall{{"read", `{}`}}}, {text: "done"}}}
	rec := &recorder{}
	compact := func(_ context.Context, msgs []fantasy.Message) ([]fantasy.Message, error) {
		return []fantasy.Message{fantasy.NewUserMessage("summary of " + fmt.Sprint(len(msgs)) + " messages")}, nil
	}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Emit: rec.emit, Compact: compact, Budgets: Budgets{ContextLimit: 100, CompactAt: 0.5},
		Tools: tool.NewCatalog(readTool("read", func(tool.Args) tool.Result { return tool.Text("r") }))})
	c := rec.of(EventCompaction)
	if res.Status != Completed || len(c) != 1 || c[0].MessagesBefore != 3 || c[0].MessagesAfter != 1 {
		t.Fatalf("status %s, compactions %+v", res.Status, c)
	}
}

func TestALongConversationIsCompactedBeforeTheCallGoesOut(t *testing.T) {
	model := &scripted{turns: []turn{{text: "done"}}}
	rec := &recorder{}
	compact := func(_ context.Context, _ []fantasy.Message) ([]fantasy.Message, error) {
		return []fantasy.Message{fantasy.NewUserMessage("summary")}, nil
	}
	// A big history: estimated well over the threshold (ContextLimit 1000 × 0.5 = 500 tokens).
	var history []fantasy.Message
	for range 12 {
		history = append(history, fantasy.NewUserMessage(strings.Repeat("x", 1000)))
	}
	res := Run(context.Background(), Request{Model: model, History: history, Prompt: "go", Emit: rec.emit,
		Compact: compact, Budgets: Budgets{ContextLimit: 1000, CompactAt: 0.5}, Tools: tool.NewCatalog()})
	if res.Status != Completed {
		t.Fatalf("status %s", res.Status)
	}
	if c := rec.of(EventCompaction); len(c) != 1 {
		t.Fatalf("compactions %+v", c)
	}
	// The model never saw the oversized prompt: its first call was already the compacted one.
	if got := len(model.prompts[0].Prompt); got != 1 {
		t.Fatalf("first prompt carried %d messages, not the compacted 1", got)
	}
}

func TestAStepsResultsAreHeldToTheStepBudgetFairly(t *testing.T) {
	r := &run{budgets: withDefaults(Budgets{ContextLimit: 16_000})} // step budget = 8,000 chars
	big := strings.Repeat("x", 50_000)
	outcomes := []outcome{
		{call: tool.Call{ID: "a"}, result: tool.Result{Content: big}},
		{call: tool.Call{ID: "b"}, result: tool.Result{Content: big}},
		{call: tool.Call{ID: "c"}, result: tool.Result{Content: "ok"}},
	}
	r.budgetStepResults(outcomes)
	if outcomes[2].result.Content != "ok" {
		t.Fatalf("the small result was trimmed: %q", outcomes[2].result.Content)
	}
	for _, i := range []int{0, 1} {
		if !strings.Contains(outcomes[i].result.Content, "within its context budget") {
			t.Fatalf("a trimmed result was not marked: %q", outcomes[i].result.Content)
		}
	}
	total := 0
	for _, o := range outcomes {
		total += len(o.result.Content)
	}
	budget := r.budgets.MaxStepResultChars
	slack := len(outcomes) * (len(stepTrimNote) + 100) // truncation markers and the per-result note
	if total > budget+slack {
		t.Fatalf("step results %d exceed the budget %d (+%d slack)", total, budget, slack)
	}
}

// TestConformFlowBudgetsFitTheWindow is the flow invariant: for any window, a step's results fit
// what compaction keeps verbatim, which is under the trip point, which is under the window. A
// later change to any constant that breaks the chain fails here.
func TestConformFlowBudgetsFitTheWindow(t *testing.T) {
	for _, w := range []int{8_000, 32_000, 128_000, 200_000, 1_000_000} {
		b := withDefaults(Budgets{ContextLimit: w})
		step := b.MaxStepResultChars / CharsPerToken
		keep := b.ContextLimit / CompactionKeepDivisor
		trip := int(b.CompactAt * float64(b.ContextLimit))
		if !(step <= keep && keep <= trip && trip <= b.ContextLimit) {
			t.Fatalf("window %d: step %d > keep %d > trip %d > window %d — chain broken", w, step, keep, trip, b.ContextLimit)
		}
		// Output headroom: a reply from the trip point fits under the window.
		if trip+int(b.MaxOutputTokens) > b.ContextLimit {
			t.Fatalf("window %d: trip %d + reply %d overruns window %d", w, trip, b.MaxOutputTokens, b.ContextLimit)
		}
	}
}

func TestABigResultIsOffloadedAndReferenced(t *testing.T) {
	big := strings.Repeat("y", 60_000) // over MaxResultChars (40,000)
	stored := map[string]string{}
	model := &scripted{turns: []turn{{calls: []scriptCall{{"read", `{}`}}}, {text: "done"}}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x",
		Tools:       tool.NewCatalog(readTool("read", func(tool.Args) tool.Result { return tool.Text(big) })),
		ResultStore: func(id, content string) string { stored[id] = content; return ".archymedes/results/" + id + ".txt" },
	})
	if res.Status != Completed {
		t.Fatalf("status %s", res.Status)
	}
	if len(stored) != 1 {
		t.Fatalf("stored %d results, want 1", len(stored))
	}
	for _, v := range stored {
		if len(v) != 60_000 {
			t.Fatalf("stored result is %d chars, not the full 60,000", len(v))
		}
	}
	var toolText string
	for _, m := range res.Messages {
		if m.Role == fantasy.MessageRoleTool {
			for _, p := range m.Content {
				if r, ok := p.(fantasy.ToolResultPart); ok {
					if o, ok := r.Output.(fantasy.ToolResultOutputContentText); ok {
						toolText = o.Text
					}
				}
			}
		}
	}
	if len(toolText) >= 60_000 {
		t.Fatalf("the model was sent the whole %d-char result; it was not trimmed", len(toolText))
	}
	if !strings.Contains(toolText, ".archymedes/results/") || !strings.Contains(toolText, "read_file") {
		t.Fatalf("the trimmed result does not point at the saved output: %q", last200(toolText))
	}
}

func TestTheStepBudgetKeepsTheOffloadReference(t *testing.T) {
	r := &run{budgets: withDefaults(Budgets{ContextLimit: 16_000})} // step budget 8,000 chars
	big := strings.Repeat("z", 50_000)
	outcomes := []outcome{
		{call: tool.Call{ID: "a"}, result: tool.Result{Content: big, Data: map[string]any{"offloadRef": "x/a.txt", "offloadChars": 50_000}}},
		{call: tool.Call{ID: "b"}, result: tool.Result{Content: big}},
	}
	r.budgetStepResults(outcomes)
	if !strings.Contains(outcomes[0].result.Content, "x/a.txt") {
		t.Fatalf("the saved-output path was lost when the step was trimmed: %q", last200(outcomes[0].result.Content))
	}
	if !strings.Contains(outcomes[1].result.Content, "context budget") {
		t.Fatalf("the un-saved result was not marked trimmed: %q", last200(outcomes[1].result.Content))
	}
}

func last200(s string) string {
	if len(s) <= 200 {
		return s
	}
	return s[len(s)-200:]
}

func TestLengthCutOffContinues(t *testing.T) {
	model := &scripted{turns: []turn{{text: "part one ", finish: fantasy.FinishReasonLength}, {text: "part two"}}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Tools: tool.NewCatalog()})
	if res.Text != "part two" || len(model.prompts) != 2 {
		t.Fatalf("result = %+v", res)
	}
}

func TestEventsSerializeAsTheInterfaceReadsThem(t *testing.T) {
	data, _ := json.Marshal(Event{Type: EventToolCall, ToolCallID: "c1", ToolName: "read_file", Effect: "none", Arguments: map[string]any{"path": "a"}})
	if string(data) != `{"type":"tool_call","toolCallId":"c1","toolName":"read_file","effect":"none","arguments":{"path":"a"}}` {
		t.Fatalf("json = %s", data)
	}
}

func TestTruncateKeepsHeadAndTail(t *testing.T) {
	got := truncate(strings.Repeat("a", 50)+strings.Repeat("z", 50), 30)
	if !strings.HasPrefix(got, strings.Repeat("a", 20)) || !strings.HasSuffix(got, strings.Repeat("z", 10)) || !strings.Contains(got, "70 characters left out") {
		t.Fatalf("truncate = %q", got)
	}
}

func TestARetractedNoticeIsNeverRead(t *testing.T) {
	inbox := NewInbox()
	inbox.NotifyKey("t-a", "report a")
	inbox.NotifyKey("t-b", "report b")
	if !inbox.Retract("t-a") || inbox.Retract("t-a") || inbox.Retract("") {
		t.Fatal("retract should withdraw a keyed notice once")
	}
	if got := inbox.Drain(); len(got) != 1 || got[0] != "report b" {
		t.Fatalf("drained %v", got)
	}
}

// silentModel sends nothing until its context ends, the first time; then answers.
type silentModel struct{ calls atomic.Int32 }

func (m *silentModel) Model() string { return "silent" }

func (m *silentModel) Stream(ctx context.Context, _ fantasy.Call) (fantasy.StreamResponse, error) {
	n := m.calls.Add(1)
	return func(yield func(fantasy.StreamPart) bool) {
		if n == 1 {
			<-ctx.Done()
			return
		}
		yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeTextDelta, Delta: "back"})
		yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeFinish, FinishReason: fantasy.FinishReasonStop})
	}, nil
}

func TestASilentStreamIsCutAndRetried(t *testing.T) {
	model := &silentModel{}
	rec := &recorder{}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Tools: tool.NewCatalog(), Emit: rec.emit, IdleTimeout: 50 * time.Millisecond, RetryDelay: func(int) time.Duration { return time.Millisecond }})
	if res.Status != Completed || res.Text != "back" || len(rec.of(EventRetry)) != 1 {
		t.Fatalf("result %+v, retries %v", res, rec.of(EventRetry))
	}
}

func TestRetryWaitsAsLongAsTheProviderSays(t *testing.T) {
	r := &run{}
	cases := []struct {
		err  error
		want time.Duration
	}{
		{&fantasy.ProviderError{StatusCode: 429, Message: "Rate limit reached ... Please try again in 11.2725s. Need more tokens?"}, 11*time.Second + 522500*time.Microsecond},
		{&fantasy.ProviderError{StatusCode: 429, Message: "try again in 1m2.5s"}, 62*time.Second + 750*time.Millisecond},
		{&fantasy.ProviderError{StatusCode: 429, ResponseHeaders: map[string]string{"retry-after": "7"}}, 7*time.Second + 250*time.Millisecond},
		{&fantasy.ProviderError{StatusCode: 429, ResponseHeaders: map[string]string{"retry-after-ms": "300"}}, time.Second},
		{&fantasy.ProviderError{StatusCode: 429, Message: "try again in 10m"}, time.Second},
		{&fantasy.ProviderError{StatusCode: 503}, time.Second},
	}
	for _, c := range cases {
		if got := r.delay(1, c.err); got != c.want {
			t.Errorf("delay(%v) = %v, want %v", c.err, got, c.want)
		}
	}
	if got := r.delay(1, &fantasy.ProviderError{StatusCode: 429, ResponseHeaders: map[string]string{"retry-after": "600"}}); got != MaxWait {
		t.Errorf("a long hint is capped: %v", got)
	}
	if r.attempts(&fantasy.ProviderError{StatusCode: 429}) != 8 || r.attempts(&fantasy.ProviderError{StatusCode: 503}) != 4 {
		t.Error("rate limits get more attempts")
	}
}

// pingingModel sends only keepalives for a while, then answers: a slow but living stream.
type pingingModel struct{}

func (pingingModel) Model() string { return "pinging" }

func (pingingModel) Stream(ctx context.Context, _ fantasy.Call) (fantasy.StreamResponse, error) {
	return func(yield func(fantasy.StreamPart) bool) {
		for range 10 {
			time.Sleep(20 * time.Millisecond)
			if !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeKeepalive}) {
				return
			}
		}
		yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeTextDelta, Delta: "slow but alive"})
		yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeFinish, FinishReason: fantasy.FinishReasonStop})
	}, nil
}

func TestKeepalivesHoldOffTheIdleWatchdog(t *testing.T) {
	res := Run(context.Background(), Request{Model: pingingModel{}, Prompt: "x", Tools: tool.NewCatalog(), IdleTimeout: 80 * time.Millisecond, MaxAttempts: 1})
	if res.Status != Completed || res.Text != "slow but alive" {
		t.Fatalf("result = %+v", res)
	}
}

func TestTruncateNeverSplitsACharacter(t *testing.T) {
	for _, text := range []string{strings.Repeat("é", 100), strings.Repeat("日本語", 50), strings.Repeat("a😀", 40)} {
		for max := 5; max < 60; max++ {
			got := truncate(text, max)
			if !utf8.ValidString(got) {
				t.Fatalf("truncate(%q…, %d) is not valid UTF-8: %q", text[:6], max, got)
			}
		}
	}
	if got := truncate(strings.Repeat("é", 100), 31); !strings.Contains(got, "characters left out") || !strings.HasPrefix(got, strings.Repeat("é", 10)) {
		t.Fatalf("truncate = %q", got)
	}
}

// TestANamespacedToolNameRunsTheToolItMeans: gpt-oss writes repo_browser.run_command; refusing it
// cost a real run three steps.
func TestANamespacedToolNameRunsTheToolItMeans(t *testing.T) {
	var ran atomic.Int32
	model := &scripted{turns: []turn{
		{calls: []scriptCall{{"functions.write", `{"path":"config.yaml"}`}}},
		{text: "done"},
		{text: "checked"},
	}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Approve: allow, Gate: gate.New(false), Tools: tool.NewCatalog(writeTool("write", &ran))})
	if ran.Load() != 1 || res.Status != Completed {
		t.Fatalf("ran %d, result %+v", ran.Load(), res)
	}
}

// TestCachedTokensCountAsPartOfThePrompt: Fantasy reports cache reads apart from InputTokens; the
// conversation's size (what compaction, the context gauge and /cost read) includes them.
func TestCachedTokensCountAsPartOfThePrompt(t *testing.T) {
	model := &scripted{turns: []turn{{text: "hi", cacheRead: 900}}}
	res := Run(context.Background(), Request{Model: model, Prompt: "x", Approve: allow, Tools: tool.NewCatalog()})
	if res.Usage.InputTokens != 1000 || res.Usage.CachedInputTokens != 900 {
		t.Fatalf("usage = %+v", res.Usage)
	}
}
