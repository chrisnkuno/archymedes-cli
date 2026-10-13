package tui

import (
	"context"
	"image/color"
	"strings"
	"testing"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/archymedes-cli/internal/acp"
)

func assertFits(t *testing.T, m *Model, label string) {
	t.Helper()
	rows := strings.Split(m.View().Content, "\n")
	if len(rows) != m.height {
		t.Fatalf("%s at %dx%d: %d rows", label, m.width, m.height, len(rows))
	}
	for i, row := range rows {
		if w := ansi.StringWidth(row); w > m.width {
			t.Fatalf("%s at %dx%d: row %d is %d wide: %q", label, m.width, m.height, i, w, ansi.Strip(row))
		}
	}
}

// Every new surface holds the frame invariant at every size, alone and stacked with toasts.
func TestEveryViewFitsTheTerminal(t *testing.T) {
	m, _ := newTestModel(t)
	views := map[string]func(){
		"landing": func() {},
		"help":    func() { m.openOverlay(helpOverlay{}) },
		"palette": func() { m.openOverlay(newPalette(m)) },
		"themes":  func() { m.openOverlay(newThemePicker(m)) },
		"toasts": func() {
			m.toast(toastInfo, strings.Repeat("a very long toast ", 10))
			m.toast(toastWarn, "second")
		},
	}
	for _, size := range [][2]int{{100, 30}, {80, 24}, {50, 16}, {30, 8}, {12, 3}, {200, 60}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		for name, open := range views {
			m.overlay, m.toasts = nil, nil
			open()
			assertFits(t, m, name)
		}
	}
}

func TestLandingShowsTheMarkThenGivesWayToTheConversation(t *testing.T) {
	m, _ := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	s := screen(m)
	for _, want := range []string{"◇", "A R C H Y M E D E S", "ctrl+p", "commands"} {
		if !strings.Contains(s, want) {
			t.Fatalf("landing lacks %q:\n%s", want, s)
		}
	}
	m.angle = 0
	before := screen(m)
	m.Update(animTickMsg{})
	if screen(m) == before {
		t.Fatal("the mark does not turn")
	}
	typeText(m, "hello")
	press(m, tea.KeyEnter, 0)
	if strings.Contains(screen(m), "A R C H Y M E D E S") {
		t.Fatal("landing still shown during a conversation")
	}
	// Its tick chain ends by itself once the landing is gone: no repainting for nothing.
	if _, cmd := m.Update(animTickMsg{}); cmd != nil || m.animated {
		t.Fatal("landing animation kept ticking")
	}
}

func TestSpinnerOnlyTicksWhileSomethingIsHappening(t *testing.T) {
	m, _ := newTestModel(t)
	if _, cmd := m.Update(spinner.TickMsg{}); cmd != nil {
		t.Fatal("idle spinner keeps ticking")
	}
	typeText(m, "go")
	if cmd := press(m, tea.KeyEnter, 0); cmd == nil || !m.spinning {
		t.Fatal("a turn starts the spinner")
	}
	if !strings.Contains(screen(m), "thinking…") {
		t.Fatalf("no thinking line before the first token:\n%s", screen(m))
	}
	m.Update(agentMsg{acp.TextChunk{Text: "hi"}})
	if strings.Contains(screen(m), "thinking…") {
		t.Fatal("thinking line stays once text streams")
	}
}

func TestPaletteFiltersAndRuns(t *testing.T) {
	m, agent := newTestModel(t)
	press(m, 'p', tea.ModCtrl)
	p, ok := m.overlay.(*paletteOverlay)
	if !ok {
		t.Fatal("ctrl+p opens the palette")
	}
	typeText(m, "pln")
	if len(p.shown) == 0 || p.shown[0].label != "/plan" {
		t.Fatalf("fuzzy ranking: %v", p.shown)
	}
	run(m, press(m, tea.KeyEnter, 0))
	if m.overlay != nil || m.mode != "plan" || len(agent.modes) != 1 {
		t.Fatalf("overlay=%v mode=%s", m.overlay, m.mode)
	}
	press(m, 'p', tea.ModCtrl)
	typeText(m, "zzzz")
	if !strings.Contains(screen(m), "nothing matches") {
		t.Fatal(screen(m))
	}
	press(m, tea.KeyEscape, 0)
	if m.overlay != nil || m.input.value() != "" {
		t.Fatal("esc closes the palette without typing into the input")
	}
}

