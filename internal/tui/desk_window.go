package tui

import (
	"fmt"
	"image"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"
	zone "github.com/lrstanley/bubblezone/v2"
)

// Windows on the desktop. An app is a window floating on the wallpaper, not a pane over the whole
// screen and not a dialog: a frame with its title and two buttons in the top edge (▢ zoom, ✕ close),
// a margin of wallpaper around it, and a body of frosted glass, the photo behind it blurred and
// tinted toward the theme's surface (desk_wallpaper.go). Zoomed, it fills the space between the bars
// and keeps its frame. Chat is the desktop itself: the transcript and the input lie on the
// wallpaper, and every other window floats over it.
//
// An app draws, and reads keys and clicks, as if the window's inside were the screen: m.width and
// m.height are the inside's while it does (within), so no app needs to know where its window is.

const (
	// windowMarginX, windowMarginY are the wallpaper left around a window that is not zoomed.
	windowMarginX = 3
	windowMarginY = 1
	// windowMaxWidth is the widest a window grows on a wide screen before it centres instead.
	windowMaxWidth = 168
	// minFloatWidth, minFloatHeight are the smallest screen a window floats on with a margin; on a
	// smaller one it fills the space, as zoomed.
	minFloatWidth  = 70
	minFloatHeight = 18
)

// windowState is the Model's share: whether the window is zoomed, where its glass and its inside
// were last drawn, and which window's title was clicked once (a second click zooms).
type windowState struct {
	zoomed       bool
	glass        image.Rectangle
	winOrigin    image.Point
	titleClicked int
	underGlass   image.Rectangle // the glass the cached wallpaper frame was laid for
	// rowOut holds last frame's composited wallpaper row at each screen row, so a frame lays again
	// only the rows whose text changed — a keystroke or a streaming line, not the whole screen. It
	// is positional (one slot per row, overwritten each frame, so it cannot grow), and discarded
	// when the photo, the glass or the width changes, since those change every row at once.
	rowOut     []cachedRow
	rowGrid    *wallpaperGrid
	rowGlass   image.Rectangle
	rowWidth   int
	buttonKeys []string // the keys the hint bar's buttons press, as last drawn
	dialogKeys []string // and a dialog's
	bar          barFocus        // the keyboard on the bars (desk_bars_focus.go)
}

// windowRect is where the focused window's frame goes on screen, border included.
func (m *Model) windowRect() image.Rectangle {
	top, bottom := 1, m.height-1 // between the top bar and the dock
	if m.zoomed || m.width < minFloatWidth || m.height < minFloatHeight {
		return image.Rect(0, top, m.width, bottom)
	}
	w := min(m.width-2*windowMarginX, windowMaxWidth)
	x := (m.width - w) / 2
	return image.Rect(x, top+windowMarginY, x+w, bottom-windowMarginY)
}

// windowInside is the window's inside: the frame less its border.
func (m *Model) windowInside() image.Rectangle { return m.windowRect().Inset(1) }

// within runs f with the screen's size set to the window's inside, as the app sees it; the
// window's place is kept for what is drawn at absolute positions (Sixel pictures).
func (m *Model) within(f func()) {
	inside := m.windowInside()
	m.winOrigin = inside.Min
	m.sized(inside.Dx(), inside.Dy(), f)
}

// sized runs f with the screen's size set to width×height of room for a window's body, as a
// reader drawn inside a dialog sees it.
func (m *Model) sized(width, height int, f func()) {
	w, h := m.width, m.height
	m.width, m.height = max(width, 1), max(height, 1)+2 // windowHeight() is height-2
	defer func() { m.width, m.height = w, h }()
	f()
}

