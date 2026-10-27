package server

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/chrisnkuno/friday-cli/internal/core/checkpoint"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/settings"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The engine's protocol surface, as two tables: every method it answers, and every session
// command. They are the single source for dispatch and for the conformance test that holds each
// row to the standard and to the protocol reference (docs/engine/PROTOCOL.md).

// method is one ACP method. handle is nil for the two the reading goroutine answers itself:
// session/prompt (accepted in arrival order) and session/cancel (a notification).
type method struct {
	name   string
	does   string
	handle func(s *Server, ctx context.Context, params json.RawMessage) (any, error)
}

var methods []method

// methodByName indexes methods.
var methodByName = map[string]method{}

// forwarded are the methods the TypeScript agent answers while this engine does not: providers
// and setup, which only read and write the shared settings file (ported in WS-50.3).
var forwarded = map[string]bool{
	"_archymedes/providers/models":         true,
	"_archymedes/providers/remember-model": true, "_archymedes/setup/save": true,
}

func init() {
	methods = []method{
		{"initialize", "Agree the protocol version, and whether the client wants events and questions", func(s *Server, _ context.Context, p json.RawMessage) (any, error) { return s.initialize(p), nil }},
		{"authenticate", "Accept and do nothing: keys come from settings", func(*Server, context.Context, json.RawMessage) (any, error) { return map[string]any{}, nil }},
		{"session/new", "Open a session in a folder, on the provider and model the settings choose", func(s *Server, ctx context.Context, p json.RawMessage) (any, error) {
			return s.newSession(ctx, p, false)
		}},
		{"session/load", "Reopen a session, replay its conversation and resume its sub-agents", func(s *Server, ctx context.Context, p json.RawMessage) (any, error) {
			return s.newSession(ctx, p, true)
		}},
		{"session/prompt", "Run one turn, after every prompt sent before it, and say how it ended", nil},
		{"session/cancel", "Stop the running turn and every prompt sent before this", nil},
		{"session/set_mode", "Change what the session may do, keeping standing approvals", func(s *Server, _ context.Context, p json.RawMessage) (any, error) { return s.setMode(p) }},
		{"session/close", "Stop the session; background sub-agents pause until it is reopened", func(s *Server, _ context.Context, p json.RawMessage) (any, error) { return s.closeSession(p) }},
		{"_archymedes/session/steer", "Hand text to the running turn, read at its next step", func(s *Server, _ context.Context, p json.RawMessage) (any, error) { return s.steer(p) }},
		{"_archymedes/session/set_model", "Switch the model, or the provider, keeping the conversation", func(s *Server, ctx context.Context, p json.RawMessage) (any, error) { return s.setModel(ctx, p) }},
		{"_archymedes/session/command", "Run a session command such as todos, tools, compact or subagents", func(s *Server, _ context.Context, p json.RawMessage) (any, error) { return s.command(p) }},
		{"_archymedes/threads", "List the session's sub-agents as stored", func(s *Server, _ context.Context, p json.RawMessage) (any, error) { return s.threads(p) }},
		{"_archymedes/sessions", "List a folder's sessions, newest first", func(s *Server, _ context.Context, p json.RawMessage) (any, error) { return s.sessionList(p) }},
		{"_archymedes/startup", "Say what the startup check found, such as an update", func(s *Server, ctx context.Context, p json.RawMessage) (any, error) { return s.startup(ctx, p) }},
		{"_archymedes/setup/status", "Say whether a provider is ready, and which could be", func(s *Server, ctx context.Context, p json.RawMessage) (any, error) { return s.setupStatus(ctx, p) }},
		{"_archymedes/suggest", "Weigh the completions offered for a request being typed, when Jev is set up", func(s *Server, ctx context.Context, p json.RawMessage) (any, error) { return s.suggest(ctx, p), nil }},
		{"_archymedes/settings/list", "List every setting with its value, secrets masked", func(s *Server, _ context.Context, _ json.RawMessage) (any, error) { return s.settingsList(), nil }},
		{"_archymedes/settings/set", "Save one setting, or clear it with an empty value", func(s *Server, _ context.Context, p json.RawMessage) (any, error) { return s.settingsSet(p), nil }},
		{"_archymedes/providers", "List every provider, what it needs and whether it is ready", func(s *Server, ctx context.Context, p json.RawMessage) (any, error) { return s.providers(ctx, p) }},
		{"_archymedes/providers/connect", "Check and save what a provider needs, and list its models", func(s *Server, ctx context.Context, p json.RawMessage) (any, error) { return s.connectProvider(ctx, p) }},
		{"_archymedes/models", "List the models the session can switch to", func(s *Server, ctx context.Context, p json.RawMessage) (any, error) { return s.models(ctx, p) }},
	}
	for _, m := range methods {
		methodByName[m.name] = m
	}
	for _, c := range sessionCommands {
		sessionCommandByName[c.name] = c
	}
	for _, alias := range []string{"threads", "agents"} {
		sessionCommandByName[alias] = sessionCommandByName["subagents"]
	}
}

