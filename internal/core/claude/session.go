package claude

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Session is one Friday session run by the person's own Claude Code.
//
// Fast because the process stays warm: Claude Code starts when the session opens (the interface
// opens it well before the first prompt is typed), and every turn after that is one more message
// on the same input, so Claude's prompt cache stays warm between turns. Tokens are passed on as
// they stream. If Claude Code exits (killed, crashed, updated under it), the next turn starts it
// again, resuming the same Claude session.
type Session struct {
	opts Options

	startMu sync.Mutex // one start at a time; held for seconds, so apart from mu

	mu      sync.Mutex
	proc    *process
	tr      *translator
	mode    policy.Mode
	model   string
	resume  string
	preface string
	turn    *turn
	turnIDs []turnID
	refused map[string]bool
	closed  bool

	emitMu sync.Mutex // notices go out in order, whichever goroutine ends the turn
}

// Options are what a session opens with.
type Options struct {
	Root       string
	Executable string
	// Environ is what Claude Code runs in (see Environment).
	Environ []string
	Mode    policy.Mode
	// Model is an alias ("opus") or a model id; "" or "default" is Claude Code's own choice.
	Model string
	// Resume is Claude's own session id, to continue its conversation.
	Resume string
	// Preface is told to Claude before the first prompt: what was said while it was not there.
	Preface string
	// Transcript is the whole conversation as a preface, for when Claude's own copy is gone.
	Transcript func() string
	TestFirst  bool
	Rules      []policy.CommandRule
	Notify     func(agents.Notice)
	// Approve asks the person about a tool Claude Code wants to use; Ask puts AskUserQuestion to
	// them. Without Ask, AskUserQuestion is approved like any tool.
	Approve policy.Prompt
	Ask     agents.Asker
}

type turn struct {
	done      chan outcome
	cancelled bool
	steers    []string
}

type turnID struct{ id, title string }

// Open starts Claude Code for a session. Not signed in, or not starting, is an error that says
// what to do.
func Open(ctx context.Context, opts Options) (*Session, error) {
	if opts.Executable == "" {
		return nil, fmt.Errorf("Claude Code is not installed: get it at %s, then choose Claude again", InstallURL)
	}
	if opts.Notify == nil {
		opts.Notify = func(agents.Notice) {}
	}
	s := &Session{opts: opts, tr: newTranslator(opts.Root), mode: opts.Mode, model: opts.Model, resume: opts.Resume, preface: opts.Preface, refused: map[string]bool{}}
	// Asked while Claude Code starts, not before it: the answer takes most of a second.
	signedIn := make(chan Auth, 1)
	go func() {
		auth, err := SignedIn(ctx, opts.Executable, opts.Environ)
		if err != nil {
			auth.LoggedIn = true // unreadable is not "signed out": let Claude Code say
		}
		signedIn <- auth
	}()
	_, err := s.ensure(ctx)
	if auth := <-signedIn; !auth.LoggedIn {
		s.Close()
		return nil, errors.New("Claude Code is not signed in: open Providers (alt+p) and choose Claude, or run `claude auth login`")
	}
	if err != nil {
		return nil, err
	}
	return s, nil
}

// ensure is the running Claude Code, started (or restarted after an exit) when there is none.
func (s *Session) ensure(ctx context.Context) (*process, error) {
	s.startMu.Lock()
	defer s.startMu.Unlock()
	s.mu.Lock()
	p, closed := s.proc, s.closed
	resume := firstNonEmpty(s.tr.sessionID, s.resume)
	s.mu.Unlock()
	if closed {
		return nil, errors.New("this session is closed")
	}
	if p != nil {
		return p, nil
	}
	p, err := start(ctx, s.startOptions(resume), s.canUseTool)
	if err != nil && resume != "" && ctx.Err() == nil {
		// Claude's copy of the conversation is gone (another machine, a cleared ~/.claude): carry
		// on with a new one, told what was said.
		s.mu.Lock()
		s.tr.sessionID, s.resume = "", ""
		if s.opts.Transcript != nil {
			s.preface = s.opts.Transcript()
		}
		s.mu.Unlock()
		p, err = start(ctx, s.startOptions(""), s.canUseTool)
	}
	if err != nil {
		return nil, fmt.Errorf("Claude Code did not start: %w", err)
	}
	if len(p.models) > 0 {
		learn(p.models)
	}
	s.mu.Lock()
	s.proc = p
	s.mu.Unlock()
	go s.pump(p)
	return p, nil
}

func (s *Session) startOptions(resume string) startOptions {
	s.mu.Lock()
	defer s.mu.Unlock()
	opts := startOptions{executable: s.opts.Executable, root: s.opts.Root, environ: s.opts.Environ, model: s.model, mode: PermissionMode(s.mode), resume: resume}
	if s.opts.TestFirst {
		opts.appendText = gate.TestFirstBrief
	}
	return opts
}

