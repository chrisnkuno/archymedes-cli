package acp

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// The test binary doubles as a fake agent: started with ACP_FAKE_AGENT set, it speaks the protocol
// the way core/cli/acp.ts does, which keeps these tests about the real process and pipe handling.
func TestMain(m *testing.M) {
	if os.Getenv("ACP_FAKE_AGENT") != "" {
		fakeAgent()
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func fakeAgent() {
	in := bufio.NewScanner(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	send := func(v any) { b, _ := json.Marshal(v); out.Write(append(b, '\n')); out.Flush() }
	fmt.Fprintln(os.Stderr, "fake agent ready")
	for in.Scan() {
		var f map[string]any
		if json.Unmarshal(in.Bytes(), &f) != nil {
			continue
		}
		id, method := f["id"], f["method"]
		params, _ := f["params"].(map[string]any)
		switch method {
		case "initialize":
			archymedes := params["clientCapabilities"].(map[string]any)["_meta"].(map[string]any)["archymedes"].(map[string]any)
			if archymedes["events"] != true || archymedes["questions"] != true {
				send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32602, "message": "extension not requested"}})
				continue
			}
			send(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"protocolVersion": 1}})
		case "session/new":
			send(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"sessionId": "s1", "_meta": map[string]any{"archymedes": map[string]any{"model": "m1", "provider": "free", "mode": "build"}}}})
		case "session/prompt":
			text := params["prompt"].([]any)[0].(map[string]any)["text"].(string)
			if text == "ask" {
				send(map[string]any{"jsonrpc": "2.0", "id": "archymedes-9", "method": AskMethod, "params": map[string]any{"sessionId": "s1", "toolCallId": "c9", "question": "Which database?", "options": []any{"Postgres", "SQLite"}, "multiSelect": false}})
				var answer map[string]any
				for in.Scan() {
					json.Unmarshal(in.Bytes(), &answer)
					if answer["id"] == "archymedes-9" {
						break
					}
				}
				reply, _ := json.Marshal(answer["result"])
				send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": string(reply)}}}})
				send(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"stopReason": "end_turn"}})
				continue
			}
			if text == "crash" {
				fmt.Fprintln(os.Stderr, "boom: provider exploded")
				os.Exit(3)
			}
			send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "s1", "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "hel"}}}})
			send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"sessionId": "s1", "update": map[string]any{"sessionUpdate": "tool_call", "toolCallId": "c1"}}})
			send(map[string]any{"jsonrpc": "2.0", "method": EventMethod, "params": map[string]any{"sessionId": "s1", "event": map[string]any{"type": "runtime", "event": map[string]any{"type": "tool_call", "toolCallId": "c1", "toolName": "run_command", "arguments": map[string]any{"command": "ls"}}}}})
			// Ask permission and wait for the answer before finishing the turn, as the agent does.
			send(map[string]any{"jsonrpc": "2.0", "id": "archymedes-1", "method": "session/request_permission", "params": map[string]any{"sessionId": "s1", "toolCall": map[string]any{"toolCallId": "c1", "title": "run command: ls"}, "options": []any{map[string]any{"optionId": "allow", "name": "Allow", "kind": "allow_once"}}}})
			var answer map[string]any
			for in.Scan() {
				json.Unmarshal(in.Bytes(), &answer)
				if answer["id"] == "archymedes-1" {
					break
				}
			}
			outcome := answer["result"].(map[string]any)
			send(map[string]any{"jsonrpc": "2.0", "method": "session/update", "params": map[string]any{"update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": fmt.Sprint(outcome["selectedOptionId"])}}}})
			send(map[string]any{"jsonrpc": "2.0", "id": id, "result": map[string]any{"stopReason": "end_turn"}})
		default:
			if id != nil {
				send(map[string]any{"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": -32601, "message": "Method not found: " + fmt.Sprint(method)}})
			}
		}
	}
}

