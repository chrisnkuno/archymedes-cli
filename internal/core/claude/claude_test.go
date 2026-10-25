package claude

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/claude/claudetest"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

func TestMain(m *testing.M) {
	if claudetest.Active() {
		claudetest.Main()
		return
	}
	os.Exit(m.Run())
}

func feedAll(tr *translator, lines ...string) []agents.Notice {
	var out []agents.Notice
	for _, line := range lines {
		out = append(out, tr.feed(json.RawMessage(line))...)
	}
	return out
}

func types(notices []agents.Notice) []string {
	var out []string
	for _, n := range notices {
		if n.Event != nil {
			out = append(out, n.Kind+":"+n.Event.Type)
		}
	}
	return out
}

func TestStreamedTextArrivesOnceAndAMessageThatDidNotStreamIsSentWhole(t *testing.T) {
	tr := newTranslator("/p")
	tr.begin()
	got := feedAll(tr,
		`{"type":"stream_event","event":{"type":"message_start","message":{"id":"m1","model":"claude-x","usage":{"input_tokens":3,"cache_read_input_tokens":7}}},"parent_tool_use_id":null}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}},"parent_tool_use_id":null}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}},"parent_tool_use_id":null}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Hello"}]},"parent_tool_use_id":null}`,
		`{"type":"stream_event","event":{"type":"message_delta","usage":{"output_tokens":4}},"parent_tool_use_id":null}`,
		`{"type":"stream_event","event":{"type":"message_stop"},"parent_tool_use_id":null}`,
		`{"type":"assistant","message":{"id":"m2","content":[{"type":"text","text":" again"}]},"parent_tool_use_id":null}`,
	)
	want := []string{"runtime:assistant_delta", "runtime:assistant_delta", "runtime:model_turn", "runtime:assistant_delta"}
	if !slices.Equal(types(got), want) {
		t.Fatalf("events = %v, want %v", types(got), want)
	}
	if u := got[2].Event.Usage; u.InputTokens != 10 || u.CachedInputTokens != 7 || u.OutputTokens != 4 || got[2].Event.Model != "claude-x" {
		t.Fatalf("model turn = %+v %+v", got[2].Event, u)
	}
	_, o := tr.finish(&message{Subtype: "success", Result: "Hello again"}, false, "")
	if o.text != "Hello again" || o.status != loop.Completed {
		t.Fatalf("outcome = %+v", o)
	}
}

func TestEveryToolCallIsAnsweredOnceAndATurnEndsWithOneStop(t *testing.T) {
	tr := newTranslator("/p")
	tr.begin()
	got := feedAll(tr,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{"file_path":"/p/a.go","old_string":"x","new_string":"y"}},{"type":"tool_use","id":"t2","name":"Bash","input":{"command":"go test"}}]},"parent_tool_use_id":null}`,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"t1","name":"Edit","input":{}}]},"parent_tool_use_id":null}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"The file has been updated"}]},"parent_tool_use_id":null}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"again"}]},"parent_tool_use_id":null}`,
	)
	if !slices.Equal(types(got), []string{"runtime:tool_call", "runtime:tool_call", "runtime:tool_result"}) {
		t.Fatalf("events = %v", types(got))
	}
	edit := got[0].Event
	if edit.ToolName != "edit_file" || edit.Arguments["path"] != "a.go" || edit.Arguments["oldText"] != "x" || edit.Effect != "workspace" {
		t.Fatalf("edit shown as %+v", edit)
	}
	if got[2].Event.Content != "--- a/a.go\n+++ b/a.go\n@@ -1,1 +1,1 @@\n-x\n+y" {
		t.Fatalf("an edit's result is its diff: %q", got[2].Event.Content)
	}
	if !tr.toolRunning() {
		t.Fatal("t2 is still running")
	}
	end, o := tr.finish(nil, true, "")
	if !slices.Equal(types(end), []string{"runtime:tool_result", "runtime:runtime_stop"}) || !end[0].Event.IsError || o.status != loop.Cancelled {
		t.Fatalf("finish = %v %+v", types(end), o)
	}
	if more := feedAll(tr, `{"type":"assistant","message":{"id":"m9","content":[{"type":"text","text":"late"}]},"parent_tool_use_id":null}`); len(more) != 0 {
		t.Fatal("nothing follows runtime_stop")
	}
	if again, _ := tr.finish(nil, false, ""); len(again) != 0 {
		t.Fatal("a turn ends once")
	}
}

