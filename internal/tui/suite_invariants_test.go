package tui

import (
	"fmt"
	"math/rand/v2"
	"os"
	"strconv"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"
)

// The desktop's invariants, under random use.
//
// The other suites each walk one path. Here a seeded random user presses keys, clicks, scrolls and
// resizes the window, eighty times a run, on every app, with the wallpaper on and off, and after
// every single event the screen must still hold what the user relies on:
//
//   - nothing panics;
//   - the frame is exactly the window: as many rows as it is tall, none wider than it is wide;
//   - escape always gets out: a few presses close any dialog;
//   - with the wallpaper on, every cell has a background (nothing of the terminal shows through);
//   - quitting ends cleanly: the one draw after it does not block (it once could, on a closed zone
//     manager whose buffer had filled).
//
// The random user never runs what a command returns (no shell, no clipboard, no editor), so the
// suite touches nothing outside the model. A failure names its seed and the events that led to it:
// `TUI_SEED=<n> go test ./internal/tui -run Invariants` replays it.

type randomUser struct {
	r   *rand.Rand
	log []string
}

// keys a user might press. No "!": that would make the input a shell command.
var userKeys = []tea.KeyPressMsg{
	{Code: tea.KeyEnter}, {Code: tea.KeyEscape}, {Code: tea.KeyTab}, {Code: tea.KeyTab, Mod: tea.ModShift},
	{Code: tea.KeyUp}, {Code: tea.KeyDown}, {Code: tea.KeyLeft}, {Code: tea.KeyRight}, {Code: tea.KeyPgUp}, {Code: tea.KeyPgDown},
	{Code: tea.KeyHome}, {Code: tea.KeyEnd}, {Code: tea.KeyBackspace}, {Code: tea.KeySpace, Mod: tea.ModCtrl},
	{Code: 'p', Mod: tea.ModCtrl}, {Code: 'k', Mod: tea.ModCtrl}, {Code: 'w', Mod: tea.ModCtrl}, {Code: 'l', Mod: tea.ModCtrl},
	{Code: 'p', Mod: tea.ModAlt}, {Code: 't', Mod: tea.ModAlt}, {Code: 'n', Mod: tea.ModAlt},
	{Code: tea.KeyF1}, {Code: tea.KeyF2}, {Code: tea.KeyF3}, {Code: tea.KeyF4}, {Code: tea.KeyF5}, {Code: tea.KeyF6},
	{Code: tea.KeyF7}, {Code: tea.KeyF8}, {Code: tea.KeyF9}, {Code: tea.KeyF10}, {Code: tea.KeyF12},
	{Code: '/', Text: "/"}, {Code: '?', Text: "?"}, {Code: 'a', Text: "a"}, {Code: 'q', Text: "q"}, {Code: 'j', Text: "j"},
	{Code: 'g', Text: "g"}, {Code: ' ', Text: " "}, {Code: '1', Text: "1"},
}

func (u *randomUser) event(m *Model) tea.Msg {
	switch roll := u.r.IntN(100); {
	case roll < 70:
		k := userKeys[u.r.IntN(len(userKeys))]
		u.log = append(u.log, "key "+k.String())
		return k
	case roll < 85:
		x, y := u.r.IntN(max(m.width, 1)), u.r.IntN(max(m.height, 1))
		u.log = append(u.log, fmt.Sprintf("click %d,%d", x, y))
		return tea.MouseClickMsg{X: x, Y: y, Button: tea.MouseLeft}
	case roll < 92:
		x, y := u.r.IntN(max(m.width, 1)), u.r.IntN(max(m.height, 1))
		button := tea.MouseWheelUp
		if u.r.IntN(2) == 0 {
			button = tea.MouseWheelDown
		}
		u.log = append(u.log, fmt.Sprintf("wheel %d,%d", x, y))
		return tea.MouseWheelMsg{X: x, Y: y, Button: button}
	default:
		w, h := 10+u.r.IntN(210), 4+u.r.IntN(66)
		u.log = append(u.log, fmt.Sprintf("resize %dx%d", w, h))
		return tea.WindowSizeMsg{Width: w, Height: h}
	}
}