func startFake(t *testing.T) *Client {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	c, err := Start(ctx, []string{os.Args[0]}, t.TempDir(), append(os.Environ(), "ACP_FAKE_AGENT=1"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(c.Close)
	return c
}

func TestPromptStreamsTextEventsAndRoundTripsApproval(t *testing.T) {
	c := startFake(t)
	ctx := context.Background()
	session, err := c.NewSession(ctx, "/tmp", "")
	if err != nil {
		t.Fatal(err)
	}
	if session.ID != "s1" || session.Info.Model != "m1" {
		t.Fatalf("session = %+v", session)
	}
	stop := make(chan string, 1)
	go func() { reason, _ := c.Prompt(ctx, session.ID, "hi"); stop <- reason }()

	var text strings.Builder
	var sawToolEvent bool
	for {
		select {
		case msg := <-c.Messages():
			switch m := msg.(type) {
			case TurnEnded:
				// In-stream, so everything the turn said has already been read by now.
				if m.StopReason != "end_turn" || text.String() != "helallow" || !sawToolEvent || <-stop != "end_turn" {
					t.Fatalf("reason=%q text=%q tool=%v", m.StopReason, text.String(), sawToolEvent)
				}
				return
			case TextChunk:
				text.WriteString(m.Text)
			case AgentEvent:
				sawToolEvent = m.Event.Event != nil && m.Event.Event.ToolName == "run_command" && m.Event.Event.Arguments["command"] == "ls"
			case PermissionRequest:
				if m.ToolCall.Title != "run command: ls" || len(m.Options) != 1 {
					t.Fatalf("request = %+v", m)
				}
				m.Answer("allow")
				m.Answer("deny") // a second answer must not reach the agent
			case Exited:
				t.Fatalf("agent exited: %v %s", m.Err, m.Stderr)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("timed out")
		}
	}
}

func TestQuestionRoundTripsItsAnswer(t *testing.T) {
	c := startFake(t)
	ctx := context.Background()
	session, err := c.NewSession(ctx, "/tmp", "")
	if err != nil {
		t.Fatal(err)
	}
	go func() { _, _ = c.Prompt(ctx, session.ID, "ask") }()
	var text strings.Builder
	for {
		select {
		case msg := <-c.Messages():
			switch m := msg.(type) {
			case QuestionRequest:
				if m.Question != "Which database?" || len(m.Options) != 2 || m.ToolCallID != "c9" {
					t.Fatalf("question = %+v", m)
				}
				m.Answer("Postgres")
				m.Answer("SQLite") // a second answer must not reach the agent
			case TextChunk:
				text.WriteString(m.Text)
			case TurnEnded:
				if text.String() != `{"answer":"Postgres"}` {
					t.Fatalf("agent read %q", text.String())
				}
				return
			case Exited:
				t.Fatalf("agent exited: %v %s", m.Err, m.Stderr)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("timed out")
		}
	}
}

func TestUnknownMethodIsAnErrorNotAHang(t *testing.T) {
	c := startFake(t)
	err := c.call(context.Background(), "no/such", map[string]any{}, nil)
	if err == nil || !strings.Contains(err.Error(), "Method not found") {
		t.Fatalf("err = %v", err)
	}
}

func TestAgentCrashFailsThePendingCallWithItsStderr(t *testing.T) {
	c := startFake(t)
	ctx := context.Background()
	session, _ := c.NewSession(ctx, "/tmp", "")
	_, err := c.Prompt(ctx, session.ID, "crash")
	if err == nil || !strings.Contains(err.Error(), "provider exploded") {
		t.Fatalf("err = %v", err)
	}
	var exited *Exited
	for msg := range c.Messages() {
		if e, ok := msg.(Exited); ok {
			exited = &e
		}
	}
	if exited == nil || exited.Err == nil {
		t.Fatalf("exited = %+v", exited)
	}
}

func TestStartFailsClearlyForAMissingBinary(t *testing.T) {
	_, err := Start(context.Background(), []string{"/nonexistent/archymedes"}, t.TempDir(), nil)
	if err == nil || !strings.Contains(err.Error(), "starting agent") {
		t.Fatalf("err = %v", err)
	}
}
