package server

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/advise"
	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/claude"
	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// session is one ACP session: the engine's session and what the client is told about it.
type session struct {
	id   string
	cwd  string
	core *agents.Session
	env  llm.Env

	mu     sync.Mutex
	claude *claude.Session // set while the person's Claude Code runs the session (claude.go)
}

func (s *Server) session(id string) *session {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	return s.sessions[id]
}

func (s *Server) closeAll() {
	s.sessMu.Lock()
	s.closing = true
	all := make([]*session, 0, len(s.sessions))
	for _, sess := range s.sessions {
		all = append(all, sess)
	}
	s.sessions = map[string]*session{}
	s.sessMu.Unlock()
	for _, sess := range all {
		sess.close()
	}
}

func (s *Server) dispatch(ctx context.Context, method string, params json.RawMessage) (any, error) {
	if method != "initialize" && !s.initialized.Load() {
		return nil, errorf(codeInvalidRequest, "initialize must come first")
	}
	if m, ok := methodByName[method]; ok && m.handle != nil {
		return m.handle(s, ctx, params)
	}
	if forwarded[method] && s.opts.Forward != nil {
		raw, err := s.opts.Forward(ctx, method, params)
		if err != nil {
			return nil, err
		}
		return raw, nil
	}
	return nil, errorf(codeMethodNotFound, "Method not found: %s", method)
}

func (s *Server) initialize(params json.RawMessage) any {
	var p struct {
		ClientCapabilities struct {
			Meta struct {
				Archymedes struct {
					Events    bool `json:"events"`
					Questions bool `json:"questions"`
				} `json:"archymedes"`
			} `json:"_meta"`
		} `json:"clientCapabilities"`
	}
	_ = json.Unmarshal(params, &p)
	s.events.Store(p.ClientCapabilities.Meta.Archymedes.Events)
	s.questions.Store(p.ClientCapabilities.Meta.Archymedes.Questions)
	s.initialized.Store(true)
	caps := map[string]any{"loadSession": true, "promptCapabilities": map[string]any{"image": false, "audio": false, "embeddedContext": true}}
	if s.events.Load() {
		caps["_meta"] = map[string]any{"archymedes": map[string]any{"events": 1, "engine": "go"}}
	}
	return map[string]any{"protocolVersion": ProtocolVersion, "agentCapabilities": caps, "authMethods": []any{}}
}

func (s *Server) env() llm.Env { return llm.LoadEnv(s.opts.ConfigDir, s.opts.Environ) }

var modeIDs = []string{"plan", "build", "auto", "defender"}

func (s *Server) newSession(ctx context.Context, params json.RawMessage, resume bool) (any, error) {
	var p struct {
		Cwd       string `json:"cwd"`
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(params, &p)
	cwd := firstNonEmpty(p.Cwd, s.opts.Cwd)
	if cwd == "" {
		return nil, errorf(codeInvalidParams, "cwd is required")
	}
	env := s.env()
	provider, model := s.opts.Provider, s.opts.Model
	if resume {
		if store, err := thread.Open(cwd, firstNonEmpty(p.SessionID, "latest")); err == nil {
			if meta, err := store.Meta(); err == nil && provider == "" {
				provider, model = meta.Provider, firstNonEmpty(model, meta.Model)
			}
		}
	}
	sel, err := llm.Resolve(env, provider, model)
	if err != nil {
		return nil, errorf(codeInvalidRequest, "%s", err.Error())
	}
	models, err := llm.NewModels(ctx, sel, env, s.opts.Open)
	if err != nil {
		return nil, errorf(codeInvalidRequest, "%s", err.Error())
	}
	// Notices may come before the session has an id (a broken rules file is reported while it
	// opens); they wait for it.
	ref := &sessionRef{}
	cfg := agents.Config{
		Root: cwd, ConfigDir: s.opts.ConfigDir, Env: env, Models: models, Mode: s.opts.Mode,
		Prompt: func(ctx context.Context, r policy.Request) (policy.Decision, error) {
			return s.askPermission(ctx, ref.get(), r)
		},
		Notify:    func(n agents.Notice) { ref.publish(s, n) },
		TestFirst: gate.TestFirstFromEnv(env.Get),
		Budgets:   loop.Budgets{ContextLimit: llm.ContextLimit(env)},
	}
	if s.questions.Load() {
		cfg.Ask = func(ctx context.Context, question string, options []string, multi bool) (string, error) {
			return s.askQuestion(ctx, ref.get(), question, options, multi)
		}
	}
	var core *agents.Session
	if resume {
		// The stored mode, unless the command line chose one (cfg.Mode is then set).
		core, err = agents.Load(ctx, cfg, firstNonEmpty(p.SessionID, "latest"))
	} else {
		if cfg.Mode == "" {
			cfg.Mode = policy.Build
		}
		core, err = agents.Create(ctx, cfg, "")
	}
	if err != nil {
		return nil, errorf(codeInvalidRequest, "%s", err.Error())
	}
	sess := &session{id: core.ID(), cwd: cwd, core: core, env: env}
	if sel.Provider.Kind == llm.KindClaudeCode {
		c, err := s.openClaude(ctx, sess, sel.Model)
		if err != nil {
			core.Close()
			return nil, errorf(codeInvalidRequest, "%s", err.Error())
		}
		sess.claude = c
	}
	s.sessMu.Lock()
	if s.closing {
		// The client left while this session opened: nothing will ever close it but us.
		s.sessMu.Unlock()
		sess.close()
		return nil, errorf(codeInvalidRequest, "the connection is closing")
	}
	s.sessions[sess.id] = sess
	s.sessMu.Unlock()
	// The transcript first, then what happened since (a resumed sub-agent's events), in order.
	if resume {
		s.replay(sess)
	}
	ref.set(s, sess.id)
	info := s.info(sess)
	result := map[string]any{"_meta": map[string]any{"archymedes": info}}
	if !resume {
		result["sessionId"] = sess.id
		var modes []any
		for _, m := range modeIDs {
			modes = append(modes, map[string]any{"id": m, "name": m})
		}
		result["modes"] = map[string]any{"currentModeId": string(core.Mode()), "availableModes": modes}
	}
	return result, nil
}

// sessionRef holds a session's id once it has one, and the notices sent before that.
type sessionRef struct {
	mu    sync.Mutex
	id    string
	early []agents.Notice
}

func (r *sessionRef) get() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.id
}