// pump is every message of one process's life; a turn ends at its result, the process at the end.
func (s *Session) pump(p *process) {
	for raw := range p.messages {
		var head struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &head)
		s.mu.Lock()
		if head.Type == "result" && s.turn != nil {
			s.mu.Unlock()
			var result message
			if json.Unmarshal(raw, &result) == nil {
				s.endTurn(&result, "")
			}
			continue
		}
		notices := s.tr.feed(raw)
		s.mu.Unlock()
		s.emit(notices)
	}
	// Gone: the next turn starts a new process, resuming this conversation.
	s.mu.Lock()
	if s.proc == p {
		s.proc = nil
	}
	s.mu.Unlock()
	reason := "Claude Code exited."
	if p.err != nil {
		reason = "Claude Code stopped: " + p.err.Error()
	}
	s.endTurn(nil, reason)
}

func (s *Session) emit(notices []agents.Notice) {
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	for _, n := range notices {
		s.opts.Notify(n)
	}
}

// endTurn ends the running turn, if any: result is Claude Code's own end of it, nil when there was none.
func (s *Session) endTurn(result *message, reason string) {
	s.emitMu.Lock()
	defer s.emitMu.Unlock()
	s.mu.Lock()
	t := s.turn
	if t == nil {
		s.mu.Unlock()
		return
	}
	s.turn = nil
	notices, o := s.tr.finish(result, t.cancelled, reason)
	if o.status != loop.Failed || o.text != "" {
		s.preface = "" // Claude has now seen it
	}
	s.mu.Unlock()
	for _, n := range notices {
		s.opts.Notify(n)
	}
	t.done <- o
}

// Turn runs one prompt to its end. A cancelled ctx interrupts Claude Code, which ends the turn.
func (s *Session) Turn(ctx context.Context, prompt string) agents.OutsideTurn {
	t := &turn{done: make(chan outcome, 1)}
	s.mu.Lock()
	if s.turn != nil {
		s.mu.Unlock()
		return agents.OutsideTurn{Result: loop.Result{Status: loop.Failed, Err: errors.New("a turn is already running in this session")}}
	}
	s.turn = t
	s.tr.begin()
	s.mu.Unlock()

	p, err := s.ensure(ctx)
	if err != nil {
		s.mu.Lock()
		t.cancelled = ctx.Err() != nil
		s.mu.Unlock()
		s.endTurn(nil, err.Error())
		return s.result(<-t.done, t)
	}
	id := newUUID()
	s.mu.Lock()
	text := prompt
	if s.preface != "" {
		text = s.preface + "\n\n" + prompt
	}
	s.turnIDs = append(s.turnIDs, turnID{id, thread.Title(prompt)})
	s.mu.Unlock()
	if err := p.send(text, id); err != nil {
		s.endTurn(nil, "Claude Code did not take the prompt: "+err.Error())
	}
	select {
	case o := <-t.done:
		return s.result(o, t)
	case <-ctx.Done():
	}
	s.mu.Lock()
	t.cancelled = true
	s.mu.Unlock()
	stop, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_, _ = p.request(stop, map[string]any{"subtype": "interrupt"})
	cancel()
	select {
	case o := <-t.done:
		return s.result(o, t)
	case <-time.After(10 * time.Second):
		s.endTurn(nil, "") // it did not stop when asked: the turn ends here regardless
		return s.result(<-t.done, t)
	}
}

func (s *Session) result(o outcome, t *turn) agents.OutsideTurn {
	s.mu.Lock()
	steers := append([]string(nil), t.steers...)
	s.mu.Unlock()
	r := loop.Result{Status: o.status, Text: o.summary}
	if o.status == loop.Failed {
		r.Err = errors.New(o.summary)
	}
	return agents.OutsideTurn{Reply: o.text, Steers: steers, Result: r}
}

// Steer hands text to the running turn. Taken only while one of Claude's tools runs: Claude Code
// then reads it after that tool and answers it within the same turn. At any other moment it could
// arrive after Claude has finished and start a turn of its own, so the answer is no and the
// message waits for the next turn instead.
func (s *Session) Steer(text string) bool {
	s.mu.Lock()
	t, p := s.turn, s.proc
	if t == nil || t.cancelled || p == nil || !s.tr.toolRunning() {
		s.mu.Unlock()
		return false
	}
	t.steers = append(t.steers, text)
	s.mu.Unlock()
	return p.send(text, newUUID()) == nil
}

// SetMode changes Claude Code's permission mode, now if it is running.
func (s *Session) SetMode(ctx context.Context, mode policy.Mode) error {
	s.mu.Lock()
	s.mode = mode
	p := s.proc
	s.mu.Unlock()
	if p == nil {
		return nil
	}
	_, err := p.request(ctx, map[string]any{"subtype": "set_permission_mode", "mode": PermissionMode(mode)})
	return err
}

// SetModel moves Claude Code to another of its models; "" or "default" is its own choice.
func (s *Session) SetModel(ctx context.Context, model string) error {
	if model == "default" {
		model = ""
	}
	s.mu.Lock()
	p := s.proc
	s.mu.Unlock()
	if p != nil {
		var value any
		if model != "" {
			value = model
		}
		if _, err := p.request(ctx, map[string]any{"subtype": "set_model", "model": value}); err != nil {
			return err
		}
	}
	s.mu.Lock()
	s.model = model
	s.tr.model = "" // said again by the next call
	s.mu.Unlock()
	return nil
}

