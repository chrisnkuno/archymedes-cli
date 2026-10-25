// Package acp is the Go side of `friday acp`: JSON-RPC 2.0 over stdio, one message per line.
//
// The terminal front end drives the agent through the same protocol an editor uses, plus the
// opt-in `_archymedes/event` extension that carries what ACP has no shape for (usage, retries,
// checkpoints, compactions, Jev). This package owns the wire and nothing about presentation.
package acp

import "encoding/json"

// ProtocolVersion is the ACP major version the TS agent speaks (`ACP_PROTOCOL_VERSION`).
const ProtocolVersion = 1

// EventMethod is the extension notification (`ARCHYMEDES_EVENT_METHOD` in core/cli/acp.ts).
const EventMethod = "_archymedes/event"

// AskMethod is the agent's question for the human; the client opts in with the questions capability.
const AskMethod = "_archymedes/session/ask"

// Modes are the agent's capability sets, in the order the agent lists them.
var Modes = []string{"plan", "build", "auto", "defender"}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return e.Message }

// frame is any one line on the wire; which fields are set says what it is.
type frame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

// SessionInfo is the `_meta.archymedes` the agent attaches to `session/new` under the extension.
type SessionInfo struct {
	SessionID     string `json:"sessionId"`
	Provider      string `json:"provider"`
	ProviderLabel string `json:"providerLabel"`
	Model         string `json:"model"`
	Mode          string `json:"mode"`
	Root          string `json:"root"`
	// Workspace is where the work runs: local, docker or e2b.
	Workspace      string `json:"workspace"`
	WorkspaceLabel string `json:"workspaceLabel"`
	// Notice is said once when the session opened is not quite the one asked for: a session open
	// in another terminal is resumed as a copy of it.
	Notice string `json:"notice"`
	// Engine is "go" for the Go engine, empty for the TypeScript one.
	Engine string `json:"engine"`
}

// Session is what `session/new` returned.
type Session struct {
	ID   string
	Info SessionInfo
}

// Usage mirrors the runtime's ModelUsage; fields the agent omits stay zero.
type Usage struct {
	InputTokens       int `json:"inputTokens"`
	OutputTokens      int `json:"outputTokens"`
	CachedInputTokens int `json:"cachedInputTokens"`
	ReasoningTokens   int `json:"reasoningTokens"`
}

// Allowance is what is left of a daily request budget.
type Allowance struct {
	RemainingRequests *int   `json:"remainingRequests"`
	RequestLimit      *int   `json:"requestLimit"`
	ResetsAt          string `json:"resetsAt"`
}

// RuntimeEvent is one AgentRuntimeEvent; only the fields its Type uses are set.
type RuntimeEvent struct {
	Type string `json:"type"`
	// tool_call / tool_result
	ToolCallID string         `json:"toolCallId"`
	ToolName   string         `json:"toolName"`
	Effect     string         `json:"effect"`
	Arguments  map[string]any `json:"arguments"`
	IsError    bool           `json:"isError"`
	Content    string         `json:"content"`
	// model_turn
	Model         string `json:"model"`
	Iteration     int    `json:"iteration"`
	ToolCallCount int    `json:"toolCallCount"`
	Usage         *Usage `json:"usage"`
	// Allowance is the free tier's daily budget as the provider last reported it.
	Allowance *Allowance `json:"allowance"`
	// Effort is how hard the model was asked to think for this call, and EffortReason why.
	Effort       string `json:"effort"`
	EffortReason string `json:"effortReason"`
	// context_shrunk: 1 stubbed old tool output, 2 set aside the earlier conversation
	Step int `json:"step"`
	// provider_retry
	NextAttempt int    `json:"nextAttempt"`
	MaxAttempts int    `json:"maxAttempts"`
	DelayMs     int    `json:"delayMs"`
	Reason      string `json:"reason"`
	// tool_compose: a call the model is still writing; Subject is its path or command once streamed
	Subject string `json:"subject"`
	Chars   int    `json:"chars"`
	// runtime_stop
	Status  string `json:"status"`
	Summary string `json:"summary"`
	// test_first: where a test-first run is
	State *TestFirstState `json:"state"`
}