func TestASubagentsWorkGoesUnderItsTaskCall(t *testing.T) {
	tr := newTranslator("/p")
	tr.begin()
	got := feedAll(tr,
		`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"task","name":"Task","input":{"description":"look around","subagent_type":"Explore"}}]},"parent_tool_use_id":null}`,
		`{"type":"assistant","message":{"id":"s1","content":[{"type":"text","text":"thinking aloud"},{"type":"tool_use","id":"r1","name":"Read","input":{"file_path":"/p/x.go"}}]},"parent_tool_use_id":"task"}`,
		`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"sub text"}},"parent_tool_use_id":"task"}`,
		`{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"r1","content":"`+strings.Repeat("a", 500)+`"}]},"parent_tool_use_id":"task"}`,
	)
	if !slices.Equal(types(got), []string{"runtime:tool_call", "subagent:tool_call", "subagent:tool_result"}) {
		t.Fatalf("events = %v", types(got))
	}
	if got[0].Event.ToolName != "delegate_task" || got[1].ParentToolCallID != "task" || got[1].Agent != "Explore" || got[1].Event.Arguments["path"] != "x.go" {
		t.Fatalf("sub-agent = %+v / %+v", got[0].Event, got[1])
	}
	if len(got[2].Event.Content) != subagentResultChars {
		t.Fatalf("a sub-agent's result is a line, got %d chars", len(got[2].Event.Content))
	}
}

func TestAFailedTurnSaysWhatClaudeCodeSaidAndThePlanLimit(t *testing.T) {
	tr := newTranslator("/p")
	feedAll(tr, `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"seven_day","resetsAt":0}}`)
	tr.begin()
	_, o := tr.finish(&message{Subtype: "error_during_execution", IsError: true, Errors: []string{"overloaded"}}, false, "")
	if o.status != loop.Failed || o.summary != "Claude Code: overloaded. Your Claude plan's weekly limit is used up." {
		t.Fatalf("outcome = %+v", o)
	}
	tr.begin()
	if _, o := tr.finish(&message{Subtype: "error_max_turns", IsError: true}, false, ""); o.status != loop.BudgetExhausted {
		t.Fatalf("outcome = %+v", o)
	}
	tr.begin()
	if _, o := tr.finish(nil, false, "Claude Code exited."); o.summary != "Claude Code exited." {
		t.Fatalf("outcome = %+v", o)
	}
}

func TestResultTextIsCutOnARuneBoundary(t *testing.T) {
	long, _ := json.Marshal(strings.Repeat("é", MaxResultChars))
	text := resultText(long)
	if !strings.Contains(text, "more characters") || !json.Valid(mustMarshal(text)) || strings.ContainsRune(text, '\uFFFD') {
		t.Fatalf("cut badly: …%q", text[len(text)-40:])
	}
	if got := resultText(json.RawMessage(`[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]`)); got != "a\n[image]\nb" {
		t.Fatalf("blocks = %q", got)
	}
}

func mustMarshal(v any) []byte {
	data, _ := json.Marshal(v)
	return data
}

