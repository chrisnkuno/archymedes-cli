package claude

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
)

// Claude Code's stream, said in Friday's events: the ones the interface already draws. Pure:
// messages in, notices out, no I/O (translate.ts in the TypeScript engine, which this follows).
//
//   - The reply's text arrives once. Streamed deltas are the text; the complete assistant message
//     that follows repeats it and is not sent again. A message that streamed nothing is sent whole.
//   - Every tool call is answered exactly once, after it was announced. A call still open when the
//     turn ends (an interrupt, a crash) is closed as failed, so no card spins forever.
//   - A turn ends with exactly one runtime_stop, and nothing follows it.
//   - Only the main conversation is shown as text. A sub-agent's tool calls go out as subagent
//     notices under the Task call that started it.
//
// Tool calls are shown under Friday's names where one means the same thing (Edit is edit_file, its
// file_path a project-relative path), so they draw as the cards people already read.

// MaxResultChars is how much of one tool result an event keeps: enough to read, never a megabyte.
const MaxResultChars = 20_000

// subagentResultChars is a sub-agent's tool result as a line under its card.
const subagentResultChars = 240

// shownAs are Claude Code's tools that are one of Friday's, with the argument mapping.
var shownAs = map[string]struct {
	name string
	args func(in map[string]any, root string) map[string]any
}{
	"Bash": {"run_command", func(in map[string]any, _ string) map[string]any {
		return pick("command", in["command"], "description", in["description"])
	}},
	"Read": {"read_file", func(in map[string]any, root string) map[string]any {
		return pick("path", relative(in["file_path"], root), "offset", in["offset"], "limit", in["limit"])
	}},
	"Write": {"write_file", func(in map[string]any, root string) map[string]any {
		return pick("path", relative(in["file_path"], root), "content", in["content"])
	}},
	"Edit": {"edit_file", func(in map[string]any, root string) map[string]any {
		return pick("path", relative(in["file_path"], root), "oldText", in["old_string"], "newText", in["new_string"], "replaceAll", in["replace_all"])
	}},
	"MultiEdit": {"edit_file", func(in map[string]any, root string) map[string]any {
		return pick("path", relative(in["file_path"], root), "edits", in["edits"])
	}},
	"Glob": {"glob_files", func(in map[string]any, root string) map[string]any {
		return pick("pattern", in["pattern"], "path", relative(in["path"], root))
	}},
	"Grep": {"grep_files", func(in map[string]any, root string) map[string]any {
		return pick("query", in["pattern"], "include", in["glob"], "path", relative(in["path"], root))
	}},
	"WebSearch": {"web_search", func(in map[string]any, _ string) map[string]any { return pick("query", in["query"]) }},
	"WebFetch":  {"web_fetch", func(in map[string]any, _ string) map[string]any { return pick("url", in["url"]) }},
	"TodoWrite": {"todo_write", func(in map[string]any, _ string) map[string]any { return pick("todos", in["todos"]) }},
	"Task":      {"delegate_task", delegateArgs},
	"Agent":     {"delegate_task", delegateArgs},
}

func delegateArgs(in map[string]any, _ string) map[string]any {
	task := in["description"]
	if task == nil {
		task = in["prompt"]
	}
	return pick("task", task, "agent", in["subagent_type"])
}

// writes are Claude Code's tools that change the project, for the event's effect.
var writes = map[string]bool{"Bash": true, "Write": true, "Edit": true, "MultiEdit": true, "NotebookEdit": true}

// Describe is a Claude Code tool call as Friday shows it: its name and arguments.
func Describe(name string, input map[string]any, root string) (string, map[string]any) {
	if known, ok := shownAs[name]; ok {
		return known.name, known.args(input, root)
	}
	return name, input
}

func effectOf(name string) string {
	switch {
	case writes[name]:
		return "workspace"
	case strings.HasPrefix(name, "Web"):
		return "external"
	}
	return "none"
}

