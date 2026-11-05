package tui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// What's going on: one running thing, live. Opened by enter (or a second click) on a running
// command's card or a sub-agent at work, or on a command in the rail. A command shows its pid, how
// long it has run, its process tree's CPU, when it last printed and its last lines, from the
// engine's reading every two seconds (chat_activity.go); a sub-agent shows when news of it last
// came and its last steps. Either is marked when it looks stuck, and the foot stops it (x) or runs
// the same command again in the same folder (r).

type watchApp struct {
	card *toolItem // the card it was opened on: a command's call, or a sub-agent's delegation
	job  string    // a background command's id, when it runs in the background
}

func (w *watchApp) title() string { return "What's going on" }
func (w *watchApp) key() string   { return "watch" }

// watchable is whether enter on a card opens what is going on: a command still running, or a
// sub-agent at work.
func (m *Model) watchable(t *toolItem) bool {
	switch {
	case t == nil:
		return false
	case delegationTools[t.name]:
		return agentWorking(t)
	case t.name != "run_command":
		return false
	case !t.done:
		return true
	}
	if id := backgroundJobID(t); id != "" {
		for _, c := range m.rail.commands {
			if c.id == id {
				return c.running()
			}
		}
	}
	return false
}

// openWatch opens the view on a card, and asks the engine at once rather than at the next tick.
func (m *Model) openWatch(t *toolItem) tea.Cmd {
	m.openWindow(&watchApp{card: t, job: backgroundJobID(t)})
	return tea.Batch(m.askActivity(), m.activityTicker())
}

// openWatchJob opens the view on a background command by its id (from the rail).
func (m *Model) openWatchJob(id string) tea.Cmd {
	var card *toolItem
	for _, it := range m.tr.items {
		if t, ok := it.(*toolItem); ok && backgroundJobID(t) == id {
			card = t
		}
	}
	m.openWindow(&watchApp{card: card, job: id})
	return tea.Batch(m.askActivity(), m.activityTicker())
}

// helper is whether the view is on a sub-agent.
func (w *watchApp) helper() bool { return w.card != nil && delegationTools[w.card.name] }

// commandID is how the engine knows the command: its job id, else the call it runs under.
func (w *watchApp) commandID() string {
	if w.job != "" {
		return w.job
	}
	if w.card != nil {
		return w.card.id
	}
	return ""
}

// reading is the engine's last reading of the command, if it has one.
func (w *watchApp) reading(m *Model) (acp.Activity, bool) {
	if w.job != "" {
		a, ok := m.activity.byID[w.job]
		return a, ok
	}
	if w.card != nil {
		return m.activityFor(w.card)
	}
	return acp.Activity{}, false
}

// running is whether the command or sub-agent is still at work.
func (w *watchApp) running(m *Model) bool {
	if w.helper() {
		return agentWorking(w.card)
	}
	if r, ok := w.reading(m); ok {
		return r.Status == "running"
	}
	return w.card != nil && !w.card.done
}

func (w *watchApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "q":
		return true, nil
	case "x", "delete":
		if !w.running(m) {
			return false, m.toast(toastInfo, "It has already ended")
		}
		if w.helper() {
			return false, m.stopAgent(w.card)
		}
		return false, tea.Batch(m.toast(toastInfo, "Stopping it…"), m.sessionCommand("command-stop", w.commandID()))
	case "r":
		if w.helper() {
			return false, nil
		}
		if w.job == "" && !w.running(m) {
			return false, m.toast(toastInfo, "That call has ended; ask Friday to run it again")
		}
		return false, tea.Batch(m.toast(toastInfo, "Running it again…"), m.sessionCommand("command-restart", w.commandID()))
	case "right":
		if w.card != nil {
			return true, m.openInspector(w.card)
		}
	}
	return false, nil
}

func (w *watchApp) wheel(*Model, bool) tea.Cmd              { return nil }
func (w *watchApp) click(*Model, tea.MouseClickMsg) tea.Cmd { return nil }

func (w *watchApp) view(m *Model) string {
	width, height := m.width, max(m.windowHeight(), 1)
	now := time.Now()
	var lines []string
	add := func(s string) { lines = append(lines, " "+ansi.Truncate(s, max(width-2, 4), "…")) }
	var buttons []button
	if w.helper() {
		buttons = w.helperLines(m, now, add)
	} else {
		buttons = w.commandLines(m, now, add)
	}
	lines = fitLines(lines, width, height-1)
	return strings.Join(append(lines, m.hintBar(width, append(buttons, button{"q", "close"})...)), "\n")
}

