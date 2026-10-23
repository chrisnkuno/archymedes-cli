package server

import (
	"os"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/conform"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
)

func protocolDocs(t *testing.T) string {
	t.Helper()
	data, err := os.ReadFile("../../../docs/engine/PROTOCOL.md")
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// TestConformMethods holds every method the engine answers or forwards to the standard: a name in
// the protocol's grammar, a line saying what it does, and an entry in the protocol reference.
func TestConformMethods(t *testing.T) {
	docs := protocolDocs(t)
	var names []string
	for _, m := range methods {
		names = append(names, m.name)
		for _, p := range append(conform.Name("method", m.name), conform.Help(m.does)...) {
			t.Errorf("%s: %s", m.name, p)
		}
		if !strings.Contains(docs, "`"+m.name+"`") {
			t.Errorf("%s is not in docs/engine/PROTOCOL.md", m.name)
		}
	}
	for name := range forwarded {
		names = append(names, name)
		if !strings.Contains(docs, "`"+name+"`") {
			t.Errorf("forwarded %s is not in docs/engine/PROTOCOL.md", name)
		}
	}
	for _, p := range conform.Unique("method", names) {
		t.Error(p)
	}
}

func TestConformSessionCommands(t *testing.T) {
	docs := protocolDocs(t)
	for _, c := range sessionCommands {
		for _, p := range append(conform.Name("command", c.name), conform.Help(c.does)...) {
			t.Errorf("%s: %s", c.name, p)
		}
		if !strings.Contains(docs, "`"+c.name+"`") {
			t.Errorf("session command %s is not in docs/engine/PROTOCOL.md", c.name)
		}
	}
}

// TestConformEvents holds every runtime event and extension notice the engine sends to its name
// grammar and the protocol reference.
func TestConformEvents(t *testing.T) {
	docs := protocolDocs(t)
	events := []string{loop.EventDelta, loop.EventModelTurn, loop.EventToolCall, loop.EventToolResult, loop.EventCompose, loop.EventRetry, loop.EventSteered, loop.EventTestFirst, loop.EventStop, loop.EventCompaction, "context_shrunk"}
	notices := []string{"runtime", "subagent", "thread", "compaction", "steering_unread", "rules_problems"}
	for _, e := range append(events, notices...) {
		for _, p := range conform.Name("event", e) {
			t.Error(p)
		}
		if !strings.Contains(docs, "`"+e+"`") {
			t.Errorf("event %s is not in docs/engine/PROTOCOL.md", e)
		}
	}
}
