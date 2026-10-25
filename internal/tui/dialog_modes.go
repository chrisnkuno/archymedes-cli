package tui

import (
	"cmp"

	tea "charm.land/bubbletea/v2"
)

// modePicker (/mode with nothing after it) shows the four modes as tiles: what each lets Friday do,
// the current one marked. enter switches; nothing changes until then, since a mode reaches the agent.
type modePicker struct {
	grid tileGrid
}

// modeTiles are the modes in the shift+tab order, each with its symbol and what it means.
var modeTiles = []struct{ name, symbol, does string }{
	{"plan", "◎", "reads and proposes; changes nothing"},
	{"build", "✎", "edits and runs; you approve each change"},
	{"auto", "»", "edits and runs unasked; asks about risk"},
	{"defender", "◆", "security review; every change asks"},
}

func newModePicker(m *Model) *modePicker {
	p := &modePicker{}
	current := cmp.Or(m.pendingMode, m.mode)
	for i, mt := range modeTiles {
		caption := mt.name
		if mt.name == current {
			caption = "● " + mt.name
			p.grid.cursor = i
		}
		p.grid.tiles = append(p.grid.tiles, tile{id: mt.name, caption: caption,
			art: iconArt(mt.symbol, m.th.ModeColor(mt.name), wrapTo(mt.does, tileArtCols, 3)...)})
	}
	return p
}

func (p *modePicker) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c", "q":
		return true, nil
	case "enter", "space":
		return true, m.setMode(p.grid.tiles[p.grid.cursor].id)
	}
	p.grid.move(msg.String(), 1)
	return false, nil
}

func (p *modePicker) rowCount() int { return len(p.grid.tiles) }
func (p *modePicker) choose(m *Model, i int) tea.Cmd {
	m.overlay = nil
	return m.setMode(p.grid.tiles[i].id)
}

func (p *modePicker) view(m *Model) string {
	width := gridWidth(m, 4)
	body := p.grid.view(m, max(width-4, 1), max(m.height-6, 1))
	return frame(m.th, "Mode", body+"\n"+m.th.Faint.Render("↑↓←→ move · enter switch · esc keep · shift+tab cycles in a session"), width)
}
