package tui

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/gallery"
)

// --- the home screen's photographs ---

func TestTheHomeScreenCreditsItsWallpaperAndOpensItOnAClick(t *testing.T) {
	m := projectModel(t)
	m.opts.NoWallpaper = false
	m.photoIndex = 0 // a photograph (the day's turn could land on a generated picture)
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 32})
	first := m.homePhoto()
	s := screen(m)
	if !strings.Contains(s, "by "+first.By) || !strings.Contains(s, "Unsplash") || !strings.Contains(s, "▀") {
		t.Fatalf("no credited photo on the home screen:\n%s", s)
	}
	// The credit links to the photo's page, where the terminal supports links.
	if !strings.Contains(m.View().Content, first.URL()) {
		t.Fatal("the credit does not link to the photo on Unsplash")
	}
	x, y := cellOf(t, m, "by "+first.By)
	click(m, x, y)
	g, ok := m.activeWindow().(*galleryApp)
	if !ok || gallery.Pick(g.index).ID != first.ID {
		t.Fatalf("a click on the photo did not open it in the Gallery: %T", m.activeWindow())
	}
}

func TestAGeneratedWallpaperIsCreditedToFridayNotUnsplash(t *testing.T) {
	m := projectModel(t)
	m.opts.NoWallpaper = false
	m.wallChoice = "art-synthwave"
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 32})
	s := screen(m)
	if !strings.Contains(s, "Synthwave horizon") || !strings.Contains(s, "drawn by Friday") || strings.Contains(s, "Unsplash") || !photoShown(s) {
		t.Fatalf("a generated wallpaper should be drawn and credited to Friday:\n%s", s)
	}
}

func TestTheHomeCardSaysWhatIsInFrontOfYou(t *testing.T) {
	m := projectModel(t)
	m.photoIndex = 0 // a photograph, credited to Unsplash
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	s := screen(m)
	for _, want := range []string{m.session.Info.Model, "build", "Unsplash", "↑ desktop"} {
		if !strings.Contains(s, want) {
			t.Errorf("the home card lacks %q:\n%s", want, s)
		}
	}
	// The card is filled with the theme's ground: no styled run ends in a bare reset that would
	// let the wallpaper, or the terminal's own background, through between the words.
	card := strings.Join(m.homeCard(130, 30, true), "\n")
	if strings.Contains(card, "\x1b[m ") {
		t.Fatal("a run inside the card ends without the ground behind it")
	}
}

func TestTheDesktopIconsOpenByArrowAndClick(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	for _, name := range []string{"Changes", "Sessions", "Finder", "Settings", "Tour"} {
		if !strings.Contains(screen(m), name) {
			t.Fatalf("no %s icon:\n%s", name, screen(m))
		}
	}
	press(m, tea.KeyUp, 0)
	if !m.desk.focused || m.desk.cursor != 0 {
		t.Fatal("↑ on an empty input did not step onto the icons")
	}
	press(m, tea.KeyDown, 0) // Changes
	press(m, tea.KeyEnter, 0)
	if _, ok := m.activeWindow().(*changesApp); !ok || m.desk.focused {
		t.Fatalf("enter on Changes opened %T", m.activeWindow())
	}
	m.focus(0)
	// Typing leaves the icons for the input.
	press(m, tea.KeyUp, 0)
	typeText(m, "x")
	if m.desk.focused || m.input.value() != "x" {
		t.Fatalf("typing on the desktop: focused=%v input=%q", m.desk.focused, m.input.value())
	}
	m.input.take()
	// A click selects; a second click opens.
	x, y := cellOf(t, m, "Settings")
	click(m, x, y)
	if !m.desk.focused || m.desktopApps()[m.desk.cursor].id != "settings" || m.activeWindow() != nil {
		t.Fatal("the first click should only select")
	}
	click(m, x, y)
	if _, ok := m.activeWindow().(*settingsApp); !ok {
		t.Fatalf("the second click opened %T", m.activeWindow())
	}
}

func TestAShortHomeScreenKeepsTheEssentials(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 80, Height: 20})
	s := screen(m)
	for _, want := range []string{"F R I D A Y", "build", strings.Fields(greeting(time.Now(), ""))[0]} { // the greeting follows the clock
		if !strings.Contains(s, want) {
			t.Errorf("a short home screen lost %q:\n%s", want, s)
		}
	}
	assertFits(t, m, "short home")
}

