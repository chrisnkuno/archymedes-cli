package llm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"charm.land/fantasy"
)

// anthropicModel streams Anthropic's Messages API over plain HTTP.
//
// Fantasy's own Anthropic provider also speaks Bedrock and Vertex, and links their SDKs (AWS and
// Google Cloud, about 190 packages and 24 MB of binary) into every build. Friday reaches Anthropic
// by API key only, so this is the part of it Friday uses: one streaming call, tool use, and the
// two cache breakpoints the TypeScript adapter places (anthropic-agent.ts withCacheBreakpoints).
type anthropicModel struct {
	key, base, model string
	client           *http.Client
}

const (
	anthropicBase    = "https://api.anthropic.com"
	anthropicVersion = "2023-06-01"
	defaultMaxTokens = 16_384
)

func newAnthropic(key, base, model string) *anthropicModel {
	if base == "" {
		base = anthropicBase
	}
	return &anthropicModel{key: key, base: strings.TrimRight(base, "/"), model: model, client: &http.Client{Timeout: 0}}
}

func (m *anthropicModel) Model() string    { return m.model }
func (m *anthropicModel) Provider() string { return "anthropic" }

func (m *anthropicModel) Generate(context.Context, fantasy.Call) (*fantasy.Response, error) {
	return nil, errors.New("the Go engine only streams Anthropic calls")
}

func (m *anthropicModel) GenerateObject(context.Context, fantasy.ObjectCall) (*fantasy.ObjectResponse, error) {
	return nil, errors.New("structured output is not used by the Go engine")
}

func (m *anthropicModel) StreamObject(context.Context, fantasy.ObjectCall) (fantasy.ObjectStreamResponse, error) {
	return nil, errors.New("structured output is not used by the Go engine")
}

var ephemeral = map[string]any{"type": "ephemeral"}

// anthropicRequest is a Fantasy call as a Messages API body.
func anthropicRequest(call fantasy.Call, model string) map[string]any {
	var system []string
	var messages []map[string]any
	add := func(role string, blocks []map[string]any) {
		if len(blocks) == 0 {
			return
		}
		// The API wants roles to alternate: tool results and the person's next words share a turn.
		if n := len(messages); n > 0 && messages[n-1]["role"] == role {
			messages[n-1]["content"] = append(messages[n-1]["content"].([]map[string]any), blocks...)
			return
		}
		messages = append(messages, map[string]any{"role": role, "content": blocks})
	}
	for _, msg := range call.Prompt {
		var blocks []map[string]any
		for _, part := range msg.Content {
			switch p := part.(type) {
			case fantasy.TextPart:
				if strings.TrimSpace(p.Text) == "" {
					continue // an empty text block is rejected
				}
				if msg.Role == fantasy.MessageRoleSystem {
					system = append(system, p.Text)
					continue
				}
				blocks = append(blocks, map[string]any{"type": "text", "text": p.Text})
			case fantasy.ToolCallPart:
				input := json.RawMessage(p.Input)
				if !json.Valid(input) || len(bytes.TrimSpace(input)) == 0 {
					input = json.RawMessage(`{}`)
				}
				blocks = append(blocks, map[string]any{"type": "tool_use", "id": p.ToolCallID, "name": p.ToolName, "input": input})
			case fantasy.ToolResultPart:
				block := map[string]any{"type": "tool_result", "tool_use_id": p.ToolCallID}
				switch out := p.Output.(type) {
				case fantasy.ToolResultOutputContentText:
					block["content"] = nonEmpty(out.Text)
				case fantasy.ToolResultOutputContentError:
					block["content"], block["is_error"] = nonEmpty(out.Error.Error()), true
				default:
					block["content"] = "(no output)"
				}
				blocks = append(blocks, block)
			}
		}
		switch msg.Role {
		case fantasy.MessageRoleAssistant:
			add("assistant", blocks)
		case fantasy.MessageRoleUser, fantasy.MessageRoleTool:
			add("user", blocks)
		}
	}
	// The rolling breakpoint: the second-to-last message, so the newest content stays outside the
	// cached prefix. With fewer than three messages the fixed header carries the cache alone.
	if len(messages) >= 3 {
		blocks := messages[len(messages)-2]["content"].([]map[string]any)
		blocks[len(blocks)-1]["cache_control"] = ephemeral
	}
	body := map[string]any{"model": model, "messages": messages, "stream": true, "max_tokens": defaultMaxTokens}
	if call.MaxOutputTokens != nil && *call.MaxOutputTokens > 0 {
		body["max_tokens"] = *call.MaxOutputTokens
	}
	if call.Temperature != nil {
		body["temperature"] = *call.Temperature
	}
	if len(system) > 0 {
		body["system"] = []map[string]any{{"type": "text", "text": strings.Join(system, "\n\n"), "cache_control": ephemeral}}
	}
	var tools []map[string]any
	for _, t := range call.Tools {
		if f, ok := t.(fantasy.FunctionTool); ok {
			tools = append(tools, map[string]any{"name": f.Name, "description": f.Description, "input_schema": f.InputSchema})
		}
	}
	if len(tools) > 0 {
		tools[len(tools)-1]["cache_control"] = ephemeral
		body["tools"] = tools
		if call.ToolChoice != nil {
			switch *call.ToolChoice {
			case fantasy.ToolChoiceRequired:
				body["tool_choice"] = map[string]any{"type": "any"}
			case fantasy.ToolChoiceNone:
				body["tool_choice"] = map[string]any{"type": "none"}
			case fantasy.ToolChoiceAuto:
			default:
				body["tool_choice"] = map[string]any{"type": "tool", "name": string(*call.ToolChoice)}
			}
		}
	}
	return body
}

