package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync/atomic"
	"testing"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

func TestDecisionReadsBothAnswerShapesAndNothingElseIsConsent(t *testing.T) {
	cases := []struct {
		raw     string
		pattern bool
		want    policy.Decision
	}{
		{`{"outcome":{"outcome":"selected","optionId":"allow"}}`, false, policy.Allow},          // Zed
		{`{"outcome":"selected","selectedOptionId":"allow_always"}`, false, policy.AllowAlways}, // the Go interface
		{`{"outcome":{"outcome":"selected","optionId":"deny_always"}}`, false, policy.DenyAlways},
		{`{"outcome":"selected","selectedOptionId":"allow_pattern"}`, true, policy.AllowPattern},
		{`{"outcome":"selected","selectedOptionId":"allow_pattern"}`, false, policy.Deny}, // not offered
		{`{"outcome":"cancelled"}`, false, policy.Deny},
		{`{"outcome":{"outcome":"cancelled"}}`, false, policy.Deny},
		{`{"outcome":"selected","selectedOptionId":"sudo"}`, false, policy.Deny},
		{`null`, false, policy.Deny},
		{`[]`, false, policy.Deny},
	}
	for _, c := range cases {
		if got := decisionFrom(json.RawMessage(c.raw), c.pattern); got != c.want {
			t.Errorf("decisionFrom(%s) = %s, want %s", c.raw, got, c.want)
		}
	}
}

func TestPermissionOptionsPutAPatternThird(t *testing.T) {
	options := permissionOptions(&policy.Pattern{Kind: "command-prefix", Prefix: "npm test", Label: `always allow commands starting with "npm test"`})
	if len(options) != 5 || options[2]["optionId"] != "allow_pattern" || options[2]["name"] != `Always allow commands starting with "npm test"` {
		t.Fatalf("options = %v", options)
	}
	if len(permissionOptions(nil)) != 4 {
		t.Fatal("no pattern, four options")
	}
}

func TestPromptTextJoinsTextAndEmbeddedContext(t *testing.T) {
	blocks := []json.RawMessage{
		json.RawMessage(`{"type":"text","text":"explain this"}`),
		json.RawMessage(`{"type":"resource","resource":{"uri":"file:///p/a.go","text":"package a"}}`),
		json.RawMessage(`{"type":"resource_link","uri":"file:///p/b.go"}`),
		json.RawMessage(`{"type":"image","data":"..."}`),
	}
	want := "explain this\n<context uri=\"file:///p/a.go\">\npackage a\n</context>\n@file:///p/b.go"
	if got := promptText(blocks); got != want {
		t.Fatalf("promptText = %q", got)
	}
}

func TestStopReasons(t *testing.T) {
	for status, want := range map[loop.Status]string{loop.Completed: "end_turn", loop.Cancelled: "cancelled", loop.BudgetExhausted: "max_turn_requests", loop.Failed: "end_turn", loop.Stuck: "end_turn"} {
		if got := stopReason(status); got != want {
			t.Errorf("stopReason(%s) = %s, want %s", status, got, want)
		}
	}
}

func TestEventsMapToWhatEditorsAndTheInterfaceRead(t *testing.T) {
	call := loop.Event{Type: loop.EventToolCall, ToolCallID: "c1", ToolName: "run_command", Arguments: map[string]any{"command": "go test ./..."}}
	update := standardUpdate(call)
	if update["sessionUpdate"] != "tool_call" || update["kind"] != "execute" || update["title"] != "run command: go test ./..." {
		t.Fatalf("update = %v", update)
	}
	failed := standardUpdate(loop.Event{Type: loop.EventToolResult, ToolCallID: "c1", IsError: true, Content: "exit 1"})
	if failed["status"] != "failed" {
		t.Fatalf("update = %v", failed)
	}
	if standardUpdate(loop.Event{Type: loop.EventModelTurn}) != nil {
		t.Fatal("a model turn has no standard update")
	}
	thread := extensionEvent(agents.Notice{Kind: "thread", Thread: &agents.ThreadInfo{ID: "t-1", Status: "done"}})
	data, _ := json.Marshal(thread)
	if string(data) != `{"thread":{"id":"t-1","agent":"","status":"done","background":false},"type":"thread"}` {
		t.Fatalf("thread event = %s", data)
	}
	compaction := extensionEvent(agents.Notice{Kind: "compaction", Event: &loop.Event{TokensBefore: 9, MessagesBefore: 8, MessagesAfter: 2}})
	if compaction["type"] != "compaction" || compaction["messagesAfter"] != 2 {
		t.Fatalf("compaction = %v", compaction)
	}
	if extensionEvent(agents.Notice{Kind: "unknown"}) != nil {
		t.Fatal("an unknown notice has no event")
	}
}

