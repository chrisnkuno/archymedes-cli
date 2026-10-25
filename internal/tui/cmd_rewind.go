package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/render"
)

// /rewind: every turn of the session that can be returned to, newest first, with what the selected
// one changed below it. The agent keeps a checkpoint before each turn (a hidden git ref, so it
// survives a resume); rewinding to one returns the files, the conversation, or both, to the moment
// before that turn and forgets every turn after it.

type turnsLoadedMsg struct {
	turns []acp.Turn
	err   error
}

type turnDiffMsg struct {
	index int
	patch string
	err   error
}

type rewindPicker struct {
	turns   []acp.Turn // newest first
	loaded  bool
	err     string
	cursor  int
	diffs   map[int]string // by turn index; "" is "asked, changed nothing"
	pending map[int]bool
	// reading is the selected turn's whole diff, read in the dialog; esc comes back to the turns.
	reading *pager
}

// readerSize is the room a diff is read in inside the dialog.
func (p *rewindPicker) readerSize(m *Model) (int, int) {
	return max(overlayWidth(m, 100)-4, 8), max(m.height-8, 4)
}

func (m *Model) cmdRewind(arg string) tea.Cmd {
	if arg != "" {
		return m.sessionCommand("rewind", arg)
	}
	if m.phase == busy {
		return m.toast(toastWarn, "Rewind between turns; esc stops this one")
	}
	m.openOverlay(&rewindPicker{diffs: map[int]string{}, pending: map[int]bool{}})
	return m.agentCall(func(ctx context.Context, agent Agent, id string) tea.Msg {
		result, err := agent.Command(ctx, id, "turns", "")
		if err == nil && result.Kind == "error" {
			err = fmt.Errorf("%s", result.Text)
		}
		return turnsLoadedMsg{result.Turns, err}
	})
}

// agentCall runs one request against the open session off the update loop.
func (m *Model) agentCall(call func(ctx context.Context, agent Agent, id string) tea.Msg) tea.Cmd {
	if m.agent == nil || m.session.ID == "" {
		return m.toast(toastWarn, "The session is still opening; try again in a moment")
	}
	agent, id := m.agent, m.session.ID
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
		defer cancel()
		return call(ctx, agent, id)
	}
}

func (p *rewindPicker) load(m *Model, msg turnsLoadedMsg) tea.Cmd {
	p.loaded = true
	if msg.err != nil {
		p.err = msg.err.Error()
		return nil
	}
	p.turns = p.turns[:0]
	for i := len(msg.turns) - 1; i >= 0; i-- {
		p.turns = append(p.turns, msg.turns[i])
	}
	p.cursor = 0
	return p.preview(m)
}

// preview asks for the selected turn's diff once.
func (p *rewindPicker) preview(m *Model) tea.Cmd {
	if len(p.turns) == 0 {
		return nil
	}
	index := p.turns[p.cursor].Index
	if _, ok := p.diffs[index]; ok || p.pending[index] {
		return nil
	}
	p.pending[index] = true
	return m.agentCall(func(ctx context.Context, agent Agent, id string) tea.Msg {
		result, err := agent.Command(ctx, id, "diff", fmt.Sprintf("turn %d", index))
		return turnDiffMsg{index, result.Patch, err}
	})
}

func (p *rewindPicker) diffLoaded(msg turnDiffMsg) {
	delete(p.pending, msg.index)
	if msg.err != nil {
		p.diffs[msg.index] = ""
		return
	}
	p.diffs[msg.index] = msg.patch
}