// TodoItem is one line of Claude's checklist.
type TodoItem struct{ Text, Status string }

// Totals are a session's usage, for /cost.
type Totals struct {
	Calls, Input, Output, CacheRead, CacheWrite int
	CostUSD                                     float64
}

// RateLimit is what Claude Code last said about the plan's limits.
type RateLimit struct {
	Status        string  `json:"status"`
	ResetsAt      int64   `json:"resetsAt"`
	RateLimitType string  `json:"rateLimitType"`
	Utilization   float64 `json:"utilization"`
}

type apiUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens"`
	OutputTokensDetails      struct {
		ThinkingTokens int `json:"thinking_tokens"`
	} `json:"output_tokens_details"`
}

// merge lays the fields set in o over u: message_delta reports only what changed.
func (u *apiUsage) merge(o apiUsage) {
	for _, f := range []struct {
		dst *int
		src int
	}{{&u.InputTokens, o.InputTokens}, {&u.OutputTokens, o.OutputTokens},
		{&u.CacheReadInputTokens, o.CacheReadInputTokens}, {&u.CacheCreationInputTokens, o.CacheCreationInputTokens},
		{&u.OutputTokensDetails.ThinkingTokens, o.OutputTokensDetails.ThinkingTokens}} {
		if f.src > 0 {
			*f.dst = f.src
		}
	}
}

// usage is Claude's usage as Friday counts it: input includes what was read from and written to cache.
func (u apiUsage) usage() loop.Usage {
	return loop.Usage{
		InputTokens:       u.InputTokens + u.CacheReadInputTokens + u.CacheCreationInputTokens,
		OutputTokens:      u.OutputTokens,
		CachedInputTokens: u.CacheReadInputTokens,
		ReasoningTokens:   u.OutputTokensDetails.ThinkingTokens,
	}
}

type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

// message is one line of Claude Code's stream, as wide as this reads.
type message struct {
	Type            string          `json:"type"`
	Subtype         string          `json:"subtype"`
	SessionID       string          `json:"session_id"`
	Model           string          `json:"model"`
	Tools           []string        `json:"tools"`
	ParentToolUseID *string         `json:"parent_tool_use_id"`
	Message         json.RawMessage `json:"message"`
	Event           json.RawMessage `json:"event"`
	RateLimitInfo   *RateLimit      `json:"rate_limit_info"`
	Attempt         int             `json:"attempt"`
	MaxRetries      int             `json:"max_retries"`
	RetryDelayMs    int             `json:"retry_delay_ms"`
	ErrorStatus     *int            `json:"error_status"`
	Error           json.RawMessage `json:"error"`
	CompactMetadata *struct {
		PreTokens int `json:"pre_tokens"`
	} `json:"compact_metadata"`
	// result
	IsError      bool      `json:"is_error"`
	Result       string    `json:"result"`
	Errors       []string  `json:"errors"`
	TotalCostUSD float64   `json:"total_cost_usd"`
	Usage        *apiUsage `json:"usage"`
}

func (m message) parent() string {
	if m.ParentToolUseID == nil {
		return ""
	}
	return *m.ParentToolUseID
}

type openCall struct {
	name  string // as shown
	input map[string]any
}

// translator turns one session's stream into notices.
type translator struct {
	root string

	// Session facts, kept across turns.
	sessionID string
	model     string
	tools     []string
	todos     []TodoItem
	rateLimit *RateLimit
	totals    Totals

	// Per turn.
	iteration int
	streamed  map[string]bool
	call      *modelCall
	open      map[string]openCall
	childOpen map[string]string
	text      strings.Builder
	ended     bool
}

type modelCall struct {
	id, model string
	usage     apiUsage
	toolCalls int
}

func newTranslator(root string) *translator {
	return &translator{root: root, streamed: map[string]bool{}, open: map[string]openCall{}, childOpen: map[string]string{}, ended: true}
}

