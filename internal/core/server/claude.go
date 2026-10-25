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
	sdkOnly := func(missing any) bool {
		list, _ := missing.([]any)
		for _, m := range list {
			if text, _ := m.(string); !strings.Contains(text, "Agent SDK") {
				return false
			}
		}
		return len(list) > 0
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
