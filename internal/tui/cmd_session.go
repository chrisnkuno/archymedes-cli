package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"charm.land/lipgloss/v2/list"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/render"
)

// /cost, /diff, /undo, /todos: the agent answers with data, and the answer becomes a block in the
// transcript, drawn here. Each is asked between turns only; mid-turn the session is busy changing.

type commandDoneMsg struct {
	command string
	result  acp.CommandResult
	err     error
}

func (m *Model) sessionCommand(command, argument string) tea.Cmd {
	if m.agent == nil || m.session.ID == "" {
		return m.toast(toastWarn, "The session is still opening; try again in a moment")
	}
	if m.phase == busy && (command == "undo" || command == "rewind" || command == "compact" || command == "review" || command == "fork") {
		return m.toast(toastWarn, "/"+command+" between turns; esc stops this one")
	}
	agent, id := m.agent, m.session.ID
	// A summary is a model call: it gets the time a turn would.
	timeout := 60 * time.Second
	if command == "compact" || command == "review" || command == "goal-check" {
		timeout = 5 * time.Minute
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), timeout)
		defer cancel()
		result, err := agent.Command(ctx, id, command, argument)
		return commandDoneMsg{command, result, err}
	}
}

func (m *Model) commandDone(msg commandDoneMsg) tea.Cmd {
	if strings.HasPrefix(msg.command, "goal-") && (msg.err != nil || msg.result.Kind == "error") {
		m.goal = nil // an engine that cannot judge a goal cannot pursue one
	}
	switch {
	case msg.err != nil:
		return m.toast(toastWarn, "/"+msg.command+": "+msg.err.Error())
	case msg.result.Kind == "error":
		return m.toast(toastWarn, msg.result.Text)
	case msg.result.Kind == "goal":
		return m.goalVerdict(msg.result)
	case msg.result.Kind == "forked":
		// The copy is opened in place; the original stays in /resume as it was.
		return tea.Batch(m.toast(toastInfo, "Forked into “"+msg.result.Title+"”; the original is in /resume"), m.resumeSession(msg.result.ID))
	case msg.result.Kind == "review":
		m.tr.add(&reviewItem{result: msg.result})
	case msg.result.Kind == "diff":
		m.tr.add(&diffItem{patch: msg.result.Patch})
	case msg.result.Kind == "todos":
		item := &todoItem{}
		for _, i := range msg.result.Items {
			item.items = append(item.items, [2]string{i.Status, i.Text})
		}
		m.tr.add(item)
	default:
		if msg.command == "undo" || msg.command == "rewind" || msg.command == "compact" || msg.command == "spawn" {
			// The screen keeps what was said; the agent's conversation is what was rewound.
			return m.toast(toastInfo, msg.result.Text)
		}
		m.tr.add(&reportItem{title: msg.command, text: msg.result.Text})
	}
	m.tr.toBottom()
	return nil
}

// --- the blocks those answers become ---

// reportItem is a titled block of preformatted text: a cost report, a diff stat, a report the agent
// printed. Not framed: such text often draws its own table, and a box around a box reads as noise.
type reportItem struct {
	versioned
	title, text string
}

func (r *reportItem) render(ctx renderCtx) []string {
	th := ctx.th
	lines := []string{th.Title.Render(r.title)}
	rule := lipgloss.NewStyle().Foreground(th.BorderColor).Render("│ ")
	for _, line := range strings.Split(strings.TrimRight(r.text, "\n"), "\n") {
		lines = append(lines, rule+th.Body.Render(ansi.Truncate(line, max(ctx.width-2, 4), "…")))
	}
	return lines
}

// diffItem is what changed since the last checkpoint, drawn as review rows; folded like tool output.
type diffItem struct {
	versioned
	patch string
}

func (d *diffItem) render(ctx renderCtx) []string {
	limit := 40
	if ctx.expanded {
		limit = 0
	}
	lines := []string{ctx.th.Title.Render("diff") + ctx.th.Faint.Render(" since the last checkpoint")}
	return append(lines, render.Excerpt(ctx.th, d.patch, ctx.width, limit)...)
}

// todoItem is the agent's plan as a checklist.
type todoItem struct {
	versioned
	items [][2]string // status, text
}

func (t *todoItem) render(ctx renderCtx) []string {
	th := ctx.th
	done := 0
	items := list.New().
		Enumerator(func(_ list.Items, i int) string {
			switch t.items[i][0] {
			case "done":
				return "✓"
			case "in_progress":
				return "◐"
			}
			return "○"
		}).
		EnumeratorStyleFunc(func(_ list.Items, i int) lipgloss.Style {
			switch t.items[i][0] {
			case "done":
				return th.OK.MarginRight(1)
			case "in_progress":
				return th.Highlight.MarginRight(1)
			}
			return th.Faint.MarginRight(1)
		}).
		ItemStyleFunc(func(_ list.Items, i int) lipgloss.Style {
			// Width-limited, so a long step wraps under its own text rather than under the mark.
			base := lipgloss.NewStyle().Width(max(ctx.width-6, 8))
			switch t.items[i][0] {
			case "done":
				return base.Inherit(th.Faint)
			case "in_progress":
				return base.Inherit(th.Strong)
			}
			return base.Inherit(th.Body)
		})
	for _, item := range t.items {
		if item[0] == "done" {
			done++
		}
		items.Item(item[1])
	}
	head := th.Title.Render("plan") + th.Faint.Render(fmt.Sprintf(" %d/%d done", done, len(t.items)))
	lines := []string{head}
	for _, line := range strings.Split(items.String(), "\n") {
		lines = append(lines, "  "+line)
	}
	return lines
}

// --- /resume: another stored session, in place of this one ---

type sessionsLoadedMsg struct {
	sessions []acp.SessionSummary
	err      error
}

func (m *Model) loadSessions() tea.Cmd {
	agent, cwd := m.agent, m.opts.Cwd
	if agent == nil {
		return m.toast(toastWarn, "The agent is still starting; try again in a moment")
	}
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		sessions, err := agent.Sessions(ctx, cwd)
		return sessionsLoadedMsg{sessions, err}
	}
}

// resumeSession swaps the open session for a stored one: the screen is cleared and the agent
// replays the stored conversation into it.
func (m *Model) resumeSession(id string) tea.Cmd {
	if m.phase == busy {
		return m.toast(toastWarn, "Resume between turns; esc stops this one")
	}
	agent, previous := m.agent, m.session.ID
	m.tr.clear()
	m.tools, m.current = map[string]*toolItem{}, nil
	m.opts.Resume = id
	return tea.Batch(func() tea.Msg {
		if previous != "" && previous != id {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			_ = agent.CloseSession(ctx, previous) // saved already; closing frees it
		}
		return nil
	}, m.openSession())
}

// relativeTime is "3m ago", "yesterday", "12 Oct" — how long ago reads better than when.
func relativeTime(ms int64, now time.Time) string {
	if ms <= 0 {
		return ""
	}
	t := time.UnixMilli(ms)
	switch d := now.Sub(t); {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	case d < 48*time.Hour:
		return "yesterday"
	}
	return t.Format("2 Jan")
}