// windowView is the focused window as the rows of the area between the bars: its frame on the
// wallpaper. It also records where the glass goes.
func (m *Model) windowView(w window) []string {
	th := m.th
	rect := m.windowRect()
	var body string
	m.within(func() { body = w.view(m) })
	inner := rect.Inset(1)
	lines := strings.Split(fillHeight(clipBlock(body, inner.Dx(), inner.Dy()), inner.Dy()), "\n")
	edge := lipgloss.NewStyle().Foreground(th.BorderFocus)
	for i, line := range lines {
		lines[i] = edge.Render("│") + padRight(ansi.Truncate(line, inner.Dx(), ""), inner.Dx()) + edge.Render("│")
	}
	rows := append([]string{m.windowTitleBar(w, rect.Dx())}, lines...)
	rows = append(rows, edge.Render("╰"+strings.Repeat("─", max(rect.Dx()-2, 0))+"╯"))
	m.glass = rect
	out := make([]string, m.windowHeight())
	for y := range out {
		if r := y + 1 - rect.Min.Y; r >= 0 && r < len(rows) {
			out[y] = strings.Repeat(" ", rect.Min.X) + rows[r]
		}
	}
	return out
}

// windowTitleBar is the frame's top edge: the app's name on the left, zoom and close on the right,
// each a button.
func (m *Model) windowTitleBar(w window, width int) string {
	th := m.th
	edge := lipgloss.NewStyle().Foreground(th.BorderFocus)
	zoom := "▢"
	if m.zoomed {
		zoom = "◱"
	}
	buttons := mark(m.zones.frame, "win:zoom", th.Faint.Render(" "+zoom+" ")) + mark(m.zones.frame, "win:close", th.Bad.Render(" ✕ "))
	room := width - 4 // the corners and an edge either side
	if room < ansi.StringWidth(buttons)+4 {
		buttons = "" // too narrow for buttons: q and ctrl+w still close it
	}
	title := ansi.Truncate(" "+w.title()+" ", max(room-ansi.StringWidth(buttons), 0), "…")
	fill := max(room-ansi.StringWidth(title)-ansi.StringWidth(buttons), 0)
	return edge.Render("╭─") + mark(m.zones.frame, "win:title", th.Title.Render(title)) + edge.Render(strings.Repeat("─", fill)) + buttons + edge.Render("─╮")
}

// windowChromeClick is a click on a window's frame: its zoom and close buttons, or its title (a
// second click on the title zooms, as a double click would). False when the click was elsewhere.
func (m *Model) windowChromeClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	frame := m.zones.frame
	switch {
	case frame.Get("win:close").InBounds(msg):
		m.closeWindow(m.active)
		return nil, true
	case frame.Get("win:zoom").InBounds(msg):
		m.zoomed = !m.zoomed
		return m.relayoutWindow(), true
	case frame.Get("win:title").InBounds(msg):
		if m.titleClicked == m.active {
			m.zoomed, m.titleClicked = !m.zoomed, -1
			return m.relayoutWindow(), true
		}
		m.titleClicked = m.active
		return nil, true
	}
	m.titleClicked = -1
	return nil, false
}

// wheeler is something the wheel scrolls: a list, a grid, a reader.
type wheeler interface {
	wheel(m *Model, up bool) tea.Cmd
}

// pointWheeler is a window whose wheel depends on where the pointer is: the pane under it scrolls.
// x and y are inside the window.
type pointWheeler interface {
	wheelAt(m *Model, up bool, x, y int) tea.Cmd
}

// wheelStep is how many rows one notch of the wheel moves.
const wheelStep = 3

// wheel scrolls what is under the pointer: the open dialog, else the focused window when the
// pointer is on it, else the Chat transcript. Nothing hidden behind something else ever scrolls.
func (m *Model) wheel(msg tea.MouseWheelMsg) tea.Cmd {
	m.sel.clear() // the text moves under it
	up := msg.Mouse().Button == tea.MouseWheelUp
	if !up && msg.Mouse().Button != tea.MouseWheelDown {
		return nil
	}
	if m.overlay != nil || m.approval != nil {
		if s, ok := m.overlay.(wheeler); ok && m.approval == nil {
			return s.wheel(m, up)
		}
		return nil
	}
	if w := m.activeWindow(); w != nil {
		mouse := msg.Mouse()
		if !image.Pt(mouse.X, mouse.Y).In(m.glass) {
			return nil
		}
		var cmd tea.Cmd
		switch s := w.(type) {
		case pointWheeler:
			m.within(func() { cmd = s.wheelAt(m, up, mouse.X-m.winOrigin.X, mouse.Y-m.winOrigin.Y) })
		case wheeler:
			m.within(func() { cmd = s.wheel(m, up) })
		}
		return cmd
	}
	if up {
		return m.scrollBy(wheelStep)
	}
	return m.scrollBy(-wheelStep)
}

