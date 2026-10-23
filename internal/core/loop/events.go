// Package loop is one run of the Go engine: stream the model, run the tools it calls, fold in what
// the person (or a finished sub-agent) sent meanwhile, and stop when the work is done, stuck, out of
// budget, or cancelled.
//
// It owns no session, no thread and no protocol. What it needs from outside comes in a Request
// (the model, the tools, the approver, the gate, the inbox) and what happens goes out as Events,
// so the coordinator can run a session's root thread and its sub-agents on the same code.
package loop

import "github.com/chrisnkuno/friday-cli/internal/core/gate"

// Usage is one model call's tokens, in the field names the interface already reads (acp.Usage).
type Usage struct {
	InputTokens       int `json:"inputTokens"`
	OutputTokens      int `json:"outputTokens"`
	CachedInputTokens int `json:"cachedInputTokens"`
	ReasoningTokens   int `json:"reasoningTokens"`
}

// Add folds another call's usage into this one.
func (u *Usage) Add(o Usage) {
	u.InputTokens += o.InputTokens
	u.OutputTokens += o.OutputTokens
	u.CachedInputTokens += o.CachedInputTokens
	u.ReasoningTokens += o.ReasoningTokens
}

// Event is one thing that happened in a run. Its JSON is the TypeScript runtime's AgentRuntimeEvent
// (the `event` inside `_archymedes/event`), so the interface reads both engines the same way;
// Type says which fields are set.
type Event struct {
	Type      string `json:"type"`
	Iteration int    `json:"iteration,omitempty"`
	// assistant_delta
	Text string `json:"text,omitempty"`
	// tool_call, tool_result
	ToolCallID string         `json:"toolCallId,omitempty"`
	ToolName   string         `json:"toolName,omitempty"`
	Effect     string         `json:"effect,omitempty"`
	Arguments  map[string]any `json:"arguments,omitempty"`
	IsError    bool           `json:"isError,omitempty"`
	Content    string         `json:"content,omitempty"`
	Data       map[string]any `json:"data,omitempty"`
	// model_turn
	Model         string `json:"model,omitempty"`
	ToolCallCount int    `json:"toolCallCount,omitempty"`
	Usage         *Usage `json:"usage,omitempty"`
	// tool_compose: a call still being written
	Index   int    `json:"index,omitempty"`
	Subject string `json:"subject,omitempty"`
	Chars   int    `json:"chars,omitempty"`
	// provider_retry
	NextAttempt int    `json:"nextAttempt,omitempty"`
	MaxAttempts int    `json:"maxAttempts,omitempty"`
	DelayMs     int    `json:"delayMs,omitempty"`
	Reason      string `json:"reason,omitempty"`
	// steered: messages folded into this step
	Count int `json:"count,omitempty"`
	// context_shrunk
	Step int `json:"step,omitempty"`
	// test_first
	State *gate.State `json:"state,omitempty"`
	// runtime_stop
	Status  string `json:"status,omitempty"`
	Summary string `json:"summary,omitempty"`
	// compaction (sent as its own extension event, not inside `runtime`)
	TokensBefore   int `json:"tokensBefore,omitempty"`
	MessagesBefore int `json:"messagesBefore,omitempty"`
	MessagesAfter  int `json:"messagesAfter,omitempty"`
}

// Event types.
const (
	EventDelta      = "assistant_delta"
	EventModelTurn  = "model_turn"
	EventToolCall   = "tool_call"
	EventToolResult = "tool_result"
	EventCompose    = "tool_compose"
	EventRetry      = "provider_retry"
	EventSteered    = "steered"
	EventTestFirst  = "test_first"
	EventStop       = "runtime_stop"
	EventCompaction = "compaction"
)

// Status is how a run ended.
type Status string

const (
	Completed Status = "completed"
	Cancelled Status = "cancelled"
	Failed    Status = "failed"
	// Stuck: the model repeated one call with nothing changing in between, past the warning.
	Stuck Status = "stuck"
	// BudgetExhausted: out of steps or tool calls.
	BudgetExhausted Status = "budget_exhausted"
)
