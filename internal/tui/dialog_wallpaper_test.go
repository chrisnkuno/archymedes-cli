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
	press(m, tea.KeyDown, 0) // the first photo: shown at once
	first := gallery.Photos[0]
	if m.wallChoice != first.ID || m.homePhoto() != first {
		t.Fatalf("preview = %q", m.wallChoice)
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
	if m.wallChoice != want.ID || m.homePhoto() != want || config.LoadState(dir).Wallpaper != want.ID {
		t.Fatalf("wallpaper = %q, want %q", m.wallChoice, want.ID)
	}
	m.photoIndex += 5 // a kept wallpaper does not take turns
	if m.homePhoto() != want {
		t.Fatal("the kept wallpaper turned")
	}
}