// relayoutWindow tells a window that lays itself out for its size (the Gallery) that it changed.
func (m *Model) relayoutWindow() tea.Cmd {
	if g := m.galleryWindow(); g != nil && m.activeWindow() == window(g) {
		var cmd tea.Cmd
		m.within(func() { cmd = g.relayout(m) })
		return cmd
	}
	return nil
}

// --- the hint bar: a window's keys, as buttons ---

// button is one key a window answers and what it does there.
type button struct{ key, does string }

// hintBar is a window's foot: its keys as buttons, as many as fit in width. A click on one is that
// key pressed (buttonClick), so nothing a key does is out of reach of the mouse.
func (m *Model) hintBar(width int, buttons ...button) string {
	return m.buttonBar(m.zones.frame, "button", &m.buttonKeys, width, buttons)
}

// dialogHintBar is hintBar for a dialog: the same buttons, as the open dialog's click targets.
func (m *Model) dialogHintBar(width int, buttons ...button) string {
	return m.buttonBar(m.zones.dialog, "dbutton", &m.dialogKeys, width, buttons)
}

func (m *Model) buttonBar(zones *zone.Manager, prefix string, keys *[]string, width int, buttons []button) string {
	th := m.th
	var parts []string
	used := 1
	for _, b := range buttons {
		text := th.Key.Render(b.key) + " " + th.Faint.Render(b.does)
		w := ansi.StringWidth(b.key) + 1 + ansi.StringWidth(b.does)
		if used+w+3 > width {
			break
		}
		*keys = append(*keys, b.key)
		parts = append(parts, mark(zones, fmt.Sprintf("%s:%d", prefix, len(*keys)-1), text))
		used += w + 3
	}
	return " " + strings.Join(parts, th.Faint.Render(" · "))
}

// dialogButtonClick presses the key of the open dialog's button a click landed on.
func (m *Model) dialogButtonClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	for i, k := range m.dialogKeys {
		if m.zones.dialog.Get(fmt.Sprintf("dbutton:%d", i)).InBounds(msg) {
			return m.handleKey(keyPress(k)), true
		}
	}
	return nil, false
}

// buttonClick presses the key of the hint-bar button a click landed on; false when it missed them.
func (m *Model) buttonClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	for i, k := range m.buttonKeys {
		if m.zones.frame.Get(fmt.Sprintf("button:%d", i)).InBounds(msg) {
			return m.handleKey(keyPress(k)), true
		}
	}
	return nil, false
}

// keyPress is the key press a key's name stands for ("enter", "esc", "ctrl+r", "x").
func keyPress(name string) tea.KeyPressMsg {
	named := map[string]rune{"enter": tea.KeyEnter, "esc": tea.KeyEscape, "tab": tea.KeyTab, "space": tea.KeySpace,
		"backspace": tea.KeyBackspace, "delete": tea.KeyDelete, "up": tea.KeyUp, "down": tea.KeyDown, "left": tea.KeyLeft,
		"right": tea.KeyRight, "←": tea.KeyLeft, "→": tea.KeyRight, "↑": tea.KeyUp, "↓": tea.KeyDown, "home": tea.KeyHome, "end": tea.KeyEnd, "pgup": tea.KeyPgUp, "pgdown": tea.KeyPgDown}
	var mod tea.KeyMod
	for _, prefix := range []struct {
		name string
		mod  tea.KeyMod
	}{{"ctrl+", tea.ModCtrl}, {"alt+", tea.ModAlt}, {"shift+", tea.ModShift}} {
		if strings.HasPrefix(name, prefix.name) {
			mod |= prefix.mod
			name = strings.TrimPrefix(name, prefix.name)
		}
	}
	if code, ok := named[name]; ok {
		return tea.KeyPressMsg{Code: code, Mod: mod}
	}
	r := []rune(name)[0]
	if mod == 0 {
		return tea.KeyPressMsg{Code: r, Text: name}
	}
	return tea.KeyPressMsg{Code: r, Mod: mod}
}