// toolRunning is whether a tool call is running: Claude reads anything sent now within the turn.
func (t *translator) toolRunning() bool { return len(t.open) > 0 && !t.ended }

// begin starts a turn: per-turn state cleared, session facts kept.
func (t *translator) begin() {
	t.iteration = 0
	t.streamed = map[string]bool{}
	t.open = map[string]openCall{}
	t.childOpen = map[string]string{}
	t.call = nil
	t.text.Reset()
	t.ended = false
}

func runtimeNotice(ev loop.Event) agents.Notice { return agents.Notice{Kind: "runtime", Event: &ev} }

// feed is one message of the stream. Between turns only the session facts are taken.
func (t *translator) feed(raw json.RawMessage) []agents.Notice {
	var m message
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	if m.Type == "system" && m.Subtype == "init" {
		t.sessionID, t.model, t.tools = m.SessionID, m.Model, m.Tools
		return nil
	}
	if m.Type == "rate_limit_event" && m.RateLimitInfo != nil {
		t.rateLimit = m.RateLimitInfo
		return nil
	}
	if t.ended {
		return nil
	}
	switch m.Type {
	case "system":
		return t.system(m)
	case "stream_event":
		return t.stream(m)
	case "assistant":
		return t.assistant(m)
	case "user":
		return t.user(m)
	}
	return nil
}

func (t *translator) system(m message) []agents.Notice {
	switch m.Subtype {
	case "api_retry":
		var errText string
		_ = json.Unmarshal(m.Error, &errText)
		status := 0
		if m.ErrorStatus != nil {
			status = *m.ErrorStatus
		}
		return []agents.Notice{runtimeNotice(loop.Event{Type: loop.EventRetry, Iteration: t.iteration, NextAttempt: m.Attempt + 1,
			MaxAttempts: m.MaxRetries + 1, DelayMs: m.RetryDelayMs, Reason: failureKind(errText, status)})}
	case "compact_boundary":
		if m.CompactMetadata == nil {
			return nil
		}
		// Claude Code compacts its own conversation and says only how long it was.
		return []agents.Notice{{Kind: "compaction", Event: &loop.Event{Type: loop.EventCompaction, TokensBefore: m.CompactMetadata.PreTokens}}}
	}
	return nil
}

