package server

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/claude"
	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
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
		Root: sess.cwd, Executable: claude.Find(sess.env.Get), Environ: claudeEnviron(s.opts.Environ, sess.env),
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

// claudeEnviron is the environment Claude Code runs in, with the profile's CLAUDE_CONFIG_DIR: a
// profile can be another Claude account, which Claude Code keeps in a config folder of its own.
func claudeEnviron(environ []string, env llm.Env) []string {
	out := claude.Environment(environ)
	if dir := env.Get("CLAUDE_CONFIG_DIR"); dir != "" {
		if rest, ok := strings.CutPrefix(dir, "~/"); ok { // a settings file has no shell to expand it
			if home, err := os.UserHomeDir(); err == nil {
				dir = filepath.Join(home, rest)
			}
		}
		out = append(out, "CLAUDE_CONFIG_DIR="+dir)
	}
	return out
}

// claudeHelper is /agent while Claude runs the session: the helper is a Claude Code of its own
// (claude.StartHelper). Read-only by default, since it shares the folder with this session's
// Claude; a writable role is named, and refused in plan mode.
func claudeHelper(sess *session, c *claude.Session, arg string) map[string]any {
	cannotWrite := ""
	if sess.core.Mode() == policy.Plan {
		cannotWrite = "plan mode changes nothing"
	}
	profile, brief, err := sess.core.HelperRole(arg, false, cannotWrite)
	if err == nil {
		var h claude.Helper
		h, err = c.StartHelper(claude.Role{Name: profile.Name, Instructions: profile.Instructions, ReadOnly: profile.ReadOnly}, brief)
		if err == nil {
			return map[string]any{"kind": "text", "text": fmt.Sprintf("Started %s helper %s on Claude Code in the background; → follows it, and its report reaches Claude with your next message", profile.Name, h.ID)}
		}
	}
	return map[string]any{"kind": "error", "text": "The helper could not start: " + err.Error()}
}
