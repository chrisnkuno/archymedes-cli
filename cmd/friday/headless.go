package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/cli"
	"github.com/chrisnkuno/friday-cli/internal/core/server"
)

// Friday from a script: one request, one turn, the answer on stdout. `friday "request"` with no
// terminal, or `friday --print "request"` with one (-p is plan mode); --json (or --headless) writes one JSON object per
// line instead, for another program to read. Nobody can answer an approval here, so a call that
// would ask is refused and the model is told so: --auto (or a command rule) lets more run.

// stillTypeScript are the non-interactive modes the TypeScript agent still answers (WS-50.6).
var stillTypeScript = []string{"--doctor", "--update", "--check-update", "--settings", "--providers", "--sessions", "--estimate", "--acp"}

// scriptedRun reads a command line as a scripted run, if it is one the Go engine can serve: no
// subcommand, none of the modes still served by TypeScript.
func scriptedRun(args []string, interactive bool) (inv cli.Invocation, asJSON, ok bool) {
	var rest []string
	print := false
	for _, a := range args {
		switch {
		case a == "--json" || a == "--headless":
			asJSON = true
		case a == "--print":
			print = true
		default:
			rest = append(rest, a)
		}
	}
	for _, a := range rest {
		name, _, _ := strings.Cut(a, "=")
		if slices.Contains(stillTypeScript, name) {
			return inv, false, false
		}
	}
	if len(rest) > 0 && slices.Contains([]string{"acp", "bridge", "login", "logout", "account", "keys", "update", "settings", "history", "doctor"}, rest[0]) {
		return inv, false, false
	}
	if interactive && !asJSON && !print {
		return inv, false, false // a terminal and no -p: the interface
	}
	return cli.Parse(rest, true), asJSON, true
}

// runScripted runs the turn and writes it out. Exit 0 when it completed, 1 when it failed or got
// stuck, 2 when it could not start, 130 when interrupted.
func runScripted(inv cli.Invocation, asJSON bool, opts server.Options, ts *lazyAgent, stdin io.Reader, stdout, stderr io.Writer) int {
	prompt := strings.TrimSpace(inv.Prompt)
	if prompt == "" && stdin != nil {
		data, _ := io.ReadAll(io.LimitReader(stdin, 1<<20))
		prompt = strings.TrimSpace(string(data))
	}
	if prompt == "" {
		fmt.Fprintln(stderr, `friday: no request: give it as words (friday --print "fix the failing test") or on stdin`)
		return 2
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	agent, err := startGoEngine(opts, ts)(ctx)
	if err != nil {
		fmt.Fprintln(stderr, "friday:", err)
		return 2
	}
	defer agent.Close()
	sess, err := agent.NewSession(ctx, opts.Cwd, inv.Resume)
	if err != nil {
		fmt.Fprintln(stderr, "friday:", err)
		return 2
	}
	defer agent.CloseSession(context.Background(), sess.ID)

	out := json.NewEncoder(stdout)
	emit := func(v map[string]any) {
		if asJSON {
			_ = out.Encode(v)
		}
	}
	emit(map[string]any{"type": "session", "id": sess.ID, "provider": sess.Info.Provider, "model": sess.Info.Model, "mode": sess.Info.Mode})

	var text, step strings.Builder
	// flush sends a step's text as one line: a JSON reader wants sentences, not stream fragments.
	flush := func() {
		if step.Len() > 0 {
			emit(map[string]any{"type": "text", "text": step.String()})
			step.Reset()
		}
	}
	var usage acp.Usage
	status, summary := "", ""
	done := make(chan string, 1)
	go func() {
		stopReason, err := agent.Prompt(ctx, sess.ID, prompt)
		if err != nil && stopReason == "" {
			summary = err.Error()
			stopReason = "error"
		}
		done <- stopReason
	}()
	var stopReason string
loop:
	for {
		select {
		case <-ctx.Done():
			_ = agent.Cancel(sess.ID)
			stopReason = <-done
			status = "cancelled"
			break loop
		case stopReason = <-done:
			break loop
		case msg, open := <-agent.Messages():
			if !open {
				stopReason = <-done
				break loop
			}
			switch m := msg.(type) {
			case acp.TextChunk:
				text.WriteString(m.Text)
				step.WriteString(m.Text)
			case acp.PermissionRequest:
				// Nobody to ask: refused, and the model is told why.
				m.Answer("deny")
				emit(map[string]any{"type": "refused", "title": m.ToolCall.Title, "why": "no one to approve it in a scripted run"})
				if !asJSON {
					fmt.Fprintf(stderr, "  ✗ refused (nobody to approve): %s; --auto or a command rule allows more\n", m.ToolCall.Title)
				}
			case acp.QuestionRequest:
				m.Answer("")
				emit(map[string]any{"type": "question_skipped", "question": m.Question})
			case acp.AgentEvent:
				ev := m.Event
				if ev.Type != "runtime" || ev.Event == nil {
					continue
				}
				r := ev.Event
				switch r.Type {
				case "tool_call":
					flush()
					emit(map[string]any{"type": "tool_call", "id": r.ToolCallID, "tool": r.ToolName, "arguments": r.Arguments})
					if !asJSON {
						fmt.Fprintf(stderr, "  · %s\n", describe(r.ToolName, r.Arguments))
					}
				case "tool_result":
					emit(map[string]any{"type": "tool_result", "id": r.ToolCallID, "tool": r.ToolName, "is_error": r.IsError, "content": r.Content})
				case "model_turn":
					flush()
					if r.Usage != nil {
						usage.InputTokens += r.Usage.InputTokens
						usage.OutputTokens += r.Usage.OutputTokens
						usage.CachedInputTokens += r.Usage.CachedInputTokens
					}
				case "runtime_stop":
					status, summary = r.Status, firstNonEmpty(r.Summary, summary)
				}
			}
		}
	}
	flush()
	if status == "" {
		status = map[string]string{"end_turn": "completed", "cancelled": "cancelled", "max_turn_requests": "budget"}[stopReason]
		if status == "" {
			status = "failed"
		}
	}
	// The run's final words, not every step's text run together (a verification pass speaks too).
	answer := strings.TrimSpace(summary)
	if answer == "" {
		answer = strings.TrimSpace(text.String())
	}
	emit(map[string]any{"type": "result", "status": status, "text": answer, "session": sess.ID,
		"usage": map[string]any{"input_tokens": usage.InputTokens, "cached_input_tokens": usage.CachedInputTokens, "output_tokens": usage.OutputTokens}})
	if !asJSON {
		fmt.Fprintln(stdout, answer)
		if status != "completed" {
			fmt.Fprintf(stderr, "friday: the turn ended %s\n", status)
		}
	}
	switch status {
	case "completed":
		return 0
	case "cancelled":
		return 130
	}
	return 1
}

// describe is a tool call in a few words, for the progress lines on stderr.
func describe(name string, args map[string]any) string {
	label := strings.ReplaceAll(name, "_", " ")
	for _, key := range []string{"path", "command", "pattern", "query"} {
		if v, ok := args[key].(string); ok && v != "" {
			if r := []rune(v); len(r) > 80 {
				v = string(r[:79]) + "…"
			}
			return label + " " + v
		}
	}
	return label
}
