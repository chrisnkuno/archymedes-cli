package tui

import (
	"context"
	"fmt"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/project"
)

// The first minutes with Archymedes. Until someone has sent a first request the home screen says
// what to do, in three steps, instead of listing keys; there are always a few requests to start
// from (tab puts one in the input, a click too), chosen for the project in front of it — a review
// of its changes when there are some; and the first finished turn ends with a pointer to the two
// things people want next, what changed and how to undo it. Remembered in state.json, so it
// happens once, not every session.

// projectStateMsg is what the home screen knows about the project before any request.
type projectStateMsg struct{ changed int }

// readProjectState counts the working tree's changes, so a starter can offer to review them.
func (m *Model) readProjectState() tea.Cmd {
	root := m.projectRoot()
	return func() tea.Msg {
		changes, err := project.Changes(context.Background(), root)
		if err != nil {
			return projectStateMsg{}
		}
		return projectStateMsg{len(changes)}
	}
}

// starters are the requests offered on the home screen, most useful first.
func (m *Model) starters() []string {
	var s []string
	if m.projectChanged > 0 {
		s = append(s, fmt.Sprintf("Review my %s for risks", plural(m.projectChanged, "uncommitted change")))
	}
	s = append(s,
		"Explain what this project does",
		"Find the riskiest code here, and say why",
		"Add a test for the most important function",
	)
	return s[:3]
}

// offerStarter puts the next starter in the input: tab on an empty input (or on a starter it put
// there) on the home screen. False when it is not the moment, so tab does what it always does.
func (m *Model) offerStarter() bool {
	if !m.landingVisible() || m.phase == failed {
		return false
	}
	current := m.input.value()
	starters := m.starters()
	next := 0
	if current != "" {
		found := false
		for i, s := range starters {
			if s == current {
				next, found = (i+1)%len(starters), true
			}
		}
		if !found {
			return false
		}
	}
	m.input.take()
	m.input.area.InsertString(starters[next])
	return true
}

// useStarter puts starter i in the input (a click on it).
func (m *Model) useStarter(i int) {
	starters := m.starters()
	if i < 0 || i >= len(starters) {
		return
	}
	m.input.take()
	m.input.area.InsertString(starters[i])
}

// welcome marks the first request sent: remembered, and the next finished turn ends with a tip.
func (m *Model) welcome() {
	if m.welcomed {
		return
	}
	m.welcomed, m.firstTurnTip = true, true
	if m.opts.ConfigDir != "" {
		_ = config.SaveState(m.opts.ConfigDir, config.State{Welcomed: true})
	}
}

// afterFirstTurn is the tip that ends the very first turn.
func (m *Model) afterFirstTurn() tea.Cmd {
	if !m.firstTurnTip {
		return nil
	}
	m.firstTurnTip = false
	return m.toast(toastInfo, fmt.Sprintf("First turn done · %s shows what changed · /undo takes it back", keyLabel(m.keys.Changes.Keys())))
}