func (u *randomUser) trail() string {
	from := max(len(u.log)-12, 0)
	return strings.Join(u.log[from:], " → ")
}

// checkFrame is the frame invariant, as an error rather than a fatal, so the caller can name the seed.
func checkFrame(m *Model) error {
	rows := strings.Split(m.View().Content, "\n")
	if len(rows) != m.height {
		return fmt.Errorf("%d rows in a %d-row window", len(rows), m.height)
	}
	for i, row := range rows {
		if w := ansi.StringWidth(row); w > m.width {
			return fmt.Errorf("row %d is %d wide in a %d-wide window: %q", i, w, m.width, ansi.Strip(row))
		}
	}
	if !m.opts.NoWallpaper && !m.opts.NoPhotos && m.width > 0 && m.height > 0 {
		grid := cells(m.View().Content, m.width, m.height)
		for y := range m.height {
			for x := range m.width {
				if c := grid.CellAt(x, y); c != nil && c.Width > 0 && c.Style.Bg == nil {
					return fmt.Errorf("cell (%d,%d) %q shows the terminal through the wallpaper", x, y, c.Content)
				}
			}
		}
	}
	return nil
}

func invariantSeeds() []uint64 {
	if s := os.Getenv("TUI_SEED"); s != "" {
		n, _ := strconv.ParseUint(s, 10, 64)
		return []uint64{n}
	}
	seeds := make([]uint64, 60)
	for i := range seeds {
		seeds[i] = uint64(i + 1)
	}
	return seeds
}

func TestInvariantsHoldUnderRandomUse(t *testing.T) {
	for _, seed := range invariantSeeds() {
		func() {
			m, _ := newTestModel(t)
			m.opts.NoWallpaper = seed%2 == 0
			u := &randomUser{r: rand.New(rand.NewPCG(seed, 7))}
			defer func() {
				if p := recover(); p != nil {
					t.Fatalf("seed %d panicked: %v\n  after: %s", seed, p, u.trail())
				}
			}()
			for range 80 {
				m.Update(u.event(m))
				if m.quitting {
					// The app has exited: one more draw happens, and it must not block or panic.
					m.View()
					return
				}
				if err := checkFrame(m); err != nil {
					t.Fatalf("seed %d: %v\n  after: %s", seed, err, u.trail())
				}
			}
			// Escape gets out of any dialog, however it got there.
			for range 5 {
				if m.overlay == nil {
					break
				}
				m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
			}
			if m.overlay != nil {
				t.Fatalf("seed %d: escape does not close %T\n  after: %s", seed, m.overlay, u.trail())
			}
		}()
	}
}

func TestEveryAppHoldsTheFrameAtEverySizeWithTheWallpaper(t *testing.T) {
	apps := []string{"chat", "files", "search", "sessions", "models", "themes", "keys", "stats", "changes", "gallery", "tasks", "settings", "providers", "help", "start", "notifications"}
	for _, app := range apps {
		for _, size := range [][2]int{{220, 70}, {130, 34}, {80, 24}, {40, 12}, {12, 5}} {
			for _, wallpaper := range []bool{true, false} {
				m, _ := newTestModel(t)
				m.opts.NoWallpaper = !wallpaper
				m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
				func() {
					defer func() {
						if p := recover(); p != nil {
							t.Fatalf("%s at %dx%d panicked: %v", app, size[0], size[1], p)
						}
					}()
					m.runAction(app)
				}()
				if err := checkFrame(m); err != nil {
					t.Fatalf("%s at %dx%d (wallpaper %v): %v", app, size[0], size[1], wallpaper, err)
				}
			}
		}
	}
}

func TestTheFrameIsAPureFunctionOfTheState(t *testing.T) {
	// Drawing the same state twice draws the same thing: no frame depends on having drawn the last.
	m := wallpaperModel(t, 130, 34)
	m.opts.Motion = false
	for _, setup := range []func(){func() {}, func() { m.runAction("files") }, func() { m.runAction("start") }} {
		setup()
		a := m.View().Content
		if b := m.View().Content; a != b {
			t.Fatal("two draws of one state differ")
		}
	}
}
