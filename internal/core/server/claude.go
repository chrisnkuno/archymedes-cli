package server

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/claude"
	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

// A session on the `claude` provider is run by the person's own Claude Code (internal/core/claude)
// instead of the engine's loop. The engine still owns the session: its id, its place-in-line for
// prompts, cancel, the transcript and the approvals, so switching between Claude and Friday's own
// models keeps the conversation in both directions.

// outside is the Claude Code running this session, or nil when Friday's own loop runs it.
func (sess *session) outside() *claude.Session {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return sess.claude
}

func (sess *session) setOutside(c *claude.Session) {
	sess.mu.Lock()
	defer sess.mu.Unlock()
	sess.claude = c
}

// close stops the session, and Claude Code with it.
func (sess *session) close() {
	sess.core.Close()
	if c := sess.outside(); c != nil {
		c.Close()
	}
}

// openClaude starts Claude Code for a session, told what was said that it has not seen.
func (s *Server) openClaude(ctx context.Context, sess *session, model string) (*claude.Session, error) {
	meta, messages := sess.core.Meta(), sess.core.Messages()
	preface := claude.Preface(messages)
	if meta.ClaudeSession != "" {
		seen, ok := meta.EngineSeen[claude.Provider]
		if !ok {
			seen = len(messages) // recorded before EngineSeen existed: seen in full
		}
		preface = claude.Since(messages, seen)
	}
	opts := claude.Options{
		Root: sess.cwd, Executable: claude.Find(sess.env.Get), Environ: claude.Environment(s.opts.Environ),
		Mode: sess.core.Mode(), Model: model, Resume: meta.ClaudeSession, Preface: preface,
		Transcript: func() string { return claude.Preface(sess.core.Messages()) },
		TestFirst:  gate.TestFirstFromEnv(sess.env.Get),
		Rules:      policy.LoadCommandRules(sess.cwd, s.opts.ConfigDir).Rules,
		Effort:     func() string { return s.env().Get("ARCHYMEDES_REASONING") },
		Notify:     func(n agents.Notice) { s.publish(sess.id, n) },
		Approve: func(ctx context.Context, r policy.Request) (policy.Decision, error) {
			return s.askPermission(ctx, sess.id, r)
		},
	}
	if s.questions.Load() {
		opts.Ask = func(ctx context.Context, question string, options []string, multi bool) (string, error) {
			return s.askQuestion(ctx, sess.id, question, options, multi)
		}
	}
	return claude.Open(ctx, opts)
}

// claudeTurn runs one accepted prompt on Claude Code, then records what Claude has now seen.
func (s *Server) claudeTurn(ctx context.Context, p acceptedPrompt, c *claude.Session) loop.Result {
	result := p.sess.core.Outside(ctx, p.accepted, p.text, func(ctx context.Context) agents.OutsideTurn { return c.Turn(ctx, p.text) })
	seen, id := len(p.sess.core.Messages()), c.ClaudeSession()
	_ = p.sess.core.UpdateMeta(func(m *thread.Meta) {
		m.ClaudeSession = id
		if m.EngineSeen == nil {
			m.EngineSeen = map[string]int{}
		}
		m.EngineSeen[claude.Provider] = seen
	})
	return result
}

// claudeChoices are Claude Code's models for the model picker, when it is installed.
func claudeChoices(get func(string) string) []any {
	if claude.Find(get) == "" {
		return nil
	}
	preferred := firstNonEmpty(get("CLAUDE_MODEL"), "default")
	var out []any
	for _, m := range claude.Models() {
		out = append(out, map[string]any{"provider": claude.Provider, "providerLabel": claude.Label, "model": m, "isDefault": m == preferred,
			"price": "your Claude plan", "free": false, "small": m == "haiku"})
	}
	return out
}

// sdkOnly says a TypeScript readiness answer lacks nothing but Anthropic's Agent SDK. The
// TypeScript agent checks the sign-in first, so such an answer also means signed in.
func sdkOnly(missing any) bool {
	list, _ := missing.([]any)
	for _, m := range list {
		if text, _ := m.(string); !strings.Contains(text, "Agent SDK") {
			return false
		}
	}
	return len(list) > 0
}

// unlockClaude opens Claude's rows in the TypeScript agent's model list when all they lack is
// Anthropic's Agent SDK: the TypeScript engine drives Claude Code through it, this engine does not.
func unlockClaude(raw json.RawMessage, get func(string) string) json.RawMessage {
	if claude.Find(get) == "" {
		return raw
	}
	var listing map[string]any
	if json.Unmarshal(raw, &listing) != nil {
		return raw
	}
	changed := false
	choices, _ := listing["choices"].([]any)
	for _, entry := range choices {
		if c, ok := entry.(map[string]any); ok && c["provider"] == claude.Provider && c["locked"] == true && sdkOnly(c["missing"]) {
			c["locked"], c["missing"], changed = false, []any{}, true
		}
	}
	if unconfigured, ok := listing["unconfigured"].([]any); ok {
		kept := unconfigured[:0]
		for _, entry := range unconfigured {
			if u, ok := entry.(map[string]any); ok && u["provider"] == claude.Provider && sdkOnly(u["missing"]) {
				changed = true
				continue
			}
			kept = append(kept, entry)
		}
		listing["unconfigured"] = kept
	}
	if !changed {
		return raw
	}
	return mustJSON(listing)
}

// providers answers `_archymedes/providers` from the TypeScript agent, with Claude's row as this
// engine sees it: ready when Claude Code is installed and signed in, whatever the Agent SDK.
func (s *Server) providers(ctx context.Context, params json.RawMessage) (any, error) {
	raw, err := s.forward(ctx, "_archymedes/providers", params)
	if err != nil || claude.Find(s.env().Get) == "" {
		return raw, err
	}
	var overview map[string]any
	if json.Unmarshal(raw, &overview) != nil {
		return raw, nil
	}
	rows, _ := overview["providers"].([]any)
	for _, entry := range rows {
		if row, ok := entry.(map[string]any); ok && row["id"] == claude.Provider && row["configured"] == false && sdkOnly(row["missing"]) {
			row["configured"], row["missing"] = true, []any{}
			return mustJSON(overview), nil
		}
	}
	return raw, nil
}

// connectProvider answers `_archymedes/providers/connect`. Claude is checked here, so choosing it
// never installs the Agent SDK this engine does not use; every other provider is forwarded.
func (s *Server) connectProvider(ctx context.Context, params json.RawMessage) (any, error) {
	var p struct {
		Provider string `json:"provider"`
	}
	_ = json.Unmarshal(params, &p)
	if !strings.EqualFold(p.Provider, claude.Provider) {
		return s.forward(ctx, "_archymedes/providers/connect", params)
	}
	executable := claude.Find(s.env().Get)
	if executable == "" {
		return map[string]any{"ok": false, "error": "Install Claude Code first: " + claude.InstallURL}, nil
	}
	auth, err := claude.SignedIn(ctx, executable, claude.Environment(s.opts.Environ))
	if err != nil || !auth.LoggedIn {
		return map[string]any{"ok": false, "error": "Sign in to Claude first: enter runs `claude auth login`, Claude Code's own sign-in."}, nil
	}
	return map[string]any{"ok": true, "file": "", "models": claude.Models()}, nil
}

// forward sends a method to the TypeScript agent, or says it is not there to answer.
func (s *Server) forward(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
	if s.opts.Forward == nil {
		return nil, errorf(codeMethodNotFound, "%s needs the TypeScript agent, which is not installed", method)
	}
	return s.opts.Forward(ctx, method, params)
}
