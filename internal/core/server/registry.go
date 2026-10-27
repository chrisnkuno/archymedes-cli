package server

import (
	"context"
	"encoding/json"
	"fmt"
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