func TestThemePickerPreviewsAndEscapeReverts(t *testing.T) {
	m, _ := newTestModel(t)
	start := m.th.Name
	press(m, 't', tea.ModCtrl)
	press(m, tea.KeyDown, 0)
	if m.th.Name == start {
		t.Fatal("moving the selection previews the theme")
	}
	press(m, tea.KeyEscape, 0)
	if m.th.Name != start || m.overlay != nil {
		t.Fatalf("esc reverts: %s", m.th.Name)
	}
	press(m, 't', tea.ModCtrl)
	press(m, tea.KeyDown, 0)
	chosen := m.th.Name
	press(m, tea.KeyEnter, 0)
	if m.th.Name != chosen || !strings.Contains(screen(m), "Theme: "+chosen) {
		t.Fatal("enter keeps the previewed theme and says so")
	}
}

func TestToastsExpireAndModeChangesUseThem(t *testing.T) {
	m, _ := newTestModel(t)
	typeText(m, "/plan")
	run(m, press(m, tea.KeyEnter, 0))
	if !strings.Contains(screen(m), "Mode: plan") || len(m.tr.items) != 0 {
		t.Fatalf("a mode change is a toast, not a transcript line:\n%s", screen(m))
	}
	m.Update(toastExpiredMsg{id: m.toasts[0].id})
	if strings.Contains(screen(m), "Mode: plan") {
		t.Fatal("toast did not expire")
	}
}

func TestQuestionMarkIsHelpOnlyOnAnEmptyInput(t *testing.T) {
	m, _ := newTestModel(t)
	typeText(m, "why")
	typeText(m, "?")
	if m.overlay != nil || m.input.value() != "why?" {
		t.Fatalf("? was swallowed: %q", m.input.value())
	}
	m.input.take()
	typeText(m, "?")
	if _, ok := m.overlay.(helpOverlay); !ok {
		t.Fatal("? on an empty input opens help")
	}
}

func TestTerminalIsToldWhatTheAgentIsDoing(t *testing.T) {
	m, _ := newTestModel(t)
	if v := m.View(); v.ProgramStatus.State != tea.ProgramStateIdle || v.ProgressBar != nil {
		t.Fatal("idle")
	}
	typeText(m, "go")
	press(m, tea.KeyEnter, 0)
	if v := m.View(); v.ProgramStatus.State != tea.ProgramStateWorking || v.ProgressBar.State != tea.ProgressBarIndeterminate {
		t.Fatal("working")
	}
	m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{Title: "x"}, []acp.PermissionOption{{OptionID: "allow"}}, func(string) {})})
	if v := m.View(); v.ProgramStatus.State != tea.ProgramStateBlocked || v.ProgramStatus.Kind != tea.ProgramStatusKindPermission || !strings.HasPrefix(v.WindowTitle, "?") {
		t.Fatal("blocked on permission")
	}
}

func TestALightTerminalGetsTheLightThemeUnlessOneWasChosen(t *testing.T) {
	light := tea.BackgroundColorMsg{Color: color.White}
	m := New(Options{Start: func(context.Context) (Agent, error) { return nil, nil }})
	m.Update(light)
	if m.th.Name != "parchment" {
		t.Fatalf("got %s", m.th.Name)
	}
	chosen := New(Options{Theme: "chalkboard", Start: m.opts.Start})
	chosen.Update(light)
	if chosen.th.Name != "chalkboard" {
		t.Fatal("an explicit theme is kept")
	}
}

// The canvas clips whatever overflows, which would hide a box drawn too wide; so each floating box
// is measured on its own, before compositing.
func TestFloatingBoxesFitBeforeCompositing(t *testing.T) {
	m, _ := newTestModel(t)
	req := acp.NewPermissionRequestForTest(acp.ToolCallRef{Title: strings.Repeat("long title ", 20)}, []acp.PermissionOption{{OptionID: "allow", Name: "Allow this action from now on"}}, func(string) {})
	for _, width := range []int{200, 100, 50, 30, 16} {
		m.Update(tea.WindowSizeMsg{Width: width, Height: 30})
		dialog := (&approval{req: req}).view(m.th, m.width)
		if w := ansi.StringWidth(strings.Split(dialog, "\n")[0]); w > width-1 {
			t.Fatalf("approval at %d is %d wide", width, w)
		}
		for name, o := range map[string]overlay{"help": helpOverlay{}, "palette": newPalette(m), "themes": newThemePicker(m)} {
			if w := lipgloss.Width(o.view(m)); w > width {
				t.Fatalf("%s at %d is %d wide", name, width, w)
			}
		}
		if h := m.header(); !strings.Contains(ansi.Strip(h), "build") {
			t.Fatalf("mode dropped from the header at %d: %q", width, ansi.Strip(h))
		}
	}
}