func (t *translator) stream(m message) []agents.Notice {
	if m.parent() != "" {
		return nil
	}
	var ev struct {
		Type    string `json:"type"`
		Message struct {
			ID    string   `json:"id"`
			Model string   `json:"model"`
			Usage apiUsage `json:"usage"`
		} `json:"message"`
		Delta struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"delta"`
		Usage *apiUsage `json:"usage"`
	}
	if json.Unmarshal(m.Event, &ev) != nil {
		return nil
	}
	switch ev.Type {
	case "message_start":
		out := t.endCall()
		t.model = firstNonEmpty(ev.Message.Model, t.model) // a switch of model shows from its first call
		t.call = &modelCall{id: ev.Message.ID, model: firstNonEmpty(t.model, "claude"), usage: ev.Message.Usage}
		return out
	case "content_block_delta":
		if ev.Delta.Type != "text_delta" || ev.Delta.Text == "" {
			return nil
		}
		if t.call != nil {
			t.streamed[t.call.id] = true
		}
		t.text.WriteString(ev.Delta.Text)
		return []agents.Notice{runtimeNotice(loop.Event{Type: loop.EventDelta, Iteration: t.iteration, Text: ev.Delta.Text})}
	case "message_delta":
		if t.call != nil && ev.Usage != nil {
			t.call.usage.merge(*ev.Usage)
		}
	case "message_stop":
		return t.endCall()
	}
	return nil
}

func (t *translator) assistant(m message) []agents.Notice {
	var body struct {
		ID      string         `json:"id"`
		Content []contentBlock `json:"content"`
	}
	if json.Unmarshal(m.Message, &body) != nil {
		return nil
	}
	if parent := m.parent(); parent != "" {
		return t.subagentCalls(parent, body.Content)
	}
	var out []agents.Notice
	streamed := t.streamed[body.ID]
	for _, block := range body.Content {
		switch block.Type {
		case "text":
			if !streamed && block.Text != "" {
				t.text.WriteString(block.Text)
				out = append(out, runtimeNotice(loop.Event{Type: loop.EventDelta, Iteration: t.iteration, Text: block.Text}))
			}
		case "tool_use":
			out = append(out, t.toolCall(block)...)
		}
	}
	return out
}

func (t *translator) toolCall(block contentBlock) []agents.Notice {
	if block.ID == "" {
		return nil
	}
	if _, seen := t.open[block.ID]; seen {
		return nil
	}
	input := object(block.Input)
	name, args := Describe(block.Name, input, t.root)
	t.open[block.ID] = openCall{name: name, input: input}
	if t.call != nil {
		t.call.toolCalls++
	}
	if block.Name == "TodoWrite" {
		if todos, ok := input["todos"].([]any); ok {
			t.todos = t.todos[:0]
			for _, item := range todos {
				if todo, ok := item.(map[string]any); ok {
					text := fmt.Sprint(firstOf(todo["content"], todo["text"], ""))
					t.todos = append(t.todos, TodoItem{Text: text, Status: fmt.Sprint(firstOf(todo["status"], "pending"))})
				}
			}
		}
	}
	return []agents.Notice{runtimeNotice(loop.Event{Type: loop.EventToolCall, ToolCallID: block.ID, ToolName: name, Effect: effectOf(block.Name), Arguments: args})}
}

func (t *translator) user(m message) []agents.Notice {
	var body struct {
		Content json.RawMessage `json:"content"`
	}
	if json.Unmarshal(m.Message, &body) != nil {
		return nil
	}
	var blocks []contentBlock
	if json.Unmarshal(body.Content, &blocks) != nil {
		return nil // a string: the prompt itself, echoed
	}
	if parent := m.parent(); parent != "" {
		return t.subagentResults(parent, blocks)
	}
	var out []agents.Notice
	for _, block := range blocks {
		if block.Type != "tool_result" {
			continue
		}
		call, ok := t.open[block.ToolUseID]
		if !ok {
			continue // never announced, or already answered: a second answer is not shown
		}
		delete(t.open, block.ToolUseID)
		content := resultText(block.Content)
		if !block.IsError && call.name == "edit_file" {
			if diff := editDiff(call.input, t.root); diff != "" {
				content = diff // the change itself, rather than "The file has been updated"
			}
		}
		out = append(out, runtimeNotice(loop.Event{Type: loop.EventToolResult, ToolCallID: block.ToolUseID, ToolName: call.name, IsError: block.IsError, Effect: "none", Content: content}))
	}
	return out
}

func (t *translator) subagentCalls(parent string, blocks []contentBlock) []agents.Notice {
	var out []agents.Notice
	for _, block := range blocks {
		if block.Type != "tool_use" || block.ID == "" {
			continue
		}
		if _, seen := t.childOpen[block.ID]; seen {
			continue
		}
		name, args := Describe(block.Name, object(block.Input), t.root)
		t.childOpen[block.ID] = name
		out = append(out, t.subagent(parent, loop.Event{Type: loop.EventToolCall, ToolCallID: block.ID, ToolName: name, Effect: effectOf(block.Name), Arguments: args}))
	}
	return out
}

func (t *translator) subagentResults(parent string, blocks []contentBlock) []agents.Notice {
	var out []agents.Notice
	for _, block := range blocks {
		if block.Type != "tool_result" {
			continue
		}
		name, ok := t.childOpen[block.ToolUseID]
		if !ok {
			continue
		}
		delete(t.childOpen, block.ToolUseID)
		content := resultText(block.Content)
		if r := []rune(content); len(r) > subagentResultChars {
			content = string(r[:subagentResultChars])
		}
		out = append(out, t.subagent(parent, loop.Event{Type: loop.EventToolResult, ToolCallID: block.ToolUseID, ToolName: name, IsError: block.IsError, Effect: "none", Content: content}))
	}
	return out
}

func (t *translator) subagent(parent string, ev loop.Event) agents.Notice {
	role, _ := t.open[parent].input["subagent_type"].(string)
	if role == "" {
		role = "general"
	}
	return agents.Notice{Kind: "subagent", ParentToolCallID: parent, Agent: role, Event: &ev}
}

// endCall reports the model call in progress, once, with its usage.
func (t *translator) endCall() []agents.Notice {
	call := t.call
	if call == nil {
		return nil
	}
	t.call = nil
	t.iteration++
	return []agents.Notice{t.modelTurn(call.model, call.usage, call.toolCalls)}
}

func (t *translator) modelTurn(model string, u apiUsage, toolCalls int) agents.Notice {
	counted := u.usage()
	t.totals.Calls++
	t.totals.Input += counted.InputTokens
	t.totals.Output += counted.OutputTokens
	t.totals.CacheRead += counted.CachedInputTokens
	t.totals.CacheWrite += u.CacheCreationInputTokens
	return runtimeNotice(loop.Event{Type: loop.EventModelTurn, Iteration: t.iteration, Model: model, ToolCallCount: toolCalls, Usage: &counted})
}

// outcome is what a turn came to.
type outcome struct {
	status  loop.Status
	summary string
	text    string // the reply, as said: kept in the transcript
}

// finish ends the turn: open calls closed, usage reported if no call reported it, one runtime_stop.
// result is Claude Code's own end of turn; nil when the stream ended without one.
func (t *translator) finish(result *message, cancelled bool, reason string) ([]agents.Notice, outcome) {
	if t.ended {
		return nil, outcome{status: loop.Failed, summary: "The turn had already ended."}
	}
	out := t.endCall()
	for id, call := range t.open {
		content := "Ended before it finished."
		if cancelled {
			content = "Stopped before it finished."
		}
		out = append(out, runtimeNotice(loop.Event{Type: loop.EventToolResult, ToolCallID: id, ToolName: call.name, IsError: true, Effect: "none", Content: content}))
	}
	t.open = map[string]openCall{}
	if result != nil {
		t.sessionID = firstNonEmpty(result.SessionID, t.sessionID)
		t.totals.CostUSD += result.TotalCostUSD
		if t.iteration == 0 && result.Usage != nil {
			out = append(out, t.modelTurn(firstNonEmpty(t.model, "claude"), *result.Usage, 0))
		}
	}
	o := t.outcomeOf(result, cancelled, reason)
	out = append(out, runtimeNotice(loop.Event{Type: loop.EventStop, Status: string(o.status), Summary: o.summary}))
	t.ended = true
	t.iteration = 0
	return out, o
}

func (t *translator) outcomeOf(result *message, cancelled bool, reason string) outcome {
	text := t.text.String()
	switch {
	case cancelled:
		return outcome{loop.Cancelled, "Stopped.", text}
	case result == nil:
		return outcome{loop.Failed, firstNonEmpty(reason, "Claude Code stopped before the turn ended."), text}
	case result.Subtype == "success" && !result.IsError:
		return outcome{loop.Completed, firstNonEmpty(result.Result, text, "Done."), text}
	case result.Subtype == "error_max_turns":
		return outcome{loop.BudgetExhausted, "Claude Code reached its turn limit.", text}
	}
	said := append([]string(nil), result.Errors...)
	if result.Subtype == "success" {
		said = append(said, result.Result)
	}
	var parts []string
	for _, line := range said {
		if line = strings.TrimSpace(line); line != "" {
			parts = append(parts, line)
		}
	}
	summary := "Claude Code: " + firstNonEmpty(strings.Join(parts, " "), "the turn failed")
	if !strings.HasSuffix(summary, ".") {
		summary += "."
	}
	if limit := t.rateLimit; limit != nil && limit.Status == "rejected" {
		summary += fmt.Sprintf(" Your Claude plan's %s limit is used up%s.", limitName(limit.RateLimitType), resetsAt(limit.ResetsAt))
	}
	return outcome{loop.Failed, summary, text}
}

func failureKind(errText string, status int) string {
	switch {
	case errText == "rate_limit" || status == 429:
		return "rate_limit"
	case errText == "overloaded" || errText == "server_error" || status >= 500:
		return "server"
	}
	return "unknown"
}

func limitName(kind string) string {
	switch {
	case kind == "five_hour":
		return "five-hour"
	case strings.HasPrefix(kind, "seven_day"):
		return "weekly"
	}
	return "usage"
}

func resetsAt(epochSeconds int64) string {
	if epochSeconds == 0 {
		return ""
	}
	return "; it resets at " + time.Unix(epochSeconds, 0).Format("15:04")
}

// resultText is a tool result's text: a string, or the text blocks of a content array, cut to
// MaxResultChars.
func resultText(raw json.RawMessage) string {
	var text string
	if json.Unmarshal(raw, &text) != nil {
		var blocks []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		_ = json.Unmarshal(raw, &blocks)
		var parts []string
		for _, b := range blocks {
			switch {
			case b.Type == "text" && b.Text != "":
				parts = append(parts, b.Text)
			case b.Type == "image":
				parts = append(parts, "[image]")
			}
		}
		text = strings.Join(parts, "\n")
	}
	if len(text) > MaxResultChars {
		cut := strings.ToValidUTF8(text[:MaxResultChars], "")
		text = fmt.Sprintf("%s\n… %d more characters", cut, len(text)-len(cut))
	}
	return text
}

// editDiff is an edit as a unified diff of the replaced text, which is what the edit card shows.
func editDiff(input map[string]any, root string) string {
	file, _ := relative(input["file_path"], root).(string)
	oldText, ok1 := input["old_string"].(string)
	newText, ok2 := input["new_string"].(string)
	if file == "" || !ok1 || !ok2 {
		return ""
	}
	lines := []string{"--- a/" + file, "+++ b/" + file}
	removed := strings.Split(oldText, "\n")
	var added []string
	if newText != "" {
		added = strings.Split(newText, "\n")
	}
	lines = append(lines, fmt.Sprintf("@@ -1,%d +1,%d @@", len(removed), len(added)))
	for _, l := range removed {
		lines = append(lines, "-"+l)
	}
	for _, l := range added {
		lines = append(lines, "+"+l)
	}
	return strings.Join(lines, "\n")
}

// relative is a path inside the project as a project-relative one; outside it, said in full.
func relative(value any, root string) any {
	path, ok := value.(string)
	if !ok || path == "" {
		return nil
	}
	if !filepath.IsAbs(path) {
		return path
	}
	inside, err := filepath.Rel(root, path)
	switch {
	case err != nil || inside == ".." || strings.HasPrefix(inside, ".."+string(filepath.Separator)) || filepath.IsAbs(inside):
		return path
	case inside == ".":
		return "."
	}
	return filepath.ToSlash(inside)
}

// pick builds arguments from key, value pairs, leaving out the values that are not there.
func pick(pairs ...any) map[string]any {
	out := map[string]any{}
	for i := 0; i+1 < len(pairs); i += 2 {
		if pairs[i+1] != nil {
			out[pairs[i].(string)] = pairs[i+1]
		}
	}
	return out
}

func object(raw json.RawMessage) map[string]any {
	var out map[string]any
	if json.Unmarshal(raw, &out) != nil || out == nil {
		return map[string]any{}
	}
	return out
}

func firstOf(values ...any) any {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
