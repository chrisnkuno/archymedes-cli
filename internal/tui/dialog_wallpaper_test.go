package tui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/gallery"
)

func TestTheWallpaperPickerPreviewsKeepsAndRemembers(t *testing.T) {
	m, dir := firstRunModel(t)
	typeText(m, "/wallpaper")
	press(m, tea.KeyEnter, 0)
	if _, ok := m.overlay.(*wallpaperPicker); !ok || !strings.Contains(screen(m), "Take turns") {
		t.Fatalf("no picker:\n%s", screen(m))
	}
	press(m, tea.KeyDown, 0) // abstract only, taking turns: shown at once
	if m.wallChoice != "turns:abstract" || m.homePhoto().Theme != "abstract" || !strings.Contains(screen(m), "Take turns: abstract only") {
		t.Fatalf("preview = %q, %s", m.wallChoice, m.homePhoto().ID)
	}
	for range 3 {
		press(m, tea.KeyDown, 0) // past sci-fi and antiquity only, to the first single picture
	}
	first := m.overlay.(*wallpaperPicker).choices[m.overlay.(*wallpaperPicker).cursor]
	if p, ok := gallery.ByID(first); !ok || p.Theme != "abstract" || m.homePhoto().ID != first {
		t.Fatalf("the first single picture should be abstract: %q", first)
	}
	press(m, tea.KeyEscape, 0) // a preview is not a choice
	if m.wallChoice != "" || config.LoadState(dir).Wallpaper != "" {
		t.Fatal("esc should put back what was there")
	}

	m.welcome() // saved first, so the wallpaper saved after it must keep it
	m.openOverlay(newWallpaperPicker(m))
	press(m, tea.KeyUp, 0) // wraps to None
	press(m, tea.KeyEnter, 0)
	if m.overlay != nil || m.wallChoice != wallpaperNone || !m.wallpaperOff() || config.LoadState(dir).Wallpaper != wallpaperNone {
		t.Fatalf("None was not kept: %q", m.wallChoice)
	}
	if strings.Contains(screen(m), "Unsplash") {
		t.Fatal("no photo, so no credit")
	}
	// Remembered next time, and the welcome is not lost by saving it.
	again := New(Options{ConfigDir: dir})
	if again.wallChoice != wallpaperNone || !again.welcomed {
		t.Fatalf("not remembered: wallpaper %q, welcomed %v", again.wallChoice, again.welcomed)
	}
}

func TestTheGalleryMakesThePhotoInFrontTheWallpaper(t *testing.T) {
	m, dir := firstRunModel(t)
	m.opts.NoPhotos = false
	run(m, m.openGallery(3))
	press(m, 'w', 0)
	want := gallery.Pick(3)
	if m.wallChoice != want.ID || m.homePhoto().ID != want.ID || config.LoadState(dir).Wallpaper != want.ID {
		t.Fatalf("wallpaper = %q, want %q", m.wallChoice, want.ID)
	}
	m.photoIndex += 5 // a kept wallpaper does not take turns
	if m.homePhoto().ID != want.ID {
		t.Fatal("the kept wallpaper turned")
	}
}