// sessionCommand is one `_archymedes/session/command` the engine answers. Its reply's kind is one
// the interface renders: text, todos or error.
type sessionCommand struct {
	name string
	does string
	run  func(sess *session, argument string) map[string]any
}

// commandKinds are the reply kinds the interface renders (internal/acp CommandResult).
var commandKinds = map[string]bool{"text": true, "todos": true, "diff": true, "turns": true, "review": true, "forked": true, "goal": true, "error": true}

var sessionCommandByName = map[string]sessionCommand{}

var sessionCommands = []sessionCommand{
	{"todos", "The checklist for the task: what is done, doing and left", func(sess *session, _ string) map[string]any {
		items := sess.core.Todos()
		if len(items) == 0 {
			return map[string]any{"kind": "text", "text": "No plan yet"}
		}
		var out []any
		for _, item := range items {
			out = append(out, map[string]any{"text": item.Text, "status": item.Status})
		}
		return map[string]any{"kind": "todos", "items": out}
	}},
	{"tools", "Every tool in this mode, what it may change, and whether it asks", func(sess *session, _ string) map[string]any {
		return map[string]any{"kind": "text", "text": toolsText(sess.core.Tools(), sess.core.Mode())}
	}},
	{"compact", "Summarize the conversation now, keeping what the argument names", func(sess *session, focus string) map[string]any {
		before, after, err := sess.core.Summarize(context.Background(), focus)
		if err != nil {
			return map[string]any{"kind": "error", "text": err.Error()}
		}
		return map[string]any{"kind": "text", "text": fmt.Sprintf("Compacted the conversation: %d → %d messages", before, after)}
	}},
	{"cost", "What this session's model calls used: tokens in, from cache and out, with each sub-agent", func(sess *session, _ string) map[string]any {
		return map[string]any{"kind": "text", "text": costText(sess.core.Meta(), sess.core.Threads())}
	}},
	{"profile", "List the profiles, or choose one (none to clear) for the sessions that follow", func(sess *session, arg string) map[string]any {
		return profileCommand(sess.server, strings.TrimSpace(arg))
	}},
	{"btw", "Answer a side question from the conversation so far, without tools, even mid-turn", func(sess *session, question string) map[string]any {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		answer, err := sess.core.Aside(ctx, question)
		if err != nil {
			return map[string]any{"kind": "error", "text": err.Error()}
		}
		return map[string]any{"kind": "text", "text": answer}
	}},
	{"undo", "Go back to before the last turn: its files and the conversation, or only code or conversation", func(sess *session, arg string) map[string]any {
		return back(sess, -1, arg, "/undo takes no argument, code or conversation")
	}},
	{"rewind", "Go back to before turn N (from turns), with code or conversation to restore only that", func(sess *session, arg string) map[string]any {
		fields := strings.Fields(arg)
		index, err := strconv.Atoi(firstOf(fields))
		if err != nil || index < 0 || len(fields) > 2 {
			return map[string]any{"kind": "error", "text": "/rewind takes a turn number (see the turns list) and optionally code or conversation"}
		}
		return back(sess, index, strings.Join(fields[1:], " "), "/rewind takes a turn number and optionally code or conversation")
	}},
	{"turns", "The turns that can be gone back to, each with its request", func(sess *session, _ string) map[string]any {
		turns := []map[string]any{}
		for i, c := range sess.core.Turns() {
			turns = append(turns, map[string]any{"index": i, "label": c.Label, "createdAt": c.CreatedAt.UnixMilli()})
		}
		return map[string]any{"kind": "turns", "turns": turns}
	}},
	{"diff", "What changed since your last message, as a patch; stat for a summary, turn N for one turn", func(sess *session, arg string) map[string]any {
		ctx := context.Background()
		arg = strings.TrimSpace(arg)
		if rest, ok := strings.CutPrefix(arg, "turn"); ok {
			index, err := strconv.Atoi(strings.TrimSpace(rest))
			if err != nil {
				return map[string]any{"kind": "error", "text": "/diff turn takes a turn number"}
			}
			patch, err := sess.core.TurnPatch(ctx, index)
			switch {
			case err != nil:
				return map[string]any{"kind": "error", "text": err.Error()}
			case strings.TrimSpace(patch) == "":
				return map[string]any{"kind": "text", "text": "That turn changed no files."}
			}
			return map[string]any{"kind": "diff", "patch": patch}
		}
		patch, err := sess.core.Diff(ctx, arg == "stat")
		switch {
		case err != nil:
			return map[string]any{"kind": "error", "text": err.Error()}
		case strings.TrimSpace(patch) == "":
			return map[string]any{"kind": "text", "text": "Nothing changed since your last message."}
		case arg == "stat":
			return map[string]any{"kind": "text", "text": strings.TrimRight(patch, "\n")}
		}
		return map[string]any{"kind": "diff", "patch": patch}
	}},
	{"hooks", "The hooks that run for this project: event, which tools, command, and where declared", func(sess *session, _ string) map[string]any {
		return map[string]any{"kind": "text", "text": hooksText(sess.core.HookSet())}
	}},
	{"mcp", "The MCP servers declared for this project: tools, whether running, and any problem", func(sess *session, _ string) map[string]any {
		return map[string]any{"kind": "text", "text": mcpText(sess.core.MCP())}
	}},
	{"skills", "The skills found for this project: name, where from, what each is for", func(sess *session, _ string) map[string]any {
		found, problems := sess.core.Skills()
		return map[string]any{"kind": "text", "text": skillsText(found, problems)}
	}},
	{"subagents", "The session's sub-agents: role, status, tokens, brief and branch", func(sess *session, _ string) map[string]any {
		return map[string]any{"kind": "text", "text": threadsText(sess.core.Threads())}
	}},
}

