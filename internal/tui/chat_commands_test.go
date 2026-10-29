package tui

import (
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestBackgroundCommandsReachTheRailAndFollowTheirState(t *testing.T) {
	m := railModel(t, 140)
	m.phase = busy
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "b1", ToolName: "run_command", Arguments: map[string]any{"command": "npm run dev", "background": true}}))
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "b1", ToolName: "run_command",
		Content: "Started cmd1 in the background (pid 42): npm run dev\ncmd1 running · 2s · 120 bytes\nlistening on :3000\n[next: since=120]"}))
	s := screen(m)
	for _, want := range []string{"cmd1 running in the background", "Commands", "1 running", "cmd1 npm run dev · running", "⎿ listening on :3000"} {
		if !strings.Contains(s, want) {
			t.Errorf("screen lacks %q:\n%s", want, s)
		}
	}
	// A sub-agent stops it; the rail follows, and the last line is no longer shown.
	m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"task": "stop the server"}}))
	m.handleEvent(subagentEvent("d1", "general", acp.RuntimeEvent{Type: "tool_call", ToolCallID: "s1", ToolName: "stop_command", Arguments: map[string]any{"id": "cmd1"}}))
	m.handleEvent(subagentEvent("d1", "general", acp.RuntimeEvent{Type: "tool_result", ToolCallID: "s1", ToolName: "stop_command", Content: "Stopped. cmd1 stopped · 4.1s · 120 bytes"}))
	if c := m.command("cmd1"); c.status != "stopped" || m.runningCommands() != 0 {
		t.Fatalf("stop_command from a sub-agent should end the command: %+v", c)
	}
	if s := screen(m); !strings.Contains(s, "0 running") || strings.Contains(s, "⎿ listening") {
		t.Errorf("a stopped command shows as ended:\n%s", s)
	}
}

func TestAForegroundCommandIsNotABackgroundOne(t *testing.T) {
	m := railModel(t, 140)
	m.noteCommands("run_command", map[string]any{"command": "echo cmd1 running"}, "exit 0\ncmd1 running · fake")
	if len(m.rail.commands) != 0 {
		t.Fatal("only a result that says it started one adds a background command")
	}
}

func TestCommandOutputKeepsTheLastLinePrinted(t *testing.T) {
	m := railModel(t, 140)
	m.noteCommands("command_output", map[string]any{"id": "cmd3"}, "cmd3 running · 5s · 900 bytes\nbuilding…\ncompiled 12 files\n\n[next: since=900]")
	m.noteCommands("command_output", map[string]any{"id": "cmd3"}, "cmd3 running · 6s · 900 bytes\n(no new output)\n[next: since=900]")
	if c := m.command("cmd3"); c.last != "compiled 12 files" {
		t.Fatalf("a read with nothing new keeps the last line printed: %q", c.last)
	}
	m.noteCommands("list_commands", nil, "cmd3 exited 0 · 9s · 950 bytes · make all\ncmd4 failed: no such dir · 0s · 0 bytes · cd x")
	if c := m.command("cmd4"); c.command != "cd x" || c.status != "failed" {
		t.Fatalf("list_commands names a command not seen started: %+v", c)
	}
	if got := len(m.railCommands()); got != 2 {
		t.Fatalf("rail lists %d commands", got)
	}
}