func (p *rewindPicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	if p.reading != nil {
		var closed bool
		var cmd tea.Cmd
		w, h := p.readerSize(m)
		m.sized(w, h, func() { closed, cmd = p.reading.handle(m, msg) })
		if closed {
			p.reading = nil // back to the turns
		}
		return false, cmd
	}
	count := max(len(p.turns), 1)
	switch msg.String() {
	case "esc", "ctrl+c", "q":
		return true, nil
	case "up", "k", "ctrl+k":
		p.cursor = (p.cursor - 1 + count) % count
		return false, p.preview(m)
	case "down", "j", "ctrl+j", "tab":
		p.cursor = (p.cursor + 1) % count
		return false, p.preview(m)
	case "enter", "c", "v":
		if len(p.turns) == 0 {
			return false, nil
		}
		scope := map[string]string{"enter": "", "c": " code", "v": " conversation"}[msg.String()]
		return true, m.sessionCommand("rewind", fmt.Sprintf("%d%s", p.turns[p.cursor].Index, scope))
	case "d":
		if len(p.turns) == 0 {
			return false, nil
		}
		turn := p.turns[p.cursor]
		patch, ok := p.diffs[turn.Index]
		if !ok || strings.TrimSpace(patch) == "" {
			return false, nil
		}
		w, _ := p.readerSize(m)
		p.reading = newPager(m, "Turn "+fmt.Sprint(turn.Index+1)+": "+turn.Label, render.Excerpt(m.th, patch, max(w-8, 20), 0))
		return false, nil
	}
	return false, nil
}

func (p *rewindPicker) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 100)
	inner := max(width-4, 8)
	if p.reading != nil {
		var body string
		w, h := p.readerSize(m)
		m.sized(w, h, func() { body = p.reading.view(m) })
		return frame(th, "Rewind · the turn's diff", body, width)
	}
	var b strings.Builder
	switch {
	case !p.loaded:
		b.WriteString(m.spin.View() + th.Faint.Render(" reading this session's turns…") + "\n")
	case p.err != "":
		b.WriteString(th.Bad.Render(ansi.Wrap(p.err, inner, "")) + "\n")
	case len(p.turns) == 0:
		b.WriteString(th.Faint.Render("No turn to rewind to yet: each turn that may change files keeps a checkpoint first.") + "\n")
	default:
		now := time.Now()
		rows := min(len(p.turns), max(m.transcriptHeight()/3, 3))
		start := max(0, min(p.cursor-rows+1, len(p.turns)-rows))
		for i := start; i < start+rows && i < len(p.turns); i++ {
			turn := p.turns[i]
			number := padRight(fmt.Sprintf("%d.", turn.Index+1), 5)
			when := padRight(relativeTime(turn.CreatedAt, now), 11)
			label := ansi.Truncate(strings.Join(strings.Fields(turn.Label), " "), max(inner-16, 4), "…")
			row := th.Faint.Render(number+when) + th.Body.Render(label)
			if i == p.cursor {
				row = lipgloss.NewStyle().Foreground(th.Text).Background(th.Tint(th.Primary, 0.3)).Bold(true).Render(padRight(number+when+label, inner))
			}
			b.WriteString(mark(m.zones.dialog, rowID(i), row) + "\n")
		}
		b.WriteString("\n" + p.previewLines(m, inner))
	}
	b.WriteString(m.dialogHintBar(inner, button{"enter", "files + conversation"}, button{"c", "files"}, button{"v", "conversation"}, button{"d", "read the diff"}, button{"esc", "close"}))
	return frame(th, "Rewind to before a turn", b.String(), width)
}

// previewLines is what the selected turn changed, folded to what fits.
func (p *rewindPicker) previewLines(m *Model, inner int) string {
	th := m.th
	index := p.turns[p.cursor].Index
	patch, ok := p.diffs[index]
	switch {
	case !ok:
		return th.Faint.Render("reading what this turn changed…") + "\n"
	case strings.TrimSpace(patch) == "":
		return th.Faint.Render("This turn changed no files.") + "\n"
	}
	lines := render.Excerpt(th, patch, inner, max(m.transcriptHeight()/2, 6))
	return strings.Join(lines, "\n") + "\n"
}

func (p *rewindPicker) rowCount() int { return len(p.turns) }
func (p *rewindPicker) choose(m *Model, i int) tea.Cmd {
	p.cursor = i
	return p.preview(m)
}

// wheel scrolls the diff being read, or moves through the turns.
func (p *rewindPicker) wheel(m *Model, up bool) tea.Cmd {
	if p.reading != nil {
		return p.reading.wheel(m, up)
	}
	_, cmd := p.handle(m, keyPress(map[bool]string{true: "up", false: "down"}[up]))
	return cmd
}