// back is /undo and /rewind: the checkpoint gone back to, and what was restored.
func back(sess *session, index int, scopeWord, usage string) map[string]any {
	scope := checkpoint.Both
	switch strings.TrimSpace(scopeWord) {
	case "":
	case "code":
		scope = checkpoint.Code
	case "conversation":
		scope = checkpoint.Conversation
	default:
		return map[string]any{"kind": "error", "text": usage + ", not " + strconv.Quote(scopeWord)}
	}
	if index < 0 && len(sess.core.Turns()) == 0 {
		return map[string]any{"kind": "text", "text": "Nothing to undo."}
	}
	c, conversation, err := sess.core.Back(context.Background(), index, scope)
	if err != nil {
		return map[string]any{"kind": "error", "text": err.Error()}
	}
	what := "the files and the conversation"
	switch {
	case scope == checkpoint.Code:
		what = "the files"
	case scope == checkpoint.Conversation && conversation:
		what = "the conversation"
	case scope == checkpoint.Conversation:
		return map[string]any{"kind": "text", "text": "The conversation was summarized since \"" + c.Label + "\", so only the files can go back to it."}
	case !conversation:
		what = "the files (the conversation was summarized since, so it stays)"
	}
	return map[string]any{"kind": "text", "text": "Went back to before \"" + c.Label + "\": " + what + "."}
}

func firstOf(fields []string) string {
	if len(fields) == 0 {
		return ""
	}
	return fields[0]
}

// profileCommand is /profile: the profiles and which is active, or a switch for later sessions.
func profileCommand(s *Server, name string) map[string]any {
	dir := s.opts.ConfigDir
	active := s.env().Get("ARCHYMEDES_PROFILE")
	fromShell := false
	for _, kv := range s.opts.Environ {
		if k, v, ok := strings.Cut(kv, "="); ok && k == "ARCHYMEDES_PROFILE" && strings.TrimSpace(v) != "" {
			fromShell = true
		}
	}
	profiles := llm.Profiles(dir)
	if name == "" {
		if len(profiles) == 0 {
			return map[string]any{"kind": "text", "text": "No profiles yet. A profile is a file of settings, " + llm.ProfileFile(dir, "<name>") + ", laid over your settings while it is active: other keys, another provider or model, CLAUDE_CONFIG_DIR for another Claude account. /profile <name> chooses one."}
		}
		var lines []string
		for _, p := range profiles {
			mark := "  "
			if p == active {
				mark = "● "
			}
			lines = append(lines, mark+p)
		}
		lines = append(lines, "/profile <name> chooses one for the sessions that follow; /profile none clears it.")
		return map[string]any{"kind": "text", "text": strings.Join(lines, "\n")}
	}
	value := name
	if name == "none" || name == "off" {
		value = ""
	} else if !slices.Contains(profiles, name) {
		return map[string]any{"kind": "error", "text": "No profile named " + name + " (" + llm.ProfileFile(dir, name) + "). The profiles are: " + strings.Join(profiles, ", ") + "."}
	}
	if r := settings.Set(dir, "ARCHYMEDES_PROFILE", value); !r.OK {
		return map[string]any{"kind": "error", "text": r.Error}
	}
	text := "Profile " + name + " from the next session (/new opens one now)."
	if value == "" {
		text = "No profile from the next session (/new opens one now)."
	}
	if fromShell {
		text += " ARCHYMEDES_PROFILE is set in your shell, and it wins over this until you unset it."
	}
	return map[string]any{"kind": "text", "text": text}
}