// Model is the model in use: the one chosen, else the one Claude Code said, else "default".
func (s *Session) Model() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return firstNonEmpty(s.model, s.tr.model, "default")
}

// ClaudeSession is Claude Code's own id for this conversation, which resuming continues.
func (s *Session) ClaudeSession() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return firstNonEmpty(s.tr.sessionID, s.resume)
}

// Close ends Claude Code. A running turn ends with it.
func (s *Session) Close() {
	s.mu.Lock()
	s.closed = true
	p := s.proc
	s.mu.Unlock()
	if p != nil {
		p.close()
	}
}

// canUseTool is Friday's answer to Claude Code asking whether a tool may run.
func (s *Session) canUseTool(ctx context.Context, r toolRequest) map[string]any {
	if r.Input == nil {
		r.Input = map[string]any{}
	}
	s.mu.Lock()
	refused, mode := s.refused[r.ToolName], s.mode
	s.mu.Unlock()
	if refused {
		return denial(r.ToolName + " was refused for the rest of this session.")
	}
	if r.ToolName == "AskUserQuestion" && s.opts.Ask != nil {
		return s.askUserQuestion(ctx, r.Input)
	}
	switch v, why := screen(r.ToolName, r.Input, mode, s.opts.Rules); v {
	case allow:
		return allowed(r.Input, nil)
	case deny:
		return denial(why)
	}
	if s.opts.Approve == nil {
		return denial("Nobody is here to approve this.")
	}
	name, args := Describe(r.ToolName, r.Input, s.opts.Root)
	shown := &tool.Tool{Name: name, Effect: tool.Effect(effectOf(r.ToolName))}
	call := tool.Call{ID: r.ToolUseID, Name: name, Args: args}
	req := policy.Request{Call: call, Tool: shown, Summary: firstNonEmpty(r.Title, policy.DescribeToolCall(call, shown))}
	if r.ToolName == "Bash" {
		req.Safety = policy.AssessToolSafety(call, runCommand)
	}
	decision, err := s.opts.Approve(ctx, req)
	if err != nil {
		return denial("The question was withdrawn before it was answered.")
	}
	switch decision {
	case policy.Allow:
		return allowed(r.Input, nil)
	case policy.AllowAlways, policy.AllowPattern:
		return allowed(r.Input, forThisSession(r.Suggestions))
	case policy.DenyAlways:
		s.mu.Lock()
		s.refused[r.ToolName] = true
		s.mu.Unlock()
		return denial("The person refused this, and anything more from this tool, for this session.")
	}
	return denial("The person refused this.")
}

// askUserQuestion puts Claude Code's AskUserQuestion to the person, each question in turn, and
// hands the answers back as the tool's `answers` input (question text to the chosen label, as
// Claude Code reads them). A dismissed question is a refusal, so Claude carries on rather than waiting.
func (s *Session) askUserQuestion(ctx context.Context, input map[string]any) map[string]any {
	questions, _ := input["questions"].([]any)
	answers := map[string]any{}
	for _, entry := range questions {
		q, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		question, _ := q["question"].(string)
		if strings.TrimSpace(question) == "" {
			continue
		}
		var labels []string
		options, _ := q["options"].([]any)
		for _, option := range options {
			switch o := option.(type) {
			case string:
				labels = append(labels, o)
			case map[string]any:
				if label, ok := o["label"].(string); ok && strings.TrimSpace(label) != "" {
					labels = append(labels, label)
				}
			}
		}
		multi, _ := q["multiSelect"].(bool)
		answer, err := s.opts.Ask(ctx, question, labels, multi && len(labels) > 1)
		if err != nil || answer == "" {
			return denial("The person dismissed the question without answering. Carry on with your best judgment and say what you assumed.")
		}
		answers[question] = answer
	}
	updated := map[string]any{}
	for k, v := range input {
		updated[k] = v
	}
	updated["answers"] = answers
	return allowed(updated, nil)
}

func allowed(input map[string]any, permissions []map[string]any) map[string]any {
	out := map[string]any{"behavior": "allow", "updatedInput": input}
	if len(permissions) > 0 {
		out["updatedPermissions"] = permissions
	}
	return out
}

func denial(why string) map[string]any { return map[string]any{"behavior": "deny", "message": why} }

// forThisSession is Claude Code's "always allow" for this session only, as Friday's own approvals
// are, never written to a settings file.
func forThisSession(suggestions []json.RawMessage) []map[string]any {
	var out []map[string]any
	for _, raw := range suggestions {
		var s map[string]any
		if json.Unmarshal(raw, &s) == nil && s != nil {
			s["destination"] = "session"
			out = append(out, s)
		}
	}
	return out
}

// newUUID is a random (version 4) UUID: Claude Code keys a turn's file checkpoints by it.
func newUUID() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