func (w *watchApp) commandLines(m *Model, now time.Time, add func(string)) []button {
	th := m.th
	r, ok := w.reading(m)
	command := r.Command
	if command == "" && w.card != nil {
		command = commandText(w.card.args)
	}
	add(th.Strong.Render("$ " + command))
	var buttons []button
	switch {
	case ok:
		running := r.Status == "running"
		took := time.Duration(r.ElapsedMs) * time.Millisecond
		if running && !m.activity.read.IsZero() {
			took += now.Sub(m.activity.read) // live between readings
		}
		state := r.Status + " " + elapsed(took)
		if !running {
			state = r.Status + " after " + elapsed(took)
		}
		where := ""
		if r.Dir != "" {
			where = " · in " + r.Dir
		}
		kind := "foreground"
		if r.Background {
			kind = "background " + r.ID
		}
		add(th.Body.Render(fmt.Sprintf("%s · pid %d · %s", state, r.Pid, kind)) + th.Faint.Render(where))
		switch {
		case !running:
		case r.CPUKnown:
			add(th.Body.Render(fmt.Sprintf("CPU %.1f%%", r.CPU)) + th.Faint.Render(" of one core, it and what it started"))
		default:
			add(th.Faint.Render("CPU unknown on this system"))
		}
		if r.LastOutputAt > 0 {
			add(th.Body.Render("last printed " + elapsed(now.Sub(time.UnixMilli(r.LastOutputAt))) + " ago"))
		} else {
			add(th.Faint.Render("nothing printed yet"))
		}
		if running && r.Stuck {
			add(th.Warn.Render(fmt.Sprintf("looks stuck: nothing printed and next to no CPU for %s.", elapsed(time.Duration(r.QuietMs)*time.Millisecond))))
			add(th.Warn.Render("x stops it; r runs the same command again in the same folder."))
		}
		add("")
		add(th.Strong.Render("Last lines"))
		if len(r.Tail) == 0 {
			add(th.Faint.Render("  (nothing printed yet)"))
		}
		for _, line := range r.Tail {
			add(th.Faint.Render("  │ ") + th.Body.Render(ansi.Strip(line)))
		}
		if running {
			buttons = append(buttons, button{"x", "stop"}, button{"r", "restart"})
		} else if r.Background {
			buttons = append(buttons, button{"r", "run again"})
		}
	default:
		if w.card != nil {
			add(th.Body.Render("running " + elapsed(now.Sub(w.card.started))))
		}
		if m.activity.unsupported != "" {
			add(th.Faint.Render("This engine does not say what its commands are doing: " + m.activity.unsupported))
		} else {
			add(th.Faint.Render("Reading what it is doing…"))
		}
		if w.running(m) {
			buttons = append(buttons, button{"x", "stop"}, button{"r", "restart"})
		}
	}
	if w.card != nil {
		buttons = append(buttons, button{"→", "inspect"})
	}
	return buttons
}

func (w *watchApp) helperLines(m *Model, now time.Time, add func(string)) []button {
	th, t := m.th, w.card
	add(th.Strong.Render("agent · "+subagentRole(t)) + th.Faint.Render(" "+toolBrief(t)))
	working := agentWorking(t)
	state := "finished"
	if working {
		state = "working " + elapsed(now.Sub(t.started))
	}
	add(th.Body.Render(state) + th.Faint.Render(" · "+subagentSummary(t)))
	if working {
		add(th.Body.Render("no news for " + elapsed(now.Sub(helperLastNews(t)))))
	}
	if working && m.helperLooksStuck(t, now) {
		add(th.Warn.Render(fmt.Sprintf("looks stuck: no news for %s.", elapsed(now.Sub(helperLastNews(t))))))
		add(th.Warn.Render("x stops it, and what it found so far becomes its report; → shows its whole timeline."))
	}
	add("")
	add(th.Strong.Render("Last steps"))
	var steps []*subagentStep
	if t.sub != nil {
		steps = t.sub.steps
	}
	if len(steps) == 0 {
		add(th.Faint.Render("  (nothing yet)"))
	}
	for _, st := range steps[max(len(steps)-watchTail, 0):] {
		glyph, text := th.Faint.Render("◌"), st.line
		switch {
		case st.said:
			glyph, text = th.Faint.Render("›"), "said "+firstLine(st.result)
		case st.done && st.isError:
			glyph = th.Bad.Render("✗")
		case st.done:
			glyph = th.OK.Render("✓")
		}
		add("  " + glyph + " " + th.Body.Render(text))
	}
	var buttons []button
	if working {
		buttons = append(buttons, button{"x", "stop"})
	}
	return append(buttons, button{"→", "inspect"})
}

// watchTail is how many of a sub-agent's last steps the view shows, as many as a command's lines.
const watchTail = 10
