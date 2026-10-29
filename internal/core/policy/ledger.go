// Package policy decides whether a tool call runs: modes and the capabilities they offer, the
// permission ledger, the safety screen, read-only commands, command rules and the shell tokenizer.
// It is a port of core/cli/permissions.ts, safety.ts, command-readonly.ts, command-rules.ts and the
// relevant parts of command.ts and tools.ts, unchanged in meaning (Jev, the judge, is not ported).
package policy

import (
	"context"
	"fmt"
	"strings"
	"sync"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Mode is who decides whether a tool call runs.
//
//   - plan: read, search and think. No writes, no commands.
//   - build: the full tool set, every effectful call gated on a human decision.
//   - auto: the full tool set, workspace edits pre-approved, external actions and risky calls gated.
//   - defender: the full tool set plus playbooks, gated exactly like build and never auto-approved.
type Mode string

const (
	Plan     Mode = "plan"
	Build    Mode = "build"
	Auto     Mode = "auto"
	Defender Mode = "defender"
)

// ParseMode reads a mode name.
func ParseMode(s string) (Mode, bool) {
	switch Mode(s) {
	case Plan, Build, Auto, Defender:
		return Mode(s), true
	}
	return "", false
}

// workingCapabilities is every capability except the defender-only one, spelled out so a new
// capability is never handed to build and auto by accident.
var workingCapabilities = []string{tool.CapRead, tool.CapWrite, tool.CapTerminal, tool.CapResearch, tool.CapPlanning, tool.CapExternal}

// CapabilitiesForMode is the capabilities a mode offers. Plan gets no write, terminal or external
// tool; defender gets the playbooks besides the working set.
func CapabilitiesForMode(m Mode) []string {
	switch m {
	case Plan:
		return []string{tool.CapRead, tool.CapResearch, tool.CapPlanning}
	case Build, Auto:
		return append([]string(nil), workingCapabilities...)
	case Defender:
		return append(append([]string(nil), workingCapabilities...), tool.CapPlaybooks)
	}
	return nil
}

// Decision is a human's answer to an approval request. AllowPattern accepts the request's offered
// Pattern as a standing rule; with none offered it is a one-time Allow.
type Decision string

const (
	Allow        Decision = "allow"
	AllowAlways  Decision = "allow_always"
	AllowPattern Decision = "allow_pattern"
	Deny         Decision = "deny"
	DenyAlways   Decision = "deny_always"
)

// Request is what a human is asked to approve.
type Request struct {
	Call tool.Call
	Tool *tool.Tool
	// Summary is one line a human can act on without reading JSON.
	Summary string
	// ActionDigest is the exact proposed action; changed arguments need fresh consent.
	ActionDigest string
	// ScopeKey is the versioned key allow_always and deny_always persist.
	ScopeKey string
	// Safety is why auto mode did not approve this on its own.
	Safety Safety
	// Pattern is the broader standing rule the human may grant instead; nil when the call is not
	// safe to generalize, and always nil in defender mode.
	Pattern *Pattern
}

// Prompt asks a human. An error (a cancelled context) ends the decision with that error.
type Prompt func(ctx context.Context, r Request) (Decision, error)

// Ledger remembers standing decisions for the exact normalized action, not merely the tool name: a
// changed path, command, argument or effect is a different digest and is considered again. It is
// safe for concurrent use; the prompt is called without the lock held.
type Ledger struct {
	mode   Mode
	prompt Prompt

	mu       sync.Mutex
	standing map[string]string // scope → "allow" | "deny"
	order    []string          // standing's keys in insertion order, as a JavaScript Map keeps them
	// legacyDenied holds tool names denied under the unversioned policy. Old broad denials remain
	// safe; old broad allows are intentionally not migrated.
	legacyDenied map[string]bool
	rules        []CommandRule
}

// NewLedger is a ledger for a mode, asking prompt when a human must decide.
func NewLedger(mode Mode, prompt Prompt) *Ledger {
	return &Ledger{mode: mode, prompt: prompt, standing: map[string]string{}, legacyDenied: map[string]bool{}}
}

// Mode is the ledger's mode.
func (l *Ledger) Mode() Mode { return l.mode }

// SetCommandRules sets the person's command rules, read fresh each turn.
func (l *Ledger) SetCommandRules(rules []CommandRule) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rules = append([]CommandRule(nil), rules...)
}

func (l *Ledger) set(scope, decision string) {
	if _, ok := l.standing[scope]; !ok {
		l.order = append(l.order, scope)
	}
	l.standing[scope] = decision
}

func (l *Ledger) remove(scope string) bool {
	if _, ok := l.standing[scope]; !ok {
		return false
	}
	delete(l.standing, scope)
	for i, key := range l.order {
		if key == scope {
			l.order = append(l.order[:i], l.order[i+1:]...)
			break
		}
	}
	return true
}