func TestScreenAnswersWhatFridaysOwnModelsWouldNotAsk(t *testing.T) {
	rules := policy.ParseCommandRules(`{"rules":[{"prefix":["make","deploy"],"decision":"forbid","reason":"deploys go through CI"},{"prefix":["npm","test"],"decision":"allow"}]}`, "rules.json").Rules
	cases := []struct {
		name  string
		tool  string
		input map[string]any
		mode  policy.Mode
		want  verdict
	}{
		{"a read never asks", "Read", nil, policy.Build, allow},
		{"a web search never asks", "WebSearch", nil, policy.Defender, allow},
		{"forbidden by rule", "Bash", map[string]any{"command": "make deploy"}, policy.Auto, deny},
		{"allowed by rule", "Bash", map[string]any{"command": "npm test"}, policy.Build, allow},
		{"defender looks at every change", "Bash", map[string]any{"command": "npm test"}, policy.Defender, ask},
		{"a read-only command", "Bash", map[string]any{"command": "git status"}, policy.Build, allow},
		{"auto runs a safe command", "Bash", map[string]any{"command": "go test ./..."}, policy.Auto, allow},
		{"auto asks about a destructive one", "Bash", map[string]any{"command": "rm -rf build"}, policy.Auto, ask},
		{"leaving the sandbox asks", "Bash", map[string]any{"command": "go test ./...", "dangerouslyDisableSandbox": true}, policy.Auto, ask},
		{"build asks", "Bash", map[string]any{"command": "go test ./..."}, policy.Build, ask},
		{"an edit asks (acceptEdits is Claude Code's own)", "Edit", map[string]any{"file_path": "a"}, policy.Build, ask},
	}
	for _, c := range cases {
		if got, why := screen(c.tool, c.input, c.mode, rules); got != c.want || (got == deny && !strings.Contains(why, "deploys go through CI")) {
			t.Errorf("%s: got %v %q, want %v", c.name, got, why, c.want)
		}
	}
}

func TestClaudeCodeNeverSeesTheAPIKeyUnlessAskedTo(t *testing.T) {
	env := Environment([]string{"PATH=/bin", "ANTHROPIC_API_KEY=sk", "NODE_OPTIONS=--inspect", "CLAUDE_CODE_ENTRYPOINT=cli"})
	joined := strings.Join(env, "\n")
	if strings.Contains(joined, "ANTHROPIC_API_KEY") || strings.Contains(joined, "NODE_OPTIONS") || strings.Contains(joined, "ENTRYPOINT=cli") || !strings.Contains(joined, "PATH=/bin") {
		t.Fatalf("env = %v", env)
	}
	if kept := Environment([]string{"ANTHROPIC_API_KEY=sk", "ARCHYMEDES_CLAUDE_BILLING=API"}); !slices.Contains(kept, "ANTHROPIC_API_KEY=sk") {
		t.Fatalf("billing=api keeps the key: %v", kept)
	}
}

func TestFindPrefersTheOverrideAndOtherwiseThePath(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "claude")
	if err := os.WriteFile(exe, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"PATH": dir}
	if got := Find(func(k string) string { return env[k] }); got != exe {
		t.Fatalf("Find = %q", got)
	}
	env["ARCHYMEDES_CLAUDE_PATH"] = filepath.Join(dir, "missing")
	if got := Find(func(k string) string { return env[k] }); got != "" {
		t.Fatalf("a missing override is not installed, got %q", got)
	}
}