func TestPhotosTurnByThemselvesOnlyWithMotion(t *testing.T) {
	m := projectModel(t)
	start := m.photoIndex
	now := time.Now()
	m.turnPhoto(now)
	m.turnPhoto(now.Add(photoInterval))
	if m.photoIndex != start {
		t.Fatal("with reduced motion the photo stays put")
	}
	m.opts.Motion = true
	m.turnPhoto(now)
	m.turnPhoto(now.Add(photoInterval / 2))
	m.turnPhoto(now.Add(photoInterval))
	if m.photoIndex != start+1 {
		t.Fatalf("index %d after one interval", m.photoIndex-start)
	}
}

func TestPhotosCanBeTurnedOff(t *testing.T) {
	m := projectModel(t)
	m.opts.NoPhotos = true
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 32})
	if s := screen(m); strings.Contains(s, "Unsplash") || photoShown(s) {
		t.Fatalf("photos drawn with ARCHYMEDES_PHOTOS=off:\n%s", s)
	}
}

func TestAPhotoIsDrawnOnceForEachSize(t *testing.T) {
	m := projectModel(t)
	p := gallery.Pick(0)
	a := m.photoLines(p, 20, 8)
	if len(a) != 8 || ansi.StringWidth(a[0]) != 20 {
		t.Fatalf("%d rows, %d wide", len(a), ansi.StringWidth(a[0]))
	}
	for key := range m.photoCache {
		m.photoCache[key] = []string{"cached"}
	}
	if got := m.photoLines(p, 20, 8); len(got) != 1 {
		t.Fatal("drawn again instead of kept")
	}
}

// --- first run ---

func firstRunModel(t *testing.T) (*Model, string) {
	t.Helper()
	dir := t.TempDir()
	config.SaveState(dir, config.State{Onboarded: true}) // the walkthrough has its own tests
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{NoWallpaper: true, Start: func(context.Context) (Agent, error) { return agent, nil }, ConfigDir: dir})
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	m.Update(connectedMsg{session: acp.Session{ID: "s1"}})
	return m, dir
}

func TestAFirstRunSaysWhatToDoAndOffersRequestsToStartFrom(t *testing.T) {
	m, dir := firstRunModel(t)
	m.Update(projectStateMsg{changed: 2})
	s := screen(m)
	for _, want := range []string{"tab a start", "Counts installs anonymously", "Review my 2 changes for risks", "Explain this project"} {
		if !strings.Contains(s, want) {
			t.Fatalf("first-run home lacks %q:\n%s", want, s)
		}
	}
	// Tab fills the input with a starter, and again with the next.
	press(m, tea.KeyTab, 0)
	if got := m.input.value(); got != m.starters()[0] {
		t.Fatalf("tab gave %q", got)
	}
	press(m, tea.KeyTab, 0)
	if got := m.input.value(); got != m.starters()[1] {
		t.Fatalf("second tab gave %q", got)
	}
	// A click on a starter puts that one in.
	x, y := cellOf(t, m, "Find the riskiest code")
	click(m, x+2, y)
	if got := m.input.value(); got != m.starters()[2] {
		t.Fatalf("click gave %q", got)
	}
	// Sending it is the welcome: remembered, and the first finished turn ends with a tip.
	cmd := press(m, tea.KeyEnter, 0)
	if !config.LoadState(dir).Welcomed {
		t.Fatal("the welcome was not remembered")
	}
	m.Update(agentMsg{acp.TurnEnded{StopReason: "end_turn"}})
	run(m, cmd)
	found := false
	for _, toast := range m.toasts {
		if strings.Contains(toast.text, "First turn done") && strings.Contains(toast.text, "F10") {
			found = true
		}
	}
	if !found {
		t.Fatalf("no first-turn tip: %+v", m.toasts)
	}
}

func TestOnceWelcomedTheHomeScreenListsKeysAndTabTypesAsBefore(t *testing.T) {
	dir := t.TempDir()
	config.SaveState(dir, config.State{Welcomed: true, Onboarded: true})
	agent := &fakeAgent{messages: make(chan any, 16)}
	m := New(Options{NoWallpaper: true, Start: func(context.Context) (Agent, error) { return agent, nil }, ConfigDir: dir})
	m.Update(tea.WindowSizeMsg{Width: 130, Height: 34})
	m.Update(startedMsg{agent: agent, status: acp.SetupStatus{Configured: true}})
	m.Update(connectedMsg{session: acp.Session{ID: "s1"}})
	if s := screen(m); strings.Contains(s, "Counts installs anonymously") || !strings.Contains(s, "a start") {
		t.Fatalf("welcomed home:\n%s", s)
	}
	typeText(m, "my own words")
	press(m, tea.KeyTab, 0)
	if m.input.value() != "my own words" {
		t.Fatalf("tab replaced someone's own text: %q", m.input.value())
	}
}

// --- the Changes app ---

func changedRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	root := t.TempDir()
	git := func(args ...string) {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	write := func(rel, content string) {
		os.MkdirAll(filepath.Dir(filepath.Join(root, rel)), 0o755)
		os.WriteFile(filepath.Join(root, rel), []byte(content), 0o644)
	}
	git("init", "-q")
	write("app.go", "package app\n\nfunc One() int { return 1 }\n\nfunc Two() int { return 2 }\n")
	write("README.md", "# Demo\n")
	git("add", ".")
	git("commit", "-q", "-m", "init")
	write("app.go", "package app\n\nfunc One() int { return 11 }\n\nfunc Two() int { return 2 }\n\nfunc Three() int { return 3 }\n")
	write("notes/todo.txt", "ship it\n")
	return root
}

// openChangesAt opens the Changes app on root and delivers its reads.
func openChangesAt(t *testing.T, m *Model, root string) *changesApp {
	t.Helper()
	m.opts.Cwd = root
	deliver(m, m.runAction("changes"))
	c := m.changesWindow()
	if c == nil {
		t.Fatal("F10 opened no Changes window")
	}
	return c
}

func TestChangesListsFilesAndShowsTheSelectedDiffWithLineNumbers(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 30})
	c := openChangesAt(t, m, changedRepo(t))
	s := screen(m)
	for _, want := range []string{"Changes", "2 files", "M app.go", "? notes/todo.txt", "+3 −1", "⋯ line 1", "-func One() int { return 1 }", "+func One() int { return 11 }", "+func Three() int { return 3 }"} {
		if !strings.Contains(s, want) {
			t.Errorf("Changes lacks %q:\n%s", want, s)
		}
	}
	// Old and new line numbers in the gutter.
	if !strings.Contains(s, "   3      -func One()") || !strings.Contains(s, "        3 +func One()") {
		t.Errorf("no line numbers:\n%s", s)
	}
	// ↓ selects the next file and reads its diff; @ mentions it.
	deliver(m, press(m, tea.KeyDown, 0))
	if f, _ := c.selected(); f.Path != "notes/todo.txt" || !strings.Contains(screen(m), "+ship it") {
		t.Fatalf("second file:\n%s", screen(m))
	}
	typeText(m, "@")
	if !strings.Contains(m.input.value(), "@notes/todo.txt") {
		t.Fatalf("@ did not mention the file: %q", m.input.value())
	}
}

func TestChangesSaysSoWhenNothingChangedOrThereIsNoRepository(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not installed")
	}
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 34})
	openChangesAt(t, m, t.TempDir())
	if s := screen(m); !strings.Contains(s, "not a git repository") || !strings.Contains(s, "Unsplash") {
		t.Fatalf("outside a repository:\n%s", s)
	}
	clean := t.TempDir()
	exec.Command("git", "-C", clean, "init", "-q").Run()
	m.closeWindow(m.active)
	openChangesAt(t, m, clean)
	if s := screen(m); !strings.Contains(s, "Nothing has changed since the last commit") {
		t.Fatalf("clean repository:\n%s", s)
	}
}

func TestChangesReadsAgainWhenATurnEnds(t *testing.T) {
	m := projectModel(t)
	root := changedRepo(t)
	openChangesAt(t, m, root)
	os.WriteFile(filepath.Join(root, "README.md"), []byte("# Demo\n\nmore\n"), 0o644)
	m.phase = busy
	deliver(m, m.finishTurn(promptDoneMsg{stop: "end_turn"}))
	if !strings.Contains(screen(m), "3 files") {
		t.Fatalf("not read again after the turn:\n%s", screen(m))
	}
}

// deliver runs cmd and feeds what it produces back to the model, until nothing more comes of it.
// A command still running after a moment (a timer, a spinner tick) is left alone.
func deliver(m *Model, cmd tea.Cmd) {
	for _, msg := range collect(cmd) {
		if msg == nil {
			continue
		}
		_, next := m.Update(msg)
		deliver(m, next)
	}
}

// collect runs a command (and any batch it is), each with a moment to finish, and returns what
// they produced.
func collect(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	var msg tea.Msg
	select {
	case msg = <-done:
	case <-time.After(2 * time.Second):
		return nil
	}
	switch msg := msg.(type) {
	case tea.BatchMsg:
		var out []tea.Msg
		for _, c := range msg {
			out = append(out, collect(c)...)
		}
		return out
	case spinner.TickMsg, animTickMsg, toastExpiredMsg:
		return nil // the clock, not the work
	}
	return []tea.Msg{msg}
}

