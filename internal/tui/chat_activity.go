package tui

import (
	"context"
	"fmt"
	"regexp"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// What is going on behind every wait. While a command runs (Friday's or a sub-agent's, foreground
// or background), the interface asks the engine every activityEvery what each is doing (the
// `activity` session command): its pid, CPU, when it last printed, its last lines, and whether it
// looks stuck — printed nothing and used next to no CPU for the engine's threshold. A sub-agent is
// judged here: it looks stuck when no news of it has come for helperStallAfter. The marks land on
// the cards and the rail; the view itself is app_watch.go.

const (
	// activityEvery is how often the engine is asked while something runs.
	activityEvery = 2 * time.Second
	// helperStallAfter is how long a sub-agent at work may send no news before it looks stuck; the
	// same threshold as the engine's for commands (tools.StallAfter).
	helperStallAfter = 5 * time.Minute
)

// activityState is the engine's last reading.
type activityState struct {
	byID   map[string]acp.Activity
	byCall map[string]string // a foreground command's call id → its id
	read   time.Time
	// ticking: a clock runs; asking: a question is out.
	ticking, asking bool
	// unsupported is why the engine cannot say (it has no such command); asked no more.
	unsupported string
}

type activityTickMsg struct{}

type activityMsg struct {
	result acp.CommandResult
	err    error
}

// startedJob reads the job id from a background run_command's result ("Started cmd1 in…").
var startedJob = regexp.MustCompile(`^Started (\S+) in the background`)

// backgroundJobID is the job a card started in the background, or "".
func backgroundJobID(t *toolItem) string {
	if t == nil || t.name != "run_command" || !t.done {
		return ""
	}
	if match := startedJob.FindStringSubmatch(t.result); match != nil {
		return match[1]
	}
	return ""
}

// activityFor is the engine's last reading of a card's command: its call while it runs in the
// foreground, its job once it runs in the background.
func (m *Model) activityFor(t *toolItem) (acp.Activity, bool) {
	if t == nil {
		return acp.Activity{}, false
	}
	if id := backgroundJobID(t); id != "" {
		a, ok := m.activity.byID[id]
		return a, ok
	}
	if id, ok := m.activity.byCall[t.id]; ok {
		a, ok := m.activity.byID[id]
		return a, ok
	}
	return acp.Activity{}, false
}

// commandsRunning is whether any command runs that the engine can be asked about.
func (m *Model) commandsRunning() bool {
	return m.runningCommands() > 0 || len(m.commandsAtWork()) > 0
}

// wantsActivity is whether the clock should run: a command or a sub-agent at work, or the view open.
func (m *Model) wantsActivity() bool {
	_, watching := windowOf[*watchApp](m)
	return watching || m.commandsRunning() || len(m.workingAgents()) > 0
}

// activityTicker keeps one clock running while there is something to watch.
func (m *Model) activityTicker() tea.Cmd {
	if m.activity.ticking || !m.wantsActivity() {
		return nil
	}
	m.activity.ticking = true
	return tea.Tick(activityEvery, func(time.Time) tea.Msg { return activityTickMsg{} })
}

// activityTicked judges the sub-agents, asks the engine about its commands, and sets the next tick.
func (m *Model) activityTicked() tea.Cmd {
	m.activity.ticking = false
	m.markStuckHelpers(time.Now())
	var ask tea.Cmd
	if _, watching := windowOf[*watchApp](m); watching || m.commandsRunning() {
		ask = m.askActivity()
	}
	return tea.Batch(ask, m.activityTicker())
}

// askActivity puts the question to the engine, one at a time.
func (m *Model) askActivity() tea.Cmd {
	if m.activity.asking || m.activity.unsupported != "" || m.agent == nil || m.session.ID == "" {
		return nil
	}
	m.activity.asking = true
	agent, id := m.agent, m.session.ID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		result, err := agent.Command(ctx, id, "activity", "")
		return activityMsg{result, err}
	}
}

// activityRead takes the engine's answer: the readings, the rail's commands, the cards' marks.
func (m *Model) activityRead(msg activityMsg) tea.Cmd {
	m.activity.asking = false
	switch {
	case msg.err != nil:
		return nil // a slow answer is asked again on the next tick
	case msg.result.Kind != "activity":
		m.activity.unsupported = msg.result.Text
		return nil
	}
	m.activity.byID, m.activity.byCall, m.activity.read = map[string]acp.Activity{}, map[string]string{}, time.Now()
	for _, a := range msg.result.Activities {
		m.activity.byID[a.ID] = a
		if a.CallID != "" {
			m.activity.byCall[a.CallID] = a.ID
		}
		if !a.Background {
			continue
		}
		// The rail's background commands: the engine's word is newer than the last tool result.
		c := m.command(a.ID)
		if c.command == "" {
			c.command = a.Command
		}
		c.status, c.stuck, c.seen = a.Status, a.Stuck, time.Now()
		if len(a.Tail) > 0 {
			c.last = a.Tail[len(a.Tail)-1]
		}
	}
	for _, it := range m.tr.items {
		if t, ok := it.(*toolItem); ok && t.name == "run_command" {
			a, ok := m.activityFor(t)
			m.markStuck(t, ok && a.Stuck && a.Status == "running", a.QuietMs)
		}
	}
	return m.activityTicker()
}

// markStuck sets or clears a card's stuck line, quiet for that many milliseconds.
func (m *Model) markStuck(t *toolItem, stuck bool, quietMs int64) {
	line := ""
	if stuck {
		line = fmt.Sprintf("looks stuck · nothing printed and next to no CPU for %s · enter shows what's going on", elapsed(time.Duration(quietMs)*time.Millisecond))
	}
	if t.stuck != line {
		t.stuck = line
		t.touch()
	}
}

// markStuckHelpers marks the sub-agents with no news for the threshold.
func (m *Model) markStuckHelpers(now time.Time) {
	for _, it := range m.tr.items {
		t, ok := it.(*toolItem)
		if !ok || !delegationTools[t.name] {
			continue
		}
		line := ""
		if m.helperLooksStuck(t, now) {
			line = fmt.Sprintf("looks stuck · no news for %s · enter shows what's going on", elapsed(now.Sub(helperLastNews(t))))
		}
		if t.stuck != line {
			t.stuck = line
			t.touch()
		}
	}
}

// helperLastNews is when a sub-agent was last heard from: its last event, else its start.
func helperLastNews(t *toolItem) time.Time {
	if t.sub != nil && !t.sub.lastEvent.IsZero() {
		return t.sub.lastEvent
	}
	return t.started
}

// helperStuck is the rule for a sub-agent: at work, and no news for helperStallAfter.
func helperStuck(t *toolItem, now time.Time) bool {
	if t == nil || !delegationTools[t.name] || !agentWorking(t) {
		return false
	}
	return now.Sub(helperLastNews(t)) >= helperStallAfter
}

// helperLooksStuck is helperStuck, except while the sub-agent waits on a command the engine sees
// at work: a long build sends no news, and is not a stall.
func (m *Model) helperLooksStuck(t *toolItem, now time.Time) bool {
	if !helperStuck(t, now) {
		return false
	}
	if st := t.sub.running(); st != nil && st.tool == "run_command" {
		if id, ok := m.activity.byCall[st.id]; ok && !m.activity.byID[id].Stuck {
			return false
		}
	}
	return true
}