func nonEmpty(text string) string {
	if strings.TrimSpace(text) == "" {
		return "(no output)"
	}
	return text
}

// Stream makes the call and yields Fantasy stream parts as the events arrive.
func (m *anthropicModel) Stream(ctx context.Context, call fantasy.Call) (fantasy.StreamResponse, error) {
	payload, err := json.Marshal(anthropicRequest(call, m.model))
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, m.base+"/v1/messages", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("x-api-key", m.key)
	req.Header.Set("anthropic-version", anthropicVersion)
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "text/event-stream")
	req.Header.Set("user-agent", UserAgent)
	resp, err := m.client.Do(req)
	if err != nil {
		return nil, &fantasy.ProviderError{Message: err.Error(), Cause: err, URL: req.URL.String(), TransientError: ctx.Err() == nil}
	}
	if resp.StatusCode != http.StatusOK {
		defer resp.Body.Close()
		return nil, anthropicError(resp)
	}
	return func(yield func(fantasy.StreamPart) bool) {
		defer resp.Body.Close()
		decodeAnthropicStream(resp.Body, yield)
	}, nil
}

func anthropicError(resp *http.Response) error {
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var parsed struct {
		Error struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &parsed)
	message := parsed.Error.Message
	if message == "" {
		message = strings.TrimSpace(string(body))
	}
	if message == "" {
		message = resp.Status
	}
	headers := map[string]string{}
	for k, v := range resp.Header {
		if len(v) > 0 {
			headers[strings.ToLower(k)] = v[0]
		}
	}
	return &fantasy.ProviderError{
		Title: "Anthropic", Message: message, StatusCode: resp.StatusCode, ResponseHeaders: headers, ResponseBody: body,
		ErrorType:          parsed.Error.Type,
		ContextTooLargeErr: strings.Contains(strings.ToLower(message), "prompt is too long"),
		TransientError:     parsed.Error.Type == "overloaded_error",
	}
}

