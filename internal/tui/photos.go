package tui

import (
	"fmt"
	"strings"
	"time"

	"charm.land/lipgloss/v2"
	"github.com/NimbleMarkets/ntcharts/v2/picture"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/gallery"
)

// Photographs (internal/gallery), drawn with ntcharts' picture component in half-block glyphs, so
// they show in any colour terminal with no graphics protocol. The home screen turns through them
// beside the mark; empty states use one that fits what they are about. A drawing is a pure
// function of the photo and its size, so it is drawn once and kept.

const photoInterval = 9 * time.Second

// photoLines is p drawn in cols×rows cells, cropped to fill them; nil when photos are off.
func (m *Model) photoLines(p gallery.Photo, cols, rows int) []string {
	if m.opts.NoPhotos || cols < 6 || rows < 3 {
		return nil
	}
	key := fmt.Sprintf("%s|%d|%d", p.ID, cols, rows) // the cache is dropped when the cell size changes
	if lines, ok := m.photoCache[key]; ok {
		return lines
	}
	img, err := p.Image()
	if err != nil {
		return nil
	}
	pic := picture.NewWithConfig(picture.Config{Fit: picture.FitCover, CellPixelWidth: m.cellW, CellPixelHeight: m.cellH})
	pic.SetImage(img)
	pic.SetSize(cols, rows)
	lines := strings.Split(pic.View().Content, "\n")
	if m.photoCache == nil || len(m.photoCache) > 48 {
		m.photoCache = map[string][]string{} // sizes change with the window; keep the cache small
	}
	m.photoCache[key] = lines
	return lines
}

// photoCard is a photo with its caption under it: what it shows, and who took it (linked to the
// photo's page on Unsplash, where the terminal supports links).
func (m *Model) photoCard(p gallery.Photo, cols, rows int) []string {
	lines := m.photoLines(p, cols, rows)
	if lines == nil {
		return nil
	}
	th := m.th
	credit := lipgloss.NewStyle().Foreground(th.Muted).Hyperlink(p.URL()).Render(ansi.Truncate("by "+p.By+" · Unsplash", cols, "…"))
	return append(lines,
		th.Body.Render(ansi.Truncate(p.Title, cols, "…")),
		credit,
	)
}

// homePhoto is the wallpaper now, antiquity and sci-fi in turn: it turns every photoInterval, or
// with reduced motion stays on the day's.
func (m *Model) homePhoto() gallery.Photo {
	return gallery.Wallpaper(m.photoIndex)
}

// turnPhoto advances the home screen's photo when its time is up; called on the landing's tick.
func (m *Model) turnPhoto(now time.Time) {
	if !m.opts.Motion {
		return
	}
	if m.photoAt.IsZero() {
		m.photoAt = now
		return
	}
	if now.Sub(m.photoAt) >= photoInterval {
		m.photoIndex++
		m.photoAt = now
	}
}

// emptyState is a centred photo above a message, for a window with nothing in it yet; just the
// message when there is no room (or photos are off).
func (m *Model) emptyState(p gallery.Photo, message []string, width, height int) []string {
	cols, rows := min(30, width-4), min(11, height-len(message)-4)
	block := m.photoCard(p, cols, rows)
	if block != nil {
		block = append(block, "")
	}
	return centre(append(block, message...), width, height)
}
