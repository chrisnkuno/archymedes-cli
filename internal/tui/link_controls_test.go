package tui

import (
	"slices"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// The phone's many controls: Friday's own commands from a palette (only those that make sense from
// afar and change nothing on the computer's screen the person cannot see), the queue worked like at
// the terminal, helpers stopped and told things, and the page drawn in this session's theme.

func commandNames(state map[string]any) []string {
	var names []string
	for _, c := range state["commands"].([]any) {
		names = append(names, c.(map[string]any)["name"].(string))
	}
	return names
}

func TestThePhoneGetsTheThemeAndTheCommandsItMayRun(t *testing.T) {
	l := newLinked(t)
	state := l.hello(t)
	th, _ := state["session"].(map[string]any)["theme"].(map[string]any)
	for _, k := range []string{"primary", "accent", "bg", "surface", "text", "muted", "success", "warning", "error", "border"} {
		if s, _ := th[k].(string); !strings.HasPrefix(s, "#") {
			t.Fatalf("theme %s = %v", k, th[k])
		}
	}
	names := commandNames(state)
	for _, want := range []string{"compact", "cost", "diff", "retry", "continue", "review", "btw", "todos", "model", "agent", "commit", "context"} {
		if !slices.Contains(names, want) {
			t.Errorf("the palette lacks /%s: %v", want, names)
		}
	}
	for _, never := range []string{"quit", "exit", "key", "settings", "providers", "edit", "open", "theme", "copy", "select", "vim", "update", "phone", "wallpaper"} {
		if slices.Contains(names, never) {
			t.Errorf("the palette offers /%s, which belongs at the computer", never)
		}
	}
	for _, c := range state["commands"].([]any) {
		if help, _ := c.(map[string]any)["help"].(string); help == "" {
			t.Fatalf("a command without its help: %v", c)
		}
	}
}

func TestAFridayCommandFromThePhoneRunsAsTypedThere(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	for _, c := range []map[string]any{
		{"type": "slash", "command": "compact", "arg": "keep the parser plan"},
		{"type": "slash", "command": "diff"},
		{"type": "slash", "command": "todos"},
		{"type": "slash", "command": "model", "arg": "claude-opus-5"},
	} {
		if ack := l.ask(t, c); ack["ok"] != true {
			t.Fatalf("%v refused: %v", c, ack)
		}
	}
	got := sentCommands(l.agent)
	for _, want := range []string{"compact:keep the parser plan", "diff:", "todos:"} {
		if !slices.Contains(got, want) {
			t.Errorf("the engine was not asked %q: %v", want, got)
		}
	}
	l.agent.mu.Lock()
	models := slices.Clone(l.agent.models)
	l.agent.mu.Unlock()
	if len(models) != 1 || !strings.HasSuffix(models[0], "claude-opus-5") {
		t.Errorf("model not switched: %v", models)
	}
}

func TestACommandThePhoneMayNotRunIsRefused(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	for _, name := range []string{"quit", "exit", "key", "settings", "edit", "open", "theme", "phone", "nonsense", ""} {
		if ack := l.ask(t, map[string]any{"type": "slash", "command": name, "arg": "x"}); ack["ok"] != false {
			t.Fatalf("/%s accepted from the phone: %v", name, ack)
		}
	}
	if l.m.quitting || l.m.link == nil || len(l.m.windows) != 0 {
		t.Fatalf("a refused command acted: quitting %v, link %v, windows %d", l.m.quitting, l.m.link != nil, len(l.m.windows))
	}
}

func TestTheQueueIsWorkedFromThePhone(t *testing.T) {
	l := newLinked(t)
	l.agent.cannotSteer = true // Claude Code between its tools: the queue holds still meanwhile
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "go"})
	for _, text := range []string{"one", "two", "three"} {
		l.ask(t, map[string]any{"type": "send", "text": text})
	}
	ids := func() []string {
		var out []string
		for _, q := range l.m.queue {
			out = append(out, "q"+itoa(q.id))
		}
		return out
	}
	texts := func() string {
		var out []string
		for _, q := range l.m.queue {
			out = append(out, q.text)
		}
		return strings.Join(out, "|")
	}
	if ack := l.ask(t, map[string]any{"type": "queue", "item": ids()[2], "action": "up"}); ack["ok"] != true || texts() != "one|three|two" {
		t.Fatalf("up: %v, queue %s", ack, texts())
	}
	if ack := l.ask(t, map[string]any{"type": "queue", "item": ids()[0], "action": "down"}); ack["ok"] != true || texts() != "three|one|two" {
		t.Fatalf("down: %v, queue %s", ack, texts())
	}
	ack := l.ask(t, map[string]any{"type": "queue", "item": ids()[2], "action": "drop"})
	if ack["ok"] != true || texts() != "three|one" || !strings.Contains(ack["text"].(string), "two") {
		t.Fatalf("drop: %v, queue %s", ack, texts())
	}
	l.agent.mu.Lock()
	l.agent.cannotSteer = false
	l.agent.mu.Unlock()
	if ack := l.ask(t, map[string]any{"type": "queue", "item": ids()[0], "action": "send"}); ack["ok"] != true {
		t.Fatalf("send now: %v", ack)
	}
	l.pump(t, func() bool {
		l.agent.mu.Lock()
		defer l.agent.mu.Unlock()
		return slices.Contains(l.agent.steered, "three")
	}, "send now did not steer it into the turn")
	for _, bad := range []map[string]any{{"type": "queue", "item": "q999", "action": "drop"}, {"type": "queue", "item": ids()[0], "action": "explode"}} {
		if ack := l.ask(t, bad); ack["ok"] != false {
			t.Fatalf("%v accepted: %v", bad, ack)
		}
	}
}

func TestAHelperIsStoppedAndToldThingsFromThePhone(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "go"})
	l.m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "d1", ToolName: "delegate_task", Arguments: map[string]any{"role": "explore", "task": "find the parser"}}))
	helper := lastItem(l.drain(t).state, "helper")
	if helper == nil || helper["helper"] != "d1" {
		t.Fatalf("the phone's helper card: %v", helper)
	}
	if ack := l.ask(t, map[string]any{"type": "helper", "helper": "d1", "action": "send", "text": "look in internal/ too"}); ack["ok"] != true {
		t.Fatalf("tell: %v", ack)
	}
	if ack := l.ask(t, map[string]any{"type": "helper", "helper": "d1", "action": "stop"}); ack["ok"] != true {
		t.Fatalf("stop: %v", ack)
	}
	got := sentCommands(l.agent)
	if !slices.Contains(got, "agent-send:d1 look in internal/ too") || !slices.Contains(got, "agent-stop:d1") {
		t.Fatalf("the engine was asked %v", got)
	}
	if ack := l.ask(t, map[string]any{"type": "helper", "helper": "nobody", "action": "stop"}); ack["ok"] != false {
		t.Fatalf("an unknown helper was stopped: %v", ack)
	}
}