// Snapshot is the standing decisions so far, for display and session persistence.
func (l *Ledger) Snapshot() map[string]string {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make(map[string]string, len(l.standing))
	for scope, decision := range l.standing {
		out[scope] = decision
	}
	return out
}

// Restore loads persisted decisions. Versioned keys are restored as they are; an unversioned key
// is a legacy tool-name decision, of which only a denial is kept. Values other than "allow" and
// "deny" are ignored.
func (l *Ledger) Restore(decisions map[string]string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	for scope, decision := range decisions {
		if decision != "allow" && decision != "deny" {
			continue
		}
		if strings.HasPrefix(scope, ApprovalPolicyVersion+":") {
			l.set(scope, decision)
		} else if decision == "deny" {
			l.legacyDenied[scope] = true
		}
	}
}

// AllowPattern grants a pattern rule directly, for a front end that offers it outside the prompt.
// Re-validated, so a hand-built pattern cannot carry a prefix SuggestPattern would never offer.
func (l *Ledger) AllowPattern(p Pattern) error {
	switch p.Kind {
	case PatternCommandPrefix:
		if CommandApprovalPrefix(p.Prefix) == "" {
			return fmt.Errorf("commands starting with %q cannot be approved as a pattern", p.Prefix)
		}
	case PatternDirectory:
		if EditApprovalDirectory(p.Directory+"/file") != p.Directory {
			return fmt.Errorf("%s cannot be approved as an edit directory", p.Directory)
		}
	default:
		return fmt.Errorf("unknown pattern kind %q", p.Kind)
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.set(PatternScopeKey(p), "allow")
	return nil
}

// Patterns is the granted pattern rules, in the order they were granted.
func (l *Ledger) Patterns() []Pattern {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.patternsLocked()
}

func (l *Ledger) patternsLocked() []Pattern {
	var out []Pattern
	for _, scope := range l.order {
		if l.standing[scope] != "allow" {
			continue
		}
		if p := patternFromScopeKey(scope); p != nil {
			out = append(out, *p)
		}
	}
	return out
}

// RevokePattern removes a granted pattern rule and reports whether one was present.
func (l *Ledger) RevokePattern(p Pattern) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.remove(PatternScopeKey(p))
}

// Decide reports whether a call may run, asking the human when it must. err is set only when the
// prompt fails (a cancelled context), or when the arguments cannot be digested (a non-finite
// number), which TypeScript reports by throwing; approved is false then.
func (l *Ledger) Decide(ctx context.Context, call tool.Call, t *tool.Tool) (bool, error) {
	// A tool that changes nothing needs no gate.
	if t.Effect == tool.EffectNone {
		return true, nil
	}
	args := call.Args
	if args == nil {
		args = tool.Args{}
	}
	l.mu.Lock()
	rules := l.rules
	l.mu.Unlock()

	// The person's own command rules speak first. Forbid: nothing to ask, the command refuses itself
	// with the rule's reason. Allow: no question (but defender mode looks at every change). Ask:
	// always a question, past auto mode and standing approvals.
	var ruled *RuleVerdict
	if command, ok := args["command"].(string); ok && t.Name == "run_command" && t.Provenance.BuiltIn() {
		ruled = JudgeCommand(rules, command)
	}
	if ruled != nil && ruled.Decision == RuleForbid {
		return true, nil
	}
	if ruled != nil && ruled.Decision == RuleAllow && l.mode != Defender {
		return true, nil
	}
	// A run outside the command sandbox is the person's call, every time.
	escalate, _ := args["escalate"].(bool)
	mustAsk := (ruled != nil && ruled.Decision == RuleAsk) || (t.Name == "run_command" && escalate)
	// A call that changes nothing (`git status` through run_command) is a read, in every mode.
	if !mustAsk && t.CallEffect(args) == tool.EffectNone {
		return true, nil
	}
	// Auto mode is ergonomics, not a blanket trust grant: credentials, production configuration and
	// high-impact commands remain explicit human decisions.
	safety := AssessToolSafety(tool.Call{ID: call.ID, Name: call.Name, Args: args, Raw: call.Raw}, t)
	if !mustAsk && l.mode == Auto && t.Effect == tool.EffectWorkspace && !safety.Sensitive {
		return true, nil
	}
	// An MCP tool its server marks read-only is not worth a dialog in auto mode.
	if l.mode == Auto && t.Effect == tool.EffectExternal && t.ReadOnlyHint {
		return true, nil
	}

	l.mu.Lock()
	legacyDenied := l.legacyDenied[t.Name]
	l.mu.Unlock()
	if legacyDenied {
		return false, nil
	}
	digest, err := actionDigest(call, t)
	if err != nil {
		return false, err
	}
	scopeKey := ApprovalPolicyVersion + ":" + digest

	l.mu.Lock()
	standing := l.standing[scopeKey]
	if standing == "deny" {
		l.mu.Unlock()
		return false, nil
	}
	if standing == "allow" && !mustAsk {
		l.mu.Unlock()
		return true, nil
	}
	if !mustAsk && l.patternApprovesLocked(args, t, safety) {
		l.mu.Unlock()
		return true, nil
	}
	l.mu.Unlock()

	// Defender mode never offers a broader grant: its contract is that each change is looked at.
	var pattern *Pattern
	if l.mode != Defender {
		pattern = SuggestPattern(tool.Call{ID: call.ID, Name: call.Name, Args: args, Raw: call.Raw}, t, safety)
	}
	decision, err := l.prompt(ctx, Request{
		Call:         call,
		Tool:         t,
		Summary:      DescribeToolCall(call, t),
		ActionDigest: digest,
		ScopeKey:     scopeKey,
		Safety:       safety,
		Pattern:      pattern,
	})
	if err != nil {
		return false, err
	}
	l.mu.Lock()
	switch decision {
	case AllowAlways:
		l.set(scopeKey, "allow")
	case DenyAlways:
		l.set(scopeKey, "deny")
	case AllowPattern:
		if pattern != nil {
			l.set(PatternScopeKey(*pattern), "allow")
		}
	}
	l.mu.Unlock()
	// Anything unrecognized is a refusal, so a stray answer never approves a write.
	return decision == Allow || decision == AllowAlways || decision == AllowPattern, nil
}

