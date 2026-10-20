package tui

import (
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

func TestBrokenCommandRulesAreNamed(t *testing.T) {
	m, _ := newTestModel(t)
	m.handleEvent(acp.Event{Type: "rules_problems", Problems: []string{`rules.json rule 1 (git push): should match "git pull" but does not — left out`}})
	if s := screen(m); !strings.Contains(s, "Some command rules or agent roles were left out") || !strings.Contains(s, "rule 1 (git push)") {
		t.Fatal(s)
	}
}