func TestDiffRowsNumberEveryLineFromItsHunk(t *testing.T) {
	m := projectModel(t)
	rows := diffRows(m, "diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -10,3 +10,4 @@ func f() {\n same\n-old\n+new\n+added\n tail\n", 60)
	plain := make([]string, len(rows))
	for i, r := range rows {
		plain[i] = ansi.Strip(r)
	}
	want := []string{"  ⋯ line 10 · func f() {", "  10   10  same", "  11      -old", "       11 +new", "       12 +added", "  12   13  tail"}
	for i, w := range want {
		if !strings.HasPrefix(plain[i], w) {
			t.Fatalf("row %d: %q, want %q\n%s", i, plain[i], w, strings.Join(plain, "\n"))
		}
	}
}

// --- the model picker's whole list ---

func TestTheModelPickerNarrowsToFreeOrReadyAndExplainsALockedModel(t *testing.T) {
	m := projectModel(t)
	run(m, m.runAction("models"))
	p, ok := m.activeWindow().(*modelPicker)
	if !ok || p.list == nil {
		t.Fatalf("models did not open: %T", m.overlay)
	}
	s := screen(m)
	for _, want := range []string{"All 5", "Free 1", "Ready to use 4", "needs GOOGLE_API_KEY", "free"} {
		if !strings.Contains(s, want) {
			t.Fatalf("picker lacks %q:\n%s", want, s)
		}
	}
	press(m, tea.KeyTab, 0)
	if len(p.shown) != 1 || !p.shown[0].Free {
		t.Fatalf("free view: %+v", p.shown)
	}
	press(m, tea.KeyTab, 0)
	for _, c := range p.shown {
		if c.Locked {
			t.Fatal("ready view shows a locked model")
		}
	}
	press(m, tea.KeyTab, 0) // back to all
	for p.shown[p.rows.cursor].Provider != "google" {
		press(m, tea.KeyDown, 0)
	}
	agent := m.agent.(*fakeAgent)
	modelsBefore := len(agent.models)
	press(m, tea.KeyEnter, 0)
	if p.pending || len(agent.models) != modelsBefore {
		t.Fatal("a locked model was switched to")
	}
	// Instead its provider's Connect dialog opens, to give it the key it lacks.
	if _, ok := m.overlay.(*connectDialog); !ok {
		t.Fatalf("expected the Connect dialog, got %T", m.overlay)
	}
	if len(m.toasts) == 0 || !strings.Contains(m.toasts[len(m.toasts)-1].text, "needs GOOGLE_API_KEY") {
		t.Fatalf("no explanation: %+v", m.toasts)
	}
	if _, ok := uniqueModel(p.list.Choices, "gemini-2.5-pro"); ok {
		t.Fatal("/model resolved to a locked model")
	}
}

// --- every new screen fits every size ---

func TestTheNewScreensFitEverySize(t *testing.T) {
	m, _ := firstRunModel(t)
	m.Update(projectStateMsg{changed: 3})
	root := changedRepo(t)
	for _, size := range [][2]int{{200, 60}, {160, 40}, {130, 32}, {100, 40}, {90, 30}, {80, 24}, {50, 16}, {30, 8}, {14, 4}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		m.focus(0)
		assertFits(t, m, "home with photo, first run")
	}
	openChangesAt(t, m, root)
	for _, size := range [][2]int{{200, 60}, {130, 32}, {80, 24}, {50, 16}, {30, 8}, {14, 4}} {
		m.Update(tea.WindowSizeMsg{Width: size[0], Height: size[1]})
		assertFits(t, m, "changes")
	}
}

func TestAClickAfterALinkOnTheSameRowLandsOnItsTarget(t *testing.T) {
	m := projectModel(t)
	link := "\x1b]8;;https://example.com/a/very/long/path/that/would/shift/everything\x1b\\credit\x1b]8;;\x1b\\"
	out := scan(m.zones.frame, link+" "+mark(m.zones.frame, "after", "target"))
	time.Sleep(20 * time.Millisecond)
	if z := m.zones.frame.Get("after"); z.StartX != len("credit ") {
		t.Fatalf("target starts at %d, want %d", z.StartX, len("credit "))
	}
	if !strings.Contains(out, "https://example.com/a/very/long") {
		t.Fatal("the link was not put back")
	}
}

func TestChangesLeavesOutTheAgentsOwnStateButNotSavedPrompts(t *testing.T) {
	for path, hidden := range map[string]bool{
		".archymedes/sessions/x.json":    true,
		".archymedes/checkpoint-index-a": true,
		".archymedes/commands/review.md": false,
		"src/.archymedes-notes.md":       false,
		"app.go":                         false,
	} {
		if agentState(path) != hidden {
			t.Errorf("%s hidden=%v", path, !hidden)
		}
	}
}