// patternApprovesLocked reports whether a granted pattern covers the call. Sensitive calls and
// tools that are not built in never match.
func (l *Ledger) patternApprovesLocked(args tool.Args, t *tool.Tool, safety Safety) bool {
	if l.mode == Defender || !t.Provenance.BuiltIn() || t.Effect != tool.EffectWorkspace || safety.Sensitive {
		return false
	}
	command, isCommand := args["command"].(string)
	for _, p := range l.patternsLocked() {
		if p.Kind == PatternCommandPrefix && t.Name == "run_command" && isCommand && CommandMatchesPrefix(command, p.Prefix) {
			return true
		}
		if p.Kind == PatternDirectory && editTools[t.Name] && PathUnderDirectory(args["path"], p.Directory) {
			return true
		}
	}
	return false
}

// DescribeProvenance is where a tool came from, in words, for the human asked to approve it; ""
// for Friday's own tools.
func DescribeProvenance(t *tool.Tool) string {
	if t.Provenance.BuiltIn() {
		return ""
	}
	source := t.Provenance.Kind
	if source == "mcp" {
		source = "MCP server"
	}
	return fmt.Sprintf(` [from %s "%s", not built into Friday]`, source, t.Provenance.ProviderID)
}

// DescribeToolCall is the one-line summary of a call for an approval prompt or a transcript line,
// with the provenance marker attached at this single choke point.
func DescribeToolCall(call tool.Call, t *tool.Tool) string {
	args := call.Args
	origin := DescribeProvenance(t)
	text := func(name, fallback string) string {
		if value, ok := args[name].(string); ok {
			return value
		}
		return fallback
	}
	switch call.Name {
	case "write_file":
		return "write " + text("path", "a file") + origin
	case "edit_file":
		return "edit " + text("path", "a file") + origin
	case "run_command":
		outside := ""
		if escalate, _ := args["escalate"].(bool); escalate {
			outside = " OUTSIDE the sandbox"
		}
		if background, _ := args["background"].(bool); background {
			outside += " in the background"
		}
		return "run " + text("command", "a command") + outside + origin
	case "start_application":
		port := "unknown"
		if value, ok := args["port"]; ok && value != nil {
			port = jsString(value)
		}
		return "start " + text("command", "an application") + " on port " + port + origin
	case "stop_application":
		return "stop application " + text("id", "unknown") + origin
	}
	path := ""
	if jsTruthy(args["path"]) {
		path = " " + text("path", "undefined")
	}
	return t.Name + path + origin
}

// jsTruthy is JavaScript truthiness for a decoded JSON value.
func jsTruthy(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case bool:
		return v
	case string:
		return v != ""
	case float64:
		return v != 0 && v == v
	case int:
		return v != 0
	}
	return true
}

// jsString is JavaScript's String(value) for a decoded JSON value.
func jsString(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case bool:
		if v {
			return "true"
		}
		return "false"
	case float64:
		if v != v {
			return "NaN"
		}
		return jsNumberString(v)
	case int:
		return fmt.Sprint(v)
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			if item != nil {
				parts[i] = jsString(item)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	}
	return fmt.Sprint(value)
}
