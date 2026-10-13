package tui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/NimbleMarkets/ntcharts/v2/sparkline"
	"github.com/charmbracelet/x/ansi"
)

// The two bars of the desktop. The top bar is the menu bar and the tray: the start button, a tab
// per open window, and the session's state. The dock is the bottom row: every app with its key,
// always visible, so nothing has to be remembered to be reached. Each part is a BubbleZone zone
// (zones.go), so a click lands on exactly what it hits.

// dockApps are the dock's apps, in order: action id, icon, name.
var dockApps = []struct{ id, icon, name string }{
	{"chat", "◆", "Chat"}, {"files", "▤", "Files"}, {"search", "◈", "Search"}, {"sessions", "◷", "Sessions"},
	{"models", "◎", "Models"}, {"themes", "◐", "Themes"}, {"keys", "▦", "Keys"}, {"help", "?", "Help"}, {"stats", "▥", "Stats"},
}

func (m *Model) topBar() string {
	th := m.th
	start := " " + lipgloss.NewStyle().Foreground(th.Bg).Background(th.Primary).Bold(true).Render(" ◇ ") + " "

	// The tray gives way to the tabs as the row narrows, but the mode always shows: it decides
	// what the agent may do.
	tray := m.tray()
	if m.width-ansi.StringWidth(start)-ansi.StringWidth(tray)-1 < 12 {
		tray = th.Pill(m.mode, th.ModeColor(m.mode)) + " "
	}
	room := max(m.width-ansi.StringWidth(start)-ansi.StringWidth(tray)-1, 0)

	var tabs strings.Builder
	x := ansi.StringWidth(start)
	for i := 0; i <= len(m.windows); i++ {
		label := "Chat"
		if i > 0 {
			label = m.windows[i-1].title()
		} else if m.active != 0 && m.phase == busy {
			label += " ●" // the conversation is working while you are elsewhere
		} else if m.active != 0 && m.approval != nil {
			label += " ?"
		}
		label = " " + ansi.Truncate(label, 18, "…") + " "
		var tab string
		if i == m.active {
			tab = lipgloss.NewStyle().Foreground(th.Text).Background(th.Tint(th.Primary, 0.35)).Bold(true).Render(label)
		} else {
			tab = th.Faint.Render(label)
		}
		w := ansi.StringWidth(tab)
		if x+w-ansi.StringWidth(start) > room {
			tabs.WriteString(th.Faint.Render("…"))
			break
		}
		tabs.WriteString(mark(m.zones.frame, fmt.Sprintf("tab:%d", i), tab))
		x += w
	}
	return spread(mark(m.zones.frame, "start", start)+tabs.String(), tray, m.width)
}

// tray is the right of the top bar: what the agent is doing, then model, workspace and mode.
func (m *Model) tray() string {
	th := m.th
	var status string
	switch {
	case m.phase == connecting:
		status = m.spin.View() + th.Faint.Render(" starting ")
	case m.phase == failed:
		status = th.Bad.Render("✗ agent stopped ")
	case m.phase == busy:
		status = m.spin.View() + th.Highlight.Render(" "+elapsed(time.Since(m.turnStart))+" ")
		status += m.streamRate()
		if len(m.queue) > 0 {
			status += th.Faint.Render(fmt.Sprintf("+%d ", len(m.queue)))
		}
	}
	tray := status
	if status == "" && m.usage.input+m.usage.output > 0 {
		tray += th.Faint.Render(fmt.Sprintf("↑%s ↓%s ", compact(m.usage.input), compact(m.usage.output)))
	}
	if info := m.session.Info; info.Model != "" {
		tray += th.SoftPill(info.Model, th.Secondary) + " "
	}
	if where := m.session.Info.Workspace; where != "" && where != "local" {
		tray += th.SoftPill(where, th.Warning) + " "
	}
	return tray + th.Pill(m.mode, th.ModeColor(m.mode)) + " "
}

// streamRate is a one-row sparkline of how fast the reply is streaming, a quarter second per
// cell, newest right: a flat line while the agent reads or runs tools, a ridge while it writes.
func (m *Model) streamRate() string {
	data := m.stats.stream
	if len(data) < 2 {
		return ""
	}
	if len(data) > streamRateWidth {
		data = data[len(data)-streamRateWidth:]
	}
	line := sparkline.New(streamRateWidth, 1, sparkline.WithStyle(lipgloss.NewStyle().Foreground(m.th.Secondary)), sparkline.WithData(data))
	line.Draw()
	return line.View() + " "
}

const streamRateWidth = 12

// dock is the bottom row: every app with its key, then — where there is room — what the moment
// needs (esc to stop, ctrl+c again to quit) and the session's tokens.
func (m *Model) dock() string {
	th := m.th
	type form func(icon, name, key string) string
	// Widest first; the first that fits is drawn. Names go before icons: a word is what makes a
	// dock readable, the icon only decorates it.
	forms := []form{
		func(icon, name, key string) string { return icon + " " + name + " " + key },
		func(_, name, key string) string { return key + " " + name },
		func(icon, _, key string) string { return key + icon },
		func(_, _, key string) string { return key },
	}
	right := m.dockHint()
	for i, f := range forms {
		var b strings.Builder
		b.WriteString(" ")
		x := 1
		for _, app := range dockApps {
			a, _ := findAction(app.id)
			label := " " + f(app.icon, app.name, keyLabel(m.keys.keysFor(a)))
			if i == 0 {
				label += " "
			}
			styled := th.Faint.Render(label)
			if (app.id == "chat" && m.active == 0) || (m.activeWindow() != nil && strings.EqualFold(m.activeWindow().title(), app.name)) {
				styled = th.Strong.Render(label)
			}
			b.WriteString(mark(m.zones.frame, "app:"+app.id, styled))
			x += ansi.StringWidth(label)
		}
		fits := x <= m.width
		if fits || i == len(forms)-1 {
			left := b.String()
			if ansi.StringWidth(left)+ansi.StringWidth(right)+2 > m.width {
				right = ""
			}
			return spread(left, right, m.width)
		}
	}
	return ""
}

func (m *Model) dockHint() string {
	th := m.th
	hint := ""
	switch {
	case m.quitArmed:
		hint = th.Warn.Render("ctrl+c again to quit")
	case m.active == 0:
		h := m.help
		h.SetWidth(40)
		hint = h.ShortHelpView(m.keys.shortFor(m))
	}
	return hint + " " // the session's tokens are in the tray
}