// TestFirstState is how far a test-first run has come: tests written, seen failing (Red), code
// changed, tests passing since (Green), a static check passing since (Checked).
type TestFirstState struct {
	Tests   []string `json:"tests"`
	Code    []string `json:"code"`
	Red     bool     `json:"red"`
	Green   bool     `json:"green"`
	Checked bool     `json:"checked"`
}

// Event is one ArchymedesEvent from the extension channel.
type Event struct {
	Type  string        `json:"type"`
	Event *RuntimeEvent `json:"event"`
	// compaction
	TokensBefore   int    `json:"tokensBefore"`
	MessagesBefore int    `json:"messagesBefore"`
	MessagesAfter  int    `json:"messagesAfter"`
	Urgency        string `json:"urgency"`
	// jev-verdict / jev-review: kept raw; their shapes belong to Jev.
	Verdict     json.RawMessage `json:"verdict"`
	Outcome     string          `json:"outcome"`
	Probability float64         `json:"probability"`
	// checkpoint
	Checkpoint json.RawMessage `json:"checkpoint"`
	// steering_unread: messages a turn accepted but ended before reading
	Messages []string `json:"messages"`
	// rules_problems: command rules (and agent roles) left out, each with why
	Problems []string `json:"problems"`
	// subagent: Event is one of a sub-agent's own runtime events, under the delegation call
	// ParentToolCallID, run in role Agent
	ParentToolCallID string `json:"parentToolCallId"`
	Agent            string `json:"agent"`
	// thread: a sub-agent's thread changed status (Go engine): started, done, failed, cancelled
	Thread *ThreadInfo `json:"thread"`
	// suggestions: up to three next steps after a turn that changed code (Go engine)
	Steps []Suggestion `json:"steps"`
	// edit_notes: what is worth knowing about the edit made by tool call ToolCallID to Path
	ToolCallID string     `json:"toolCallId"`
	Path       string     `json:"path"`
	Notes      []EditNote `json:"notes"`
}

// Suggestion is one next step: the request (or /command) it would send, and why now. Score is
// Jev's probability that it is useful, 0 when nothing judged it; Source is rule or model.
type Suggestion struct {
	Text   string  `json:"text"`
	Why    string  `json:"why"`
	Score  float64 `json:"score"`
	Source string  `json:"source"`
}

// EditNote is one thing worth knowing about an edit: a fact code found, or Jev's judgment with
// its probability in Score.
type EditNote struct {
	Text  string  `json:"text"`
	Kind  string  `json:"kind"`
	Score float64 `json:"score"`
}

// ThreadInfo is a sub-agent thread as the Go engine reports it.
type ThreadInfo struct {
	ID               string `json:"id"`
	ParentToolCallID string `json:"parentToolCallId"`
	Agent            string `json:"agent"`
	Status           string `json:"status"`
	Background       bool   `json:"background"`
	Brief            string `json:"brief"`
	Report           string `json:"report"`
	Branch           string `json:"branch"`
}

// PermissionOption is one choice the agent offers for an approval.
type PermissionOption struct {
	OptionID string `json:"optionId"`
	Name     string `json:"name"`
	Kind     string `json:"kind"`
}

// ToolCallRef is the call an approval is about.
type ToolCallRef struct {
	ToolCallID string `json:"toolCallId"`
	Title      string `json:"title"`
	Kind       string `json:"kind"`
}

// --- Messages the client delivers to its owner, in arrival order. ---

// TextChunk is assistant text, streamed.
type TextChunk struct{ Text string }

// TurnEnded is a prompt's turn finishing, delivered after all of that turn's other messages.
type TurnEnded struct{ StopReason string }

// UserChunk is one of the person's messages, replayed when a session is loaded.
type UserChunk struct{ Text string }

// AgentEvent is one extension event.
type AgentEvent struct{ Event Event }

// PermissionRequest is the agent asking the human. Answer exactly once; an empty option id denies.
type PermissionRequest struct {
	ToolCall ToolCallRef
	Options  []PermissionOption
	answer   func(optionID string)
}