func TestIDKeyAcceptsEveryEchoOfOurIDs(t *testing.T) {
	for _, raw := range []string{`"friday-7"`, `"7"`, `7`} {
		if idKey(json.RawMessage(raw)) != "7" {
			t.Errorf("idKey(%s) = %s", raw, idKey(json.RawMessage(raw)))
		}
	}
}

func TestACancelRightBehindItsPromptCoversIt(t *testing.T) {
	root := t.TempDir()
	var calls atomic.Int64
	srvOut, clientIn := io.Pipe()
	clientOut, srvIn := io.Pipe()
	srv := New(srvIn, Options{Cwd: root, ConfigDir: t.TempDir(), Environ: []string{"GROQ_API_KEY=k", "ARCHYMEDES_TITLES=off"}, Provider: "groq",
		Open: func(_ context.Context, _ llm.Selection, _ llm.Env, id string) (fantasy.LanguageModel, error) {
			return countingModel{id: id, calls: &calls}, nil
		}})
	done := make(chan struct{})
	go func() { _ = srv.Serve(context.Background(), srvOut); close(done) }()
	replies := bufio.NewScanner(clientOut)
	read := func(id string) map[string]any {
		for replies.Scan() {
			var f map[string]any
			_ = json.Unmarshal(replies.Bytes(), &f)
			if fmt.Sprint(f["id"]) == id {
				return f
			}
		}
		t.Fatalf("no reply %s", id)
		return nil
	}
	send := func(line string) { _, _ = io.WriteString(clientIn, line+"\n") }
	send(`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}`)
	read("1")
	send(`{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"` + root + `"}}`)
	sessionID := read("2")["result"].(map[string]any)["sessionId"].(string)
	// Both lines in one write: the cancel is read before the prompt's goroutine could start.
	send(`{"jsonrpc":"2.0","id":3,"method":"session/prompt","params":{"sessionId":"` + sessionID + `","prompt":[{"type":"text","text":"hi"}]}}` + "\n" +
		`{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"` + sessionID + `"}}`)
	reply := read("3")
	if reply["result"].(map[string]any)["stopReason"] != "cancelled" || calls.Load() != 0 {
		t.Fatalf("reply = %v, model calls = %d", reply, calls.Load())
	}
	_ = clientIn.Close()
	<-done
}

type countingModel struct {
	id    string
	calls *atomic.Int64
}

func (m countingModel) Model() string    { return m.id }
func (m countingModel) Provider() string { return "groq" }
func (m countingModel) Generate(context.Context, fantasy.Call) (*fantasy.Response, error) {
	return nil, errors.New("unused")
}
func (m countingModel) GenerateObject(context.Context, fantasy.ObjectCall) (*fantasy.ObjectResponse, error) {
	return nil, errors.New("unused")
}
func (m countingModel) StreamObject(context.Context, fantasy.ObjectCall) (fantasy.ObjectStreamResponse, error) {
	return nil, errors.New("unused")
}
func (m countingModel) Stream(context.Context, fantasy.Call) (fantasy.StreamResponse, error) {
	m.calls.Add(1)
	return func(yield func(fantasy.StreamPart) bool) {
		yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeTextDelta, Delta: "answered"})
		yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeFinish, FinishReason: fantasy.FinishReasonStop})
	}, nil
}
