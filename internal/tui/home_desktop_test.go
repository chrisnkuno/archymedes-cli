package tui

import (
	"testing"

	tea "charm.land/bubbletea/v2"
)

func TestTheWelcomeAndWallpaperIconsOpenTheirsDirectly(t *testing.T) {
	m := projectModel(t)
	m.Update(tea.WindowSizeMsg{Width: 140, Height: 40})
	open := func(id string) {
		for i, app := range m.desktopApps() {
			if app.id == id {
				m.openIcon(i)
				return
			}
		}
		t.Fatalf("no %s icon", id)
	}
	open("wallpaper")
	if _, ok := m.activeWindow().(*wallpaperPicker); !ok {
		t.Fatalf("the Wallpaper icon opened %T", m.activeWindow())
	}
	m.closeWindow(m.active)
	open("welcome")
	if _, ok := m.overlay.(*onboarding); !ok {
		t.Fatalf("the Welcome icon opened %T", m.overlay)
	}
	for _, app := range m.desktopApps() {
		if app.id == "showcase" {
			t.Fatal("the tour plays in its panel; it has no icon")
		}
	}
}