func TestPrefacesTellClaudeWhatWasSaidAndOnlyWhatItMissed(t *testing.T) {
	messages := []fantasy.Message{
		fantasy.NewUserMessage("first question"),
		{Role: fantasy.MessageRoleAssistant, Content: []fantasy.MessagePart{fantasy.TextPart{Text: "first answer"}, fantasy.ToolCallPart{ToolCallID: "c", ToolName: "read_file"}}},
		{Role: fantasy.MessageRoleTool, Content: []fantasy.MessagePart{fantasy.ToolResultPart{ToolCallID: "c"}}},
		fantasy.NewUserMessage("second question"),
	}
	whole := Preface(messages)
	if !strings.Contains(whole, "began with another model") || !strings.Contains(whole, "User: first question\n\nAssistant: first answer\n\nUser: second question") {
		t.Fatalf("preface = %s", whole)
	}
	since := Since(messages, 3)
	if !strings.Contains(since, "While you were away") || strings.Contains(since, "first") || !strings.Contains(since, "second question") {
		t.Fatalf("since = %s", since)
	}
	if Since(messages, 4) != "" || Since(messages, 99) != "" || Preface(nil) != "" {
		t.Fatal("nothing missed, nothing said")
	}
	long := []fantasy.Message{fantasy.NewUserMessage(strings.Repeat("ü", MaxPrefaceChars))}
	if p := Preface(long); len(p) > MaxPrefaceChars+300 || !strings.Contains(p, "…\n") || strings.ContainsRune(p, '\uFFFD') {
		t.Fatalf("a long conversation keeps its newest part, cut cleanly (%d chars)", len(p))
	}
}

// fake starts a session on the fake Claude Code, recording notices and approvals.
type fake struct {
	t        *testing.T
	log      string
	mu       sync.Mutex
	notices  []agents.Notice
	asked    []policy.Request
	decision policy.Decision
}

func newFake(t *testing.T) *fake {
	t.Setenv(claudetest.Env, "1")
	f := &fake{t: t, log: filepath.Join(t.TempDir(), "claude.log"), decision: policy.Allow}
	t.Setenv("FAKE_CLAUDE_LOG", f.log)
	return f
}

func (f *fake) options(mode policy.Mode) Options {
	exe, err := os.Executable()
	if err != nil {
		f.t.Fatal(err)
	}
	return Options{
		Root: f.t.TempDir(), Executable: exe, Environ: Environment(os.Environ()), Mode: mode,
		Notify: func(n agents.Notice) { f.mu.Lock(); f.notices = append(f.notices, n); f.mu.Unlock() },
		Approve: func(_ context.Context, r policy.Request) (policy.Decision, error) {
			f.mu.Lock()
			defer f.mu.Unlock()
			f.asked = append(f.asked, r)
			return f.decision, nil
		},
	}
}

func (f *fake) logged() string {
	data, _ := os.ReadFile(f.log)
	return string(data)
}

func (f *fake) events() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return types(f.notices)
}