// Answer replies to the agent. Calling it more than once has no further effect.
func (r PermissionRequest) Answer(optionID string) {
	if r.answer != nil {
		r.answer(optionID)
	}
}

// QuestionRequest is the agent asking the human a question (ask_user, or an engine's own). Options
// are suggestions; any text is an answer. Answer exactly once; an empty answer dismisses it.
type QuestionRequest struct {
	ToolCallID  string
	Question    string
	Options     []string
	MultiSelect bool
	answer      func(text string)
}

// Answer replies to the agent. Calling it more than once has no further effect.
func (r QuestionRequest) Answer(text string) {
	if r.answer != nil {
		r.answer(text)
	}
}

// NewQuestionRequestForTest builds a question whose answer goes to answer, for front-end tests.
func NewQuestionRequestForTest(question string, options []string, multiSelect bool, answer func(string)) QuestionRequest {
	return QuestionRequest{Question: question, Options: options, MultiSelect: multiSelect, answer: answer}
}

// Exited is the agent process ending; Err is nil for a clean exit after Close.
type Exited struct {
	Err    error
	Stderr string
}

// NewPermissionRequestForTest builds a request whose answer goes to answer, for front-end tests.
func NewPermissionRequestForTest(call ToolCallRef, options []PermissionOption, answer func(string)) PermissionRequest {
	return PermissionRequest{ToolCall: call, Options: options, answer: answer}
}

// SetupProvider is one provider first-run setup can offer.
type SetupProvider struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	KeyVariable string `json:"keyVariable"` // empty: needs more than a key
	KeyURL      string `json:"keyUrl"`
	Configured  bool   `json:"configured"`
}

// SetupStatus is whether the agent can open a session as it is configured now.
type SetupStatus struct {
	Configured bool            `json:"configured"`
	Reason     string          `json:"reason"`
	Providers  []SetupProvider `json:"providers"`
}

// ProviderOverview is one provider as the Providers app shows it.
type ProviderOverview struct {
	ID          string   `json:"id"`
	Label       string   `json:"label"`
	Configured  bool     `json:"configured"`
	Missing     []string `json:"missing"`
	KeyVariable string   `json:"keyVariable"` // empty: needs more than a key
	KeyURL      string   `json:"keyUrl"`
	Model       string   `json:"model"`
	IsDefault   bool     `json:"isDefault"`
	// Fields is what it is set up with: key, base URL and anything else it requires.
	Fields []ProviderField `json:"fields"`
	// Login, when set, is the command that signs in to it (Claude: `claude auth login`, Claude
	// Code's own flow). The interface runs it in the terminal; nothing of the account passes here.
	Login []string `json:"login"`
	// Note is a line about how it is set up, such as which Claude plan it is signed in with.
	Note string `json:"note"`
	// About says what an outside engine (the person's Claude Code or Codex) is, for the connect dialog.
	About string `json:"about"`
}

// OutsideEngine is a provider that is the person's own installed agent, signed in on its own.
func (p ProviderOverview) OutsideEngine() bool { return p.ID == "claude" || p.ID == "codex" }

// ProviderField is one value a provider is set up with; a secret's value arrives masked.
type ProviderField struct {
	Key         string `json:"key"`
	Label       string `json:"label"`
	Kind        string `json:"kind"` // secret, url or text
	Required    bool   `json:"required"`
	IsSet       bool   `json:"isSet"`
	Value       string `json:"value"`
	Placeholder string `json:"placeholder"`
}

// ConnectResult is a provider checked, saved and listed in one step.
type ConnectResult struct {
	OK     bool     `json:"ok"`
	File   string   `json:"file"`
	Models []string `json:"models"`
	Note   string   `json:"note"`
	Error  string   `json:"error"`
	Field  string   `json:"field"` // the field the error is about, when there is one
}

