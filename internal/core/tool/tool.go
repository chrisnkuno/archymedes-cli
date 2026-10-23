// Package tool is what a tool is to the Go engine: its effect, the capability it belongs to, whether
// it may run beside others, and whether it is sent with every request or found on demand. It also
// holds a call, a result, and the evidence a result may carry for the verification gate.
//
// It is the bottom of internal/core: it imports nothing else of the engine, so policy, the gate, the
// tools and the loop can all speak about the same tool without importing each other.
package tool

import (
	"context"
	"encoding/json"
)

// Effect is what running a tool can change: nothing, the workspace, or something outside it.
type Effect string

const (
	EffectNone      Effect = "none"
	EffectWorkspace Effect = "workspace"
	EffectExternal  Effect = "external"
)

// Capability ids, as core/cli/permissions.ts names them; a mode is a set of these.
const (
	CapRead      = "workspace.files.read"
	CapWrite     = "workspace.files"
	CapTerminal  = "workspace.terminal"
	CapResearch  = "web.research"
	CapPlanning  = "reasoning.plan"
	CapExternal  = "workspace.external"
	CapPlaybooks = "security.playbooks"
)

// Provenance is where a tool came from. Empty Kind is built in; "mcp", "skill" and "plugin" name
// code Friday did not ship, which the ledger treats as a different actor from a same-named built-in.
type Provenance struct {
	Kind       string `json:"kind"`
	ProviderID string `json:"providerId,omitempty"`
}

// BuiltIn reports whether the tool ships with Friday.
func (p Provenance) BuiltIn() bool { return p.Kind == "" || p.Kind == "built-in" }

// Args is a call's arguments, as decoded JSON.
type Args = map[string]any

// Context is what a running tool may know about the run that called it.
type Context struct {
	// CallID is the model's id for this call.
	CallID string
	// ThreadID is the thread (session or sub-agent) running the tool.
	ThreadID string
	// Root is the workspace directory the tool works in.
	Root string
}

// Tool is one thing the model may call.
type Tool struct {
	Name        string
	Description string
	// Schema is the JSON schema of the arguments (an object schema).
	Schema map[string]any
	// Capability is one of the Cap* ids; a mode offers only its capabilities' tools.
	Capability string
	// Effect is the declared effect. EffectFor, when set, may lower it for one call: run_command
	// declares workspace but `git status` changes nothing.
	Effect    Effect
	EffectFor func(Args) Effect
	// ParallelSafe tools with no effect run at the same time as others of their kind in one batch.
	ParallelSafe bool
	// Deferred tools are not sent with every request; tool_search finds and loads them.
	Deferred bool
	// ReadOnlyHint is an MCP server's own claim that the tool changes nothing out there.
	ReadOnlyHint bool
	Provenance   Provenance
	Run          func(ctx context.Context, tc Context, args Args) Result
}

// CallEffect is the effect of this call: the tool's own judgment when it has one, else its declaration.
func (t *Tool) CallEffect(args Args) Effect {
	if t.EffectFor != nil {
		return t.EffectFor(args)
	}
	return t.Effect
}

// Call is one tool call as the model made it.
type Call struct {
	ID   string
	Name string
	Args Args
	// Raw is the arguments as the model wrote them, kept for the transcript.
	Raw string
}

// ParseArgs decodes a model's argument text. Empty is an empty object; anything that is not a JSON
// object is an error the model can read and correct.
func ParseArgs(raw string) (Args, error) {
	if raw == "" {
		return Args{}, nil
	}
	var args Args
	if err := json.Unmarshal([]byte(raw), &args); err != nil {
		return nil, err
	}
	if args == nil {
		args = Args{}
	}
	return args, nil
}

// EvidenceKind is how strong a passing check is, weakest first: a build or typecheck, executed
// tests, the assembled thing exercised, an end-to-end suite. See verification-gate.ts.
type EvidenceKind string

const (
	EvidenceCheck    EvidenceKind = "check"
	EvidenceTests    EvidenceKind = "tests"
	EvidenceSmoke    EvidenceKind = "smoke"
	EvidenceBehavior EvidenceKind = "behavior"
)

// Evidence is a tool result that verified something.
type Evidence struct {
	Passed  bool
	Kind    EvidenceKind
	Summary string
}

// Result is what a tool returns.
type Result struct {
	// Content is for the model to read.
	Content string
	IsError bool
	// Data is the same result as values, for the gate, the interface and tests.
	Data map[string]any
	// Evidence is set when the result verified something.
	Evidence *Evidence
}

// Text is a plain result.
func Text(content string) Result { return Result{Content: content} }

// Errorf is a failed result the model reads and can correct; a failure never ends the run.
func Error(content string) Result { return Result{Content: content, IsError: true} }

// StringArg is a string argument, "" when absent or not a string.
func StringArg(args Args, name string) string {
	value, _ := args[name].(string)
	return value
}

// IntArg is an integer argument (JSON numbers decode as float64), with ok false when absent.
func IntArg(args Args, name string) (int, bool) {
	switch v := args[name].(type) {
	case float64:
		return int(v), true
	case int:
		return v, true
	case json.Number:
		n, err := v.Int64()
		return int(n), err == nil
	}
	return 0, false
}

// BoolArg is a boolean argument, false when absent.
func BoolArg(args Args, name string) bool {
	value, _ := args[name].(bool)
	return value
}