func TestATurnOnClaudeCodeStreamsAsksAndRemembers(t *testing.T) {
	f := newFake(t)
	opts := f.options(policy.Build)
	opts.Preface = "<earlier_conversation>User: hi</earlier_conversation>"
	opts.Model = "opus"
	s, err := Open(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	if !slices.Equal(Models(), []string{"default", "opus", "haiku"}) {
		t.Fatalf("models learned from initialize: %v", Models())
	}

	turn := s.Turn(context.Background(), "please run it")
	if turn.Result.Status != loop.Completed || turn.Reply != "Done." {
		t.Fatalf("turn = %+v", turn)
	}
	if len(f.asked) != 1 || f.asked[0].Call.Name != "run_command" || f.asked[0].Call.ID != "t1" || !f.asked[0].Safety.Sensitive || f.asked[0].Summary != "run rm -rf build" {
		t.Fatalf("asked = %+v", f.asked)
	}
	want := []string{"runtime:tool_call", "runtime:model_turn", "runtime:tool_result", "runtime:assistant_delta", "runtime:model_turn", "runtime:runtime_stop"}
	if got := f.events(); !slices.Equal(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	log := f.logged()
	for _, w := range []string{"--model opus", "--permission-mode default", "--permission-prompt-tool stdio", "prompt <earlier_conversation>User: hi</earlier_conversation>\\n\\nplease run it", `answer {"behavior":"allow"`} {
		if !strings.Contains(log, w) {
			t.Errorf("log lacks %q:\n%s", w, log)
		}
	}
	if s.ClaudeSession() != "claude-1" {
		t.Fatalf("Claude's session id = %q", s.ClaudeSession())
	}

	// Told once: the second prompt goes as it is.
	f.decision = policy.DenyAlways
	if turn := s.Turn(context.Background(), "run again"); turn.Result.Status != loop.Completed {
		t.Fatalf("turn = %+v", turn)
	}
	if !strings.Contains(f.logged(), "prompt run again\n") || !strings.Contains(f.logged(), `"behavior":"deny"`) {
		t.Fatalf("log:\n%s", f.logged())
	}
	// Refused from now on: not asked again.
	asked := len(f.asked)
	s.Turn(context.Background(), "run a third time")
	if len(f.asked) != asked || !strings.Contains(f.logged(), "was refused for the rest of this session") {
		t.Fatalf("asked %d times; log:\n%s", len(f.asked), f.logged())
	}

	if err := s.SetMode(context.Background(), policy.Auto); err != nil {
		t.Fatal(err)
	}
	if err := s.SetModel(context.Background(), "default"); err != nil || s.Model() != "default" {
		t.Fatalf("model = %q, err %v", s.Model(), err)
	}
	if !strings.Contains(f.logged(), `"mode":"acceptEdits"`) || !strings.Contains(f.logged(), `"model":null`) {
		t.Fatalf("log:\n%s", f.logged())
	}
	if got := s.Command("undo", ""); !strings.Contains(got["text"].(string), "Put back the file Claude changed") {
		t.Fatalf("undo = %v", got)
	}
	if got := s.Command("cost", ""); !strings.Contains(got["text"].(string), "Billed to your Claude plan") || !strings.Contains(got["text"].(string), "$0.75") {
		t.Fatalf("cost = %v", got)
	}
	if got := s.Command("compact", ""); got["kind"] != "error" {
		t.Fatalf("compact = %v", got)
	}
}

func TestStoppingATurnInterruptsClaudeCode(t *testing.T) {
	f := newFake(t)
	s, err := Open(context.Background(), f.options(policy.Build))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		for !strings.Contains(strings.Join(f.events(), " "), "tool_call") {
			time.Sleep(10 * time.Millisecond)
		}
		if !s.Steer("also check the docs") {
			t.Error("steering is taken while a tool runs")
		}
		cancel()
	}()
	turn := s.Turn(ctx, "wait for it")
	if turn.Result.Status != loop.Cancelled || !slices.Equal(turn.Steers, []string{"also check the docs"}) {
		t.Fatalf("turn = %+v", turn)
	}
	if !strings.Contains(f.logged(), "control interrupt") || !strings.Contains(f.logged(), "prompt also check the docs") {
		t.Fatalf("log:\n%s", f.logged())
	}
	if s.Steer("too late") {
		t.Fatal("no turn, no steering")
	}
}

func TestAConversationClaudeLostIsToldAgain(t *testing.T) {
	f := newFake(t)
	opts := f.options(policy.Build)
	opts.Resume = "gone"
	opts.Transcript = func() string { return "<earlier_conversation>everything</earlier_conversation>" }
	s, err := Open(context.Background(), opts)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	s.Turn(context.Background(), "hello")
	if !strings.Contains(f.logged(), "prompt <earlier_conversation>everything</earlier_conversation>\\n\\nhello") {
		t.Fatalf("log:\n%s", f.logged())
	}
}

func TestSignedOutSaysHowToSignIn(t *testing.T) {
	f := newFake(t)
	t.Setenv("FAKE_CLAUDE_SIGNED_OUT", "1")
	if _, err := Open(context.Background(), f.options(policy.Build)); err == nil || !strings.Contains(err.Error(), "claude auth login") {
		t.Fatalf("err = %v", err)
	}
	opts := f.options(policy.Build)
	opts.Executable = ""
	if _, err := Open(context.Background(), opts); err == nil || !strings.Contains(err.Error(), InstallURL) {
		t.Fatalf("err = %v", err)
	}
}
