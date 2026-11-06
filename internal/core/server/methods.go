package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"path/filepath"
	"runtime"
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
	"github.com/chrisnkuno/friday-cli/internal/core/settings"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
	"github.com/chrisnkuno/friday-cli/internal/core/update"
)

// session is one ACP session: the engine's session and what the client is told about it.
type session struct {
	id   string
	cwd  string
	core *agents.Session
	env  llm.Env
	// server is the connection the session belongs to, for commands that read its options.
	server *Server

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
	caps := map[string]any{"loadSession": true, "promptCapabilities": map[string]any{"image": true, "audio": false, "embeddedContext": true}}
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
	sess := &session{id: core.ID(), cwd: cwd, core: core, env: env, server: s}
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
	info := map[string]any{
		"sessionId": sess.id, "provider": sel.Provider.ID, "providerLabel": sel.Provider.Label, "model": sel.Model,
		"mode": string(sess.core.Mode()), "root": sess.cwd, "workspace": "local", "workspaceLabel": "this computer", "engine": "go",
	}
	if profile := sess.env.Get("ARCHYMEDES_PROFILE"); profile != "" {
		info["profile"] = profile
	}
	if sess.outside() == nil {
		// The window compaction measures against, so the status line's % is the one that matters;
		// contextKnown is false when it is the assumed default rather than ARCHYMEDES_CONTEXT_LIMIT.
		info["contextLimit"] = llm.ContextLimit(sess.env)
		info["compactAt"] = loop.DefaultBudgets().CompactAt
		info["contextKnown"] = sess.env.Get("ARCHYMEDES_CONTEXT_LIMIT") != ""
	}
	return info
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
	files    []fantasy.FilePart // images attached to the request
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
	files, err := promptImages(p.Prompt)
	if err != nil {
		return acceptedPrompt{}, errorf(codeInvalidParams, "%v", err)
	}
	if strings.TrimSpace(text) == "" && len(files) == 0 {
		return acceptedPrompt{}, errorf(codeInvalidParams, "the prompt has no text")
	}
	if strings.TrimSpace(text) == "" {
		text = "(see the attached image)"
	}
	return acceptedPrompt{sess: sess, text: text, files: files, accepted: sess.core.Accept()}, nil
}

func (s *Server) prompt(ctx context.Context, p acceptedPrompt) (any, error) {
	var result loop.Result
	if c := p.sess.outside(); c != nil {
		result = s.claudeTurn(ctx, p, c)
	} else {
		result = p.sess.core.Prompt(ctx, p.accepted, p.text, p.files...)
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

// maxImageBytes is the most one attached image may be, and maxImages how many a request may carry.
const (
	maxImageBytes = 5 << 20
	maxImages     = 8
)

// promptImages are a prompt's image blocks (ACP: type image, mimeType, base64 data) as file parts.
func promptImages(blocks []json.RawMessage) ([]fantasy.FilePart, error) {
	var files []fantasy.FilePart
	for _, raw := range blocks {
		var b struct {
			Type     string `json:"type"`
			MimeType string `json:"mimeType"`
			Data     string `json:"data"`
			URI      string `json:"uri"`
		}
		if json.Unmarshal(raw, &b) != nil || b.Type != "image" {
			continue
		}
		if !strings.HasPrefix(b.MimeType, "image/") {
			return nil, fmt.Errorf("an attached image has type %q, not an image type", b.MimeType)
		}
		data, err := base64.StdEncoding.DecodeString(b.Data)
		if err != nil {
			return nil, fmt.Errorf("an attached image is not base64: %v", err)
		}
		if len(data) > maxImageBytes {
			return nil, fmt.Errorf("an attached image is %d MB; at most %d MB", len(data)>>20, maxImageBytes>>20)
		}
		if len(files) == maxImages {
			return nil, fmt.Errorf("at most %d images in one request", maxImages)
		}
		files = append(files, fantasy.FilePart{Filename: filepath.Base(b.URI), Data: data, MediaType: b.MimeType})
	}
	return files, nil
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
	info := s.info(sess)
	s.rememberModel(info)
	return map[string]any{"_meta": map[string]any{"archymedes": info}}, nil
}

// rememberModel keeps the model a session switched to as where the next one starts: the default
// provider and that provider's model, as Settings → Providers would. It is a convenience; a switch
// that cannot be remembered still happened.
func (s *Server) rememberModel(info map[string]any) {
	provider, _ := info["provider"].(string)
	model, _ := info["model"].(string)
	p, ok := llm.Lookup(provider)
	if !ok || s.opts.ConfigDir == "" {
		return
	}
	_ = settings.Remember(s.opts.ConfigDir, map[string]string{"ARCHYMEDES_PROVIDER": p.ID, p.Prefix() + "_MODEL": model})
}

// eitherEngine are the session commands whose own run handles a session Claude runs too.
var eitherEngine = map[string]bool{"spawn": true, "roles": true, "agent-stop": true, "agent-send": true}

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
	if c := sess.outside(); c != nil && !eitherEngine[p.Command] {
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
	// The startup upkeep is the engine's own (WS-50.5): nothing here starts the TypeScript agent.
	// The update check runs hourly and never installs from here: a session is open and is using the
	// files an install replaces. A newer version is announced, and installed when the interface
	// closes (update.AtExit). The defender feed is not refreshed here: only the TypeScript agent's
	// defender playbooks read it, and its startup (run when the interface talks to that agent)
	// refreshes it; the Go engine's defender mode uses its built-in playbooks (tools/defender.go).
	env := s.env()
	notices := update.Run(ctx, update.Options{
		Mode: update.ReadMode(env.Get), Interactive: true, CurrentVersion: s.opts.Version,
		ConfigDir: s.opts.ConfigDir, Getenv: env.Get,
		MoveAside: runtime.GOOS == "windows", // a running friday.exe cannot be overwritten there
	})
	s.cueOnce.Do(func() {
		// Once per process, never waited for; a development build is not an install.
		if s.opts.Version == "" || s.opts.Version == "dev" {
			return
		}
		go update.SendCue(context.Background(), update.CueOptions{
			Getenv: env.Get, ConfigDir: s.opts.ConfigDir, Version: s.opts.Version,
			OS: runtime.GOOS, Arch: runtime.GOARCH, Post: s.opts.Post,
		})
	})
	if notices == nil {
		notices = []string{}
	}
	return map[string]any{"notices": notices}, nil
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
