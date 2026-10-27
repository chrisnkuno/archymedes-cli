package llm

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"charm.land/fantasy"
)

const toolStream = `event: message_start
data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_read_input_tokens":100,"cache_creation_input_tokens":0,"output_tokens":1}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Reading "}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"it."}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: ping
data: {"type":"ping"}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"path\":"}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\"a.go\"}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":30}}

event: message_stop
data: {"type":"message_stop"}

`

func serve(t *testing.T, status int, body string, seen *map[string]any) *anthropicModel {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-api-key") != "key" || r.Header.Get("anthropic-version") != anthropicVersion || r.URL.Path != "/v1/messages" {
			w.WriteHeader(400)
			return
		}
		if seen != nil {
			data, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(data, seen)
		}
		w.Header().Set("retry-after", "2")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, body)
	}))
	t.Cleanup(srv.Close)
	return newAnthropic("key", srv.URL, "claude-test")
}

func collect(t *testing.T, stream fantasy.StreamResponse) []fantasy.StreamPart {
	t.Helper()
	var parts []fantasy.StreamPart
	for p := range stream {
		parts = append(parts, p)
	}
	return parts
}

func TestAnthropicStreamYieldsTextToolCallAndUsage(t *testing.T) {
	m := serve(t, 200, toolStream, nil)
	stream, err := m.Stream(context.Background(), fantasy.Call{Prompt: fantasy.Prompt{fantasy.NewUserMessage("hi")}})
	if err != nil {
		t.Fatal(err)
	}
	var text string
	var call, finish fantasy.StreamPart
	for _, p := range collect(t, stream) {
		switch p.Type {
		case fantasy.StreamPartTypeTextDelta:
			text += p.Delta
		case fantasy.StreamPartTypeToolCall:
			call = p
		case fantasy.StreamPartTypeFinish:
			finish = p
		case fantasy.StreamPartTypeError:
			t.Fatal(p.Error)
		}
	}
	if text != "Reading it." || call.ID != "toolu_1" || call.ToolCallName != "read_file" || call.ToolCallInput != `{"path":"a.go"}` {
		t.Fatalf("text %q, call %+v", text, call)
	}
	// Fantasy's convention, as its own providers report it: cache reads apart from InputTokens.
	if finish.FinishReason != fantasy.FinishReasonToolCalls || finish.Usage.InputTokens != 12 || finish.Usage.CacheReadTokens != 100 || finish.Usage.OutputTokens != 30 {
		t.Fatalf("finish = %+v", finish)
	}
}

func TestAnthropicRequestShapeAlternatesRolesAndPlacesCacheBreakpoints(t *testing.T) {
	var seen map[string]any
	m := serve(t, 200, toolStream, &seen)
	max := int64(1000)
	prompt := fantasy.Prompt{
		fantasy.NewSystemMessage("be good"),
		fantasy.NewUserMessage("read a.go"),
		{Role: fantasy.MessageRoleAssistant, Content: []fantasy.MessagePart{fantasy.TextPart{Text: ""}, fantasy.ToolCallPart{ToolCallID: "t1", ToolName: "read_file", Input: `{"path":"a.go"}`}}},
		{Role: fantasy.MessageRoleTool, Content: []fantasy.MessagePart{fantasy.ToolResultPart{ToolCallID: "t1", Output: fantasy.ToolResultOutputContentError{Error: errors.New("missing")}}}},
		fantasy.NewUserMessage("also b.go"),
	}
	stream, err := m.Stream(context.Background(), fantasy.Call{Prompt: prompt, MaxOutputTokens: &max, Tools: []fantasy.Tool{fantasy.FunctionTool{Name: "read_file", InputSchema: map[string]any{"type": "object"}}}})
	if err != nil {
		t.Fatal(err)
	}
	collect(t, stream)
	messages := seen["messages"].([]any)
	if len(messages) != 3 {
		t.Fatalf("roles must alternate; got %d messages: %v", len(messages), messages)
	}
	last := messages[2].(map[string]any)
	blocks := last["content"].([]any)
	if last["role"] != "user" || blocks[0].(map[string]any)["type"] != "tool_result" || blocks[0].(map[string]any)["is_error"] != true || blocks[1].(map[string]any)["text"] != "also b.go" {
		t.Fatalf("tool result and the next words should share the user turn: %v", last)
	}
	assistant := messages[1].(map[string]any)["content"].([]any)
	if len(assistant) != 1 || assistant[0].(map[string]any)["cache_control"] == nil {
		t.Fatalf("the empty text block must be dropped and the second-to-last message cached: %v", assistant)
	}
	system := seen["system"].([]any)[0].(map[string]any)
	tools := seen["tools"].([]any)
	if system["text"] != "be good" || system["cache_control"] == nil || tools[0].(map[string]any)["cache_control"] == nil || seen["max_tokens"] != 1000.0 || seen["stream"] != true {
		t.Fatalf("request = %v", seen)
	}
}

func TestAnthropicErrorsAreProviderErrorsTheLoopCanJudge(t *testing.T) {
	m := serve(t, 429, `{"type":"error","error":{"type":"rate_limit_error","message":"slow down"}}`, nil)
	_, err := m.Stream(context.Background(), fantasy.Call{Prompt: fantasy.Prompt{fantasy.NewUserMessage("hi")}})
	var pe *fantasy.ProviderError
	if !errors.As(err, &pe) || pe.StatusCode != 429 || !pe.IsRetryable() || pe.Message != "slow down" || pe.ResponseHeaders["retry-after"] != "2" {
		t.Fatalf("err = %#v", err)
	}
	m = serve(t, 400, `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 250000 tokens > 200000 maximum"}}`, nil)
	_, err = m.Stream(context.Background(), fantasy.Call{Prompt: fantasy.Prompt{fantasy.NewUserMessage("hi")}})
	if !errors.As(err, &pe) || !pe.ContextTooLargeErr || pe.IsRetryable() {
		t.Fatalf("err = %#v", err)
	}
}

func TestAnthropicStreamThatEndsEarlyIsAnError(t *testing.T) {
	cut := toolStream[:strings.Index(toolStream, "event: message_delta")]
	m := serve(t, 200, cut, nil)
	stream, _ := m.Stream(context.Background(), fantasy.Call{Prompt: fantasy.Prompt{fantasy.NewUserMessage("hi")}})
	parts := collect(t, stream)
	if last := parts[len(parts)-1]; last.Type != fantasy.StreamPartTypeError {
		t.Fatalf("last part = %+v", last)
	}
	m = serve(t, 200, "event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}}\n\n", nil)
	stream, _ = m.Stream(context.Background(), fantasy.Call{Prompt: fantasy.Prompt{fantasy.NewUserMessage("hi")}})
	parts = collect(t, stream)
	var pe *fantasy.ProviderError
	if !errors.As(parts[0].Error, &pe) || !pe.IsRetryable() {
		t.Fatalf("an overloaded stream should be retryable: %+v", parts)
	}
}

func TestPingsAndCommentsAreLife(t *testing.T) {
	body := "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1}}}\n\n: keepalive\n\nevent: ping\ndata: {\"type\":\"ping\"}\n\nevent: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\nevent: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
	m := serve(t, 200, body, nil)
	stream, _ := m.Stream(context.Background(), fantasy.Call{Prompt: fantasy.Prompt{fantasy.NewUserMessage("hi")}})
	alive := 0
	for _, p := range collect(t, stream) {
		if p.Type == fantasy.StreamPartTypeKeepalive {
			alive++
		}
	}
	if alive != 4 { // message_start, the comment, the ping, message_delta
		t.Fatalf("keepalives = %d", alive)
	}
}