// decodeAnthropicStream turns server-sent events into stream parts.
func decodeAnthropicStream(body io.Reader, yield func(fantasy.StreamPart) bool) {
	type block struct {
		kind, id, name string
		input          strings.Builder
	}
	blocks := map[int]*block{}
	var usage fantasy.Usage
	finish := fantasy.FinishReasonUnknown
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	event := ""
	// alive tells the loop the connection still lives (its idle watchdog resets on every part):
	// pings, SSE comments and events that carry nothing to show are life too.
	alive := func() bool { return yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeKeepalive}) }
	for scanner.Scan() {
		line := scanner.Text()
		if name, ok := strings.CutPrefix(line, "event:"); ok {
			event = strings.TrimSpace(name)
			continue
		}
		if strings.HasPrefix(line, ":") {
			if !alive() {
				return
			}
			continue
		}
		data, ok := strings.CutPrefix(line, "data:")
		if !ok {
			continue
		}
		var e struct {
			Type    string `json:"type"`
			Index   int    `json:"index"`
			Message struct {
				Usage anthropicUsage `json:"usage"`
			} `json:"message"`
			ContentBlock struct {
				Type string `json:"type"`
				ID   string `json:"id"`
				Name string `json:"name"`
				Text string `json:"text"`
			} `json:"content_block"`
			Delta struct {
				Type        string `json:"type"`
				Text        string `json:"text"`
				PartialJSON string `json:"partial_json"`
				Thinking    string `json:"thinking"`
				StopReason  string `json:"stop_reason"`
			} `json:"delta"`
			Usage anthropicUsage `json:"usage"`
			Error struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal([]byte(strings.TrimSpace(data)), &e) != nil {
			continue
		}
		if e.Type == "" {
			e.Type = event
		}
		switch e.Type {
		case "ping":
			if !alive() {
				return
			}
		case "message_start":
			// Fantasy's convention: cache reads apart (the loop adds them back), cache writes in.
			usage.InputTokens = e.Message.Usage.InputTokens + e.Message.Usage.CacheCreation
			usage.CacheReadTokens = e.Message.Usage.CacheRead
			usage.CacheCreationTokens = e.Message.Usage.CacheCreation
			usage.OutputTokens = e.Message.Usage.OutputTokens
			if !alive() {
				return
			}
		case "content_block_start":
			b := &block{kind: e.ContentBlock.Type, id: e.ContentBlock.ID, name: e.ContentBlock.Name}
			blocks[e.Index] = b
			if b.kind == "tool_use" && !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeToolInputStart, ID: b.id, ToolCallName: b.name}) {
				return
			}
			if b.kind == "text" && e.ContentBlock.Text != "" && !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeTextDelta, Delta: e.ContentBlock.Text}) {
				return
			}
			if b.kind != "tool_use" && e.ContentBlock.Text == "" && !alive() {
				return
			}
		case "content_block_delta":
			b := blocks[e.Index]
			switch e.Delta.Type {
			case "text_delta":
				if !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeTextDelta, Delta: e.Delta.Text}) {
					return
				}
			case "thinking_delta":
				if !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeReasoningDelta, Delta: e.Delta.Thinking}) {
					return
				}
			case "input_json_delta":
				if b != nil {
					b.input.WriteString(e.Delta.PartialJSON)
					if !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeToolInputDelta, ID: b.id, Delta: e.Delta.PartialJSON}) {
						return
					}
				}
			default: // signature_delta and whatever comes next: nothing to show, but alive
				if !alive() {
					return
				}
			}
		case "content_block_stop":
			if b := blocks[e.Index]; b == nil || b.kind != "tool_use" {
				if !alive() {
					return
				}
			}
			if b := blocks[e.Index]; b != nil && b.kind == "tool_use" {
				input := b.input.String()
				if strings.TrimSpace(input) == "" {
					input = "{}"
				}
				if !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeToolCall, ID: b.id, ToolCallName: b.name, ToolCallInput: input}) {
					return
				}
			}
		case "message_delta":
			if e.Usage.OutputTokens > 0 {
				usage.OutputTokens = e.Usage.OutputTokens
			}
			finish = anthropicFinish(e.Delta.StopReason)
			if !alive() {
				return
			}
		case "message_stop":
			usage.TotalTokens = usage.InputTokens + usage.OutputTokens
			yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeFinish, FinishReason: finish, Usage: usage})
			return
		case "error":
			yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeError, Error: &fantasy.ProviderError{
				Title: "Anthropic", Message: e.Error.Message, ErrorType: e.Error.Type,
				TransientError: e.Error.Type == "overloaded_error" || e.Error.Type == "api_error",
			}})
			return
		}
	}
	err := scanner.Err()
	if err == nil {
		err = io.ErrUnexpectedEOF // the stream ended without message_stop
	}
	yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeError, Error: &fantasy.ProviderError{Title: "Anthropic", Message: "the stream ended early: " + err.Error(), Cause: err}})
}

type anthropicUsage struct {
	InputTokens   int64 `json:"input_tokens"`
	OutputTokens  int64 `json:"output_tokens"`
	CacheCreation int64 `json:"cache_creation_input_tokens"`
	CacheRead     int64 `json:"cache_read_input_tokens"`
}

func anthropicFinish(reason string) fantasy.FinishReason {
	switch reason {
	case "end_turn", "stop_sequence":
		return fantasy.FinishReasonStop
	case "max_tokens":
		return fantasy.FinishReasonLength
	case "tool_use":
		return fantasy.FinishReasonToolCalls
	case "refusal":
		return fantasy.FinishReasonContentFilter
	}
	return fantasy.FinishReasonOther
}