// SettingRow is one line of the settings menu; secrets arrive masked.
type SettingRow struct {
	Key                     string          `json:"key"`
	Label                   string          `json:"label"`
	Section                 string          `json:"section"`
	Kind                    string          `json:"kind"` // choice, text or secret
	Choices                 []SettingChoice `json:"choices"`
	Value                   string          `json:"value"`
	IsSet                   bool            `json:"isSet"`
	OverriddenByEnvironment bool            `json:"overriddenByEnvironment"`
}

// SettingChoice is one value a picked setting may take.
type SettingChoice struct {
	Value string `json:"value"`
	Label string `json:"label"`
}

// SettingsList is the whole menu and the file it is saved in.
type SettingsList struct {
	File string       `json:"file"`
	Rows []SettingRow `json:"rows"`
}

// SettingsSetResult is the outcome of saving one setting.
type SettingsSetResult struct {
	OK    bool   `json:"ok"`
	File  string `json:"file"`
	Value string `json:"value"`
	IsSet bool   `json:"isSet"`
	Error string `json:"error"`
}

// SetupResult is the outcome of saving a key.
type SetupResult struct {
	OK    bool   `json:"ok"`
	File  string `json:"file"`
	Note  string `json:"note"`
	Error string `json:"error"`
}

// ModelChoice is one model the session can switch to.
type ModelChoice struct {
	Provider      string `json:"provider"`
	ProviderLabel string `json:"providerLabel"`
	Model         string `json:"model"`
	IsDefault     bool   `json:"isDefault"`
	Live          bool   `json:"live"`
	Price         string `json:"price"`
	// Free costs nothing to use; Locked is a provider without a key yet, and Missing says which.
	// Small is a chat-sized model (a few billion parameters): fine to talk to, poor at tool calls.
	Small   bool     `json:"small"`
	Free    bool     `json:"free"`
	Locked  bool     `json:"locked"`
	Missing []string `json:"missing"`
	// Fit is how a concrete free model measured as an agent: "agent", "busy", "slow", "apps-only", "small"
	// or "unmeasured" (empty for everything else); FitNote says why in a few words.
	Fit     string `json:"fit,omitempty"`
	FitNote string `json:"fitNote,omitempty"`
}

// ModelList is what the agent can switch to, and the providers it cannot use yet.
type ModelList struct {
	Choices      []ModelChoice `json:"choices"`
	Unconfigured []struct {
		Provider string   `json:"provider"`
		Label    string   `json:"label"`
		Missing  []string `json:"missing"`
	} `json:"unconfigured"`
	Errors []string `json:"errors"`
}

// CommandResult is a session command's answer: text, a patch, or a plan.
type CommandResult struct {
	Kind  string `json:"kind"` // text | diff | todos | turns | review | forked | goal | error
	Text  string `json:"text"`
	Patch string `json:"patch"`
	Items []struct {
		Text   string `json:"text"`
		Status string `json:"status"`
	} `json:"items"`
	Turns []Turn `json:"turns"`
	// review: what was reviewed, the findings worst first, and the verdict on the whole.
	Target   string    `json:"target"`
	Findings []Finding `json:"findings"`
	Overall  string    `json:"overall"`
	// forked: the new session the conversation was copied into
	ID    string `json:"id"`
	Title string `json:"title"`
	// goal: met | impossible | continue, why, and the turn to send next when it continues
	Status string `json:"status"`
	Reason string `json:"reason"`
	Next   string `json:"next"`
}

// Finding is one problem a /review found.
type Finding struct {
	File     string `json:"file"`
	Line     int    `json:"line"`
	Severity string `json:"severity"` // high | medium | low
	Title    string `json:"title"`
	Body     string `json:"body"`
}

// Turn is one turn a session can be rewound to: Index is what /rewind and "diff turn" take.
type Turn struct {
	Index     int    `json:"index"`
	Label     string `json:"label"`
	CreatedAt int64  `json:"createdAt"` // milliseconds since the epoch
}

// SessionSummary is one stored session, for a resume picker.
type SessionSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	UpdatedAt int64  `json:"updatedAt"` // milliseconds since the epoch
	// OpenElsewhere: another terminal has it open, so resuming it opens a copy.
	OpenElsewhere bool `json:"openElsewhere"`
}