// publish and set hold the lock while writing, so a notice that arrives as the id is set can
// never overtake the ones buffered before it.
func (r *sessionRef) publish(s *Server, n agents.Notice) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.id == "" {
		r.early = append(r.early, n)
		return
	}
	s.publish(r.id, n)
}

func (r *sessionRef) set(s *Server, id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.id = id
	for _, n := range r.early {
		s.publish(id, n)
	}
	r.early = nil
}

func (s *Server) info(sess *session) map[string]any {
	sel := sess.core.Models().Selection()
	if c := sess.outside(); c != nil {
		sel.Model = c.Model()
	}
	return map[string]any{
		"sessionId": sess.id, "provider": sel.Provider.ID, "providerLabel": sel.Provider.Label, "model": sel.Model,
		"mode": string(sess.core.Mode()), "root": sess.cwd, "workspace": "local", "workspaceLabel": "this computer", "engine": "go",
	}
}

// replay sends a loaded session's conversation to the client, the way the TypeScript agent does.
func (s *Server) replay(sess *session) {
	names := map[string]string{}
	for _, m := range sess.core.Messages() {
		switch m.Role {
		case fantasy.MessageRoleUser:
			if text := textOf(m); strings.TrimSpace(text) != "" {
				s.notify("session/update", map[string]any{"sessionId": sess.id, "update": map[string]any{"sessionUpdate": "user_message_chunk", "content": map[string]any{"type": "text", "text": text}}})
			}
		case fantasy.MessageRoleAssistant:
			if text := textOf(m); strings.TrimSpace(text) != "" {
				s.notify("session/update", map[string]any{"sessionId": sess.id, "update": map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": text}}})
			}
			for _, part := range m.Content {
				if call, ok := part.(fantasy.ToolCallPart); ok {
					names[call.ToolCallID] = call.ToolName
					var args map[string]any
					_ = json.Unmarshal([]byte(call.Input), &args)
					ev := loop.Event{Type: loop.EventToolCall, ToolCallID: call.ToolCallID, ToolName: call.ToolName, Effect: "none", Arguments: args}
					s.publish(sess.id, agents.Notice{Kind: "runtime", Event: &ev})
				}
			}
		case fantasy.MessageRoleTool:
			for _, part := range m.Content {
				if result, ok := part.(fantasy.ToolResultPart); ok {
					ev := loop.Event{Type: loop.EventToolResult, ToolCallID: result.ToolCallID, ToolName: names[result.ToolCallID], Effect: "none"}
					switch out := result.Output.(type) {
					case fantasy.ToolResultOutputContentText:
						ev.Content = out.Text
					case fantasy.ToolResultOutputContentError:
						ev.Content, ev.IsError = out.Error.Error(), true
					}
					s.publish(sess.id, agents.Notice{Kind: "runtime", Event: &ev})
				}
			}
		}
	}
}

func textOf(m fantasy.Message) string {
	var b strings.Builder
	for _, part := range m.Content {
		if t, ok := part.(fantasy.TextPart); ok {
			b.WriteString(t.Text)
		}
	}
	return b.String()
}

// acceptedPrompt is a prompt checked and given its place in line on the reading goroutine.
type acceptedPrompt struct {
	sess     *session
	text     string
	accepted agents.Accepted
}

// acceptPrompt checks a prompt and takes its place in line, in the order the requests arrived:
// it runs on the goroutine that reads the wire, before the turn's own goroutine starts, so a
// session/cancel read right after it covers it, and two prompts sent back to back keep their order.
// Only a prompt that will run is accepted; an accepted slot that never runs holds every one after it.
func (s *Server) acceptPrompt(params json.RawMessage) (acceptedPrompt, error) {
	var p struct {
		SessionID string            `json:"sessionId"`
		Prompt    []json.RawMessage `json:"prompt"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return acceptedPrompt{}, errorf(codeInvalidParams, "%v", err)
	}
	sess := s.session(p.SessionID)
	if sess == nil {
		return acceptedPrompt{}, errorf(codeInvalidParams, "no session %s", p.SessionID)
	}
	text := promptText(p.Prompt)
	if strings.TrimSpace(text) == "" {
		return acceptedPrompt{}, errorf(codeInvalidParams, "the prompt has no text")
	}
	return acceptedPrompt{sess: sess, text: text, accepted: sess.core.Accept()}, nil
}

func (s *Server) prompt(ctx context.Context, p acceptedPrompt) (any, error) {
	var result loop.Result
	if c := p.sess.outside(); c != nil {
		result = s.claudeTurn(ctx, p, c)
	} else {
		result = p.sess.core.Prompt(ctx, p.accepted, p.text)
	}
	return map[string]any{"stopReason": stopReason(result.Status)}, nil
}

// promptText joins a prompt's content blocks: text as it is, embedded resources with their uri.
func promptText(blocks []json.RawMessage) string {
	var parts []string
	for _, raw := range blocks {
		var b struct {
			Type     string `json:"type"`
			Text     string `json:"text"`
			URI      string `json:"uri"`
			Resource struct {
				URI  string `json:"uri"`
				Text string `json:"text"`
			} `json:"resource"`
		}
		if json.Unmarshal(raw, &b) != nil {
			continue
		}
		switch b.Type {
		case "text":
			parts = append(parts, b.Text)
		case "resource":
			if b.Resource.Text != "" {
				parts = append(parts, fmt.Sprintf("<context uri=%q>\n%s\n</context>", b.Resource.URI, b.Resource.Text))
			}
		case "resource_link":
			parts = append(parts, "@"+b.URI)
		}
	}
	return strings.Join(parts, "\n")
}

func stopReason(status loop.Status) string {
	switch status {
	case loop.Cancelled:
		return "cancelled"
	case loop.BudgetExhausted:
		return "max_turn_requests"
	}
	return "end_turn"
}

func (s *Server) setMode(params json.RawMessage) (any, error) {
	var p struct {
		SessionID string `json:"sessionId"`
		ModeID    string `json:"modeId"`
	}
	_ = json.Unmarshal(params, &p)
	sess := s.session(p.SessionID)
	if sess == nil {
		return nil, errorf(codeInvalidParams, "no session %s", p.SessionID)
	}
	mode, ok := policy.ParseMode(p.ModeID)
	if !ok {
		return nil, errorf(codeInvalidParams, "no mode %q; modes are %s", p.ModeID, strings.Join(modeIDs, ", "))
	}
	sess.core.SetMode(mode)
	if c := sess.outside(); c != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := c.SetMode(ctx, mode); err != nil {
			return nil, errorf(codeInternal, "Claude Code did not change mode: %s", err.Error())
		}
	}
	return map[string]any{}, nil
}

func (s *Server) closeSession(params json.RawMessage) (any, error) {
	var p struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(params, &p)
	s.sessMu.Lock()
	sess := s.sessions[p.SessionID]
	delete(s.sessions, p.SessionID)
	s.sessMu.Unlock()
	if sess != nil {
		sess.close()
	}
	return map[string]any{}, nil
}

func (s *Server) steer(params json.RawMessage) (any, error) {
	var p struct {
		SessionID string `json:"sessionId"`
		Text      string `json:"text"`
	}
	_ = json.Unmarshal(params, &p)
	sess := s.session(p.SessionID)
	if sess == nil || strings.TrimSpace(p.Text) == "" {
		return map[string]any{"accepted": false}, nil
	}
	if c := sess.outside(); c != nil {
		return map[string]any{"accepted": c.Steer(p.Text)}, nil
	}
	return map[string]any{"accepted": sess.core.Steer(p.Text)}, nil
}

func (s *Server) setModel(ctx context.Context, params json.RawMessage) (any, error) {
	var p struct {
		SessionID string `json:"sessionId"`
		Provider  string `json:"provider"`
		Model     string `json:"model"`
	}
	_ = json.Unmarshal(params, &p)
	sess := s.session(p.SessionID)
	if sess == nil {
		return nil, errorf(codeInvalidParams, "no session %s", p.SessionID)
	}
	current := sess.core.Models().Selection()
	onClaude := current.Provider.Kind == llm.KindClaudeCode
	toClaude := strings.EqualFold(p.Provider, claude.Provider) || (p.Provider == "" && onClaude)
	switch {
	case toClaude && onClaude:
		if c := sess.outside(); c != nil {
			if err := c.SetModel(ctx, p.Model); err != nil {
				return nil, errorf(codeInvalidRequest, "%s", err.Error())
			}
		}
		if err := sess.core.SetModel(ctx, firstNonEmpty(p.Model, "default")); err != nil {
			return nil, errorf(codeInternal, "%s", err.Error())
		}
	case p.Provider == "" || p.Provider == current.Provider.ID:
		if err := sess.core.SetModel(ctx, p.Model); err != nil {
			return nil, errorf(codeInvalidRequest, "%s", err.Error())
		}
	default:
		if sess.core.Busy() {
			return nil, errorf(codeInvalidRequest, "switch providers between turns; esc stops this one")
		}
		env := s.env()
		sel, err := llm.Resolve(env, p.Provider, p.Model)
		if err != nil {
			return nil, errorf(codeInvalidRequest, "%s", err.Error())
		}
		models, err := llm.NewModels(ctx, sel, env, s.opts.Open)
		if err != nil {
			return nil, errorf(codeInvalidRequest, "%s", err.Error())
		}
		var next *claude.Session
		if toClaude {
			// Claude Code is started (and its sign-in checked) before anything changes: a
			// switch that cannot run leaves the session where it was.
			if next, err = s.openClaude(ctx, sess, sel.Model); err != nil {
				return nil, errorf(codeInvalidRequest, "%s", err.Error())
			}
		}
		if err := sess.core.UseModels(models); err != nil {
			if next != nil {
				next.Close()
			}
			return nil, errorf(codeInternal, "%s", err.Error())
		}
		previous := sess.outside()
		sess.setOutside(next)
		if previous != nil {
			previous.Close() // its conversation is kept by Claude Code, and resumed if it comes back
		}
	}
	return map[string]any{"_meta": map[string]any{"archymedes": s.info(sess)}}, nil
}

func (s *Server) command(params json.RawMessage) (any, error) {
	var p struct {
		SessionID string `json:"sessionId"`
		Command   string `json:"command"`
		Argument  string `json:"argument"`
	}
	_ = json.Unmarshal(params, &p)
	sess := s.session(p.SessionID)
	if sess == nil {
		return nil, errorf(codeInvalidParams, "no session %s", p.SessionID)
	}
	if c := sess.outside(); c != nil {
		return c.Command(p.Command, p.Argument), nil
	}
	if c, ok := sessionCommandByName[p.Command]; ok {
		return c.run(sess, p.Argument), nil
	}
	return map[string]any{"kind": "error", "text": fmt.Sprintf("/%s is not in the Go engine yet. To use it, set Settings → Engine to TypeScript (or ARCHYMEDES_ENGINE=ts) and start a new session", p.Command)}, nil
}

// toolsText lists the tools of the session's mode, each with what it may change and whether it asks.
func toolsText(tools []*tool.Tool, mode policy.Mode) string {
	var lines []string
	lines = append(lines, fmt.Sprintf("Tools in %s mode:", mode))
	for _, t := range tools {
		var what string
		switch t.Effect {
		case tool.EffectNone:
			what = "changes nothing; never asks"
		case tool.EffectWorkspace:
			what = "changes the project; asks first"
			if t.EffectFor != nil {
				what = "read-only uses run unasked; the rest ask first"
			}
			if mode == policy.Auto {
				what = "changes the project; asks only when risky"
			}
		default:
			what = "reaches outside the project; asks first"
		}
		name := t.Name
		if t.Deferred {
			name += " (found with tool_search)"
		}
		lines = append(lines, fmt.Sprintf("  %-34s %s", name, what))
	}
	return strings.Join(lines, "\n")
}

func threadsText(threads []thread.Thread) string {
	if len(threads) == 0 {
		return "No sub-agents in this session yet."
	}
	var lines []string
	for _, t := range threads {
		mode := "foreground"
		if t.Background {
			mode = "background"
		}
		line := fmt.Sprintf("%s  %-8s %-10s %-10s %s", t.ID, t.Role, t.Status, mode, firstLine(t.Brief))
		if t.Branch != "" {
			line += "  (branch " + t.Branch + ")"
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func firstLine(text string) string {
	line := strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	if r := []rune(line); len(r) > 60 {
		line = string(r[:59]) + "…"
	}
	return line
}

func (s *Server) threads(params json.RawMessage) (any, error) {
	var p struct {
		SessionID string `json:"sessionId"`
	}
	_ = json.Unmarshal(params, &p)
	sess := s.session(p.SessionID)
	if sess == nil {
		return nil, errorf(codeInvalidParams, "no session %s", p.SessionID)
	}
	return map[string]any{"threads": sess.core.Threads()}, nil
}

func (s *Server) sessionList(params json.RawMessage) (any, error) {
	var p struct {
		Cwd string `json:"cwd"`
	}
	_ = json.Unmarshal(params, &p)
	out := []any{}
	for _, summary := range thread.List(firstNonEmpty(p.Cwd, s.opts.Cwd), 50) {
		out = append(out, map[string]any{"id": summary.ID, "title": summary.Title, "updatedAt": summary.UpdatedAt.UnixMilli(), "openElsewhere": false})
	}
	return out, nil
}

func (s *Server) startup(ctx context.Context, params json.RawMessage) (any, error) {
	var notices []string
	if s.opts.Forward != nil {
		if raw, err := s.opts.Forward(ctx, "_archymedes/startup", params); err == nil {
			var more struct {
				Notices []string `json:"notices"`
			}
			if json.Unmarshal(raw, &more) == nil {
				notices = append(notices, more.Notices...)
			}
		}
	}
	if notices == nil {
		notices = []string{}
	}
	return map[string]any{"notices": notices}, nil
}

func (s *Server) setupStatus(ctx context.Context, params json.RawMessage) (any, error) {
	if s.opts.Forward != nil {
		if raw, err := s.opts.Forward(ctx, "_archymedes/setup/status", params); err == nil {
			return raw, nil
		}
	}
	env := s.env()
	_, err := llm.Resolve(env, s.opts.Provider, s.opts.Model)
	var providers []any
	for _, p := range llm.Providers {
		if p.Kind == llm.KindUnsupported {
			continue
		}
		key := ""
		if len(p.Requires) == 1 {
			key = p.Requires[0]
		}
		providers = append(providers, map[string]any{"id": p.ID, "label": p.Label, "keyVariable": key, "keyUrl": "", "configured": len(llm.Missing(p, env)) == 0})
	}
	status := map[string]any{"configured": err == nil, "providers": providers}
	if err != nil {
		status["reason"] = err.Error()
	}
	return status, nil
}

func (s *Server) models(ctx context.Context, params json.RawMessage) (any, error) {
	env := s.env()
	if s.opts.Forward != nil {
		if raw, err := s.opts.Forward(ctx, "_archymedes/models", params); err == nil {
			return unlockClaude(raw, env.Get), nil
		}
	}
	choices := []any{}
	for _, p := range llm.Configured(env) {
		if p.Kind == llm.KindUnsupported {
			continue
		}
		sel, err := llm.Resolve(env, p.ID, "")
		if err != nil {
			continue
		}
		choices = append(choices, map[string]any{"provider": p.ID, "providerLabel": p.Label, "model": sel.Model, "isDefault": true, "free": p.ID == "free"})
	}
	choices = append(choices, claudeChoices(env.Get)...)
	return map[string]any{"choices": choices, "unconfigured": []any{}, "errors": []any{}}, nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

// suggest weighs the completions the interface found for what is being typed: each option's
// probability, and none's, by Jev. Without a judge, or when it cannot answer in time, the reply
// is {"ranked": false} and the interface keeps its own order.
func (s *Server) suggest(ctx context.Context, params json.RawMessage) map[string]any {
	var p struct {
		Input   string   `json:"input"`
		Options []string `json:"options"`
	}
	_ = json.Unmarshal(params, &p)
	env := s.env()
	if strings.EqualFold(env.Get("ARCHYMEDES_SUGGEST"), "off") {
		return map[string]any{"ranked": false}
	}
	scores, none, err := advise.Pick(ctx, advise.NewJev(env.Get), p.Input, p.Options)
	if err != nil {
		return map[string]any{"ranked": false}
	}
	return map[string]any{"ranked": true, "scores": scores, "none": none}
}
