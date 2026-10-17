package tui

import (
	"fmt"
	"image"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"github.com/NimbleMarkets/ntcharts/v2/picture"
	"github.com/NimbleMarkets/ntcharts/v2/picture/pictureurl"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/gallery"
)

// The Gallery app (F12, or a click on the home screen's photo): one photograph at a time, two ways
// side by side — the copy built into Archymedes (ntcharts picture.Model) and the full-resolution
// original fetched live from Unsplash's image CDN (pictureurl.Model). Both draw in half-block glyphs
// everywhere, and in the Kitty graphics protocol where the terminal has it (g), at a choice of fit
// (f). Shaped on ntcharts' own picture example: the models persist, every message reaches them,
// sizes are applied in Update and never in View, and each pane is a label, the picture, and its
// captions pinned to the bottom.

const (
	kittyIDBuiltIn = 4242
	kittyIDLive    = 4243
	// livePhotoWidth is the width asked of the CDN: sharp in any terminal pane, ~300 KB.
	livePhotoWidth = 960
)

type galleryApp struct {
	index   int
	builtIn picture.Model
	live    pictureurl.Model
	offline bool // ARCHYMEDES_PHOTOS=local: only the built-in copy, no network
	// source is where a photo's full-resolution copy is fetched from (tests point it elsewhere).
	source func(gallery.Photo) string
	// cols×rows each picture was last sized to, so a relayout that changes nothing does nothing.
	cols, rows int
	// How it draws (sixel.go): the mode, whether someone chose it with g, whether the terminal
	// draws Sixel, what the Sixel pictures on screen were drawn for, and the fetched photos (Sixel
	// draws them itself; pictureurl keeps its own copy for glyphs and Kitty).
	mode    pictureMode
	chosen  bool
	sixel   bool
	fetched map[string]image.Image
}

// builtInImage is the shown photo's built-in copy.
func (g *galleryApp) builtInImage() image.Image {
	img, _ := gallery.Pick(g.index).Image()
	return img
}

// liveImage is the shown photo's full-resolution copy, once fetched.
func (g *galleryApp) liveImage() image.Image {
	if g.offline {
		return nil
	}
	return g.fetched[g.live.CurrentURL()]
}

func (g *galleryApp) title() string { return "Gallery" }
func (g *galleryApp) key() string   { return "gallery" }

func (m *Model) galleryWindow() *galleryApp {
	for _, w := range m.windows {
		if g, ok := w.(*galleryApp); ok {
			return g
		}
	}
	return nil
}

// openGallery opens the Gallery on photo index (or focuses it there when it is open).
func (m *Model) openGallery(index int) tea.Cmd {
	if m.opts.NoPhotos {
		return m.toast(toastInfo, "Photos are off (ARCHYMEDES_PHOTOS=off)")
	}
	if g := m.galleryWindow(); g != nil {
		m.openWindow(g)
		return g.show(m, index)
	}
	g := &galleryApp{
		index:   index,
		sixel:   m.sixel,
		offline: m.opts.PhotosOffline,
		fetched: map[string]image.Image{},
		source:  func(p gallery.Photo) string { return p.Full(livePhotoWidth) },
		builtIn: picture.NewWithConfig(picture.Config{KittyID: kittyIDBuiltIn, Fit: picture.FitContain}),
		live: pictureurl.NewWithConfig(pictureurl.Config{
			KittyID: kittyIDLive, Fit: picture.FitContain,
			// Image hosts turn away Go's stock User-Agent; say who is asking.
			UserAgent: "archymedes/" + m.opts.Version + " (+https://github.com/chrisnkuno/friday-cli)",
		}),
	}
	m.openWindow(g)
	// The terminal's real cell size (for Kitty pictures that fill their cells), whether it speaks
	// Kitty graphics at all — asked once per process — and the first photo.
	// And whether it draws Sixel (attribute 4 of its primary device attributes), with its window
	// size in pixels for terminals that do not report their cell size.
	return tea.Batch(picture.RequestCellSize(), tea.Raw(ansi.RequestPrimaryDeviceAttributes+ansi.WindowOp(14)),
		picture.QueryKittySupport(), g.builtIn.Init(), g.live.Init(), g.show(m, index))
}

// show switches both panes to photo index.
func (g *galleryApp) show(m *Model, index int) tea.Cmd {
	n := len(gallery.Photos)
	g.index = (index%n + n) % n
	p := gallery.Pick(g.index)
	var cmds []tea.Cmd
	if img, err := p.Image(); err == nil {
		cmds = append(cmds, g.builtIn.SetImage(img))
	}
	if !g.offline {
		cmds = append(cmds, g.live.SetURL(g.source(p)))
	}
	return tea.Batch(append(cmds, g.relayout(m))...)
}

// update forwards a picture message (a fetched photo, a Kitty frame, the terminal's cell size or
// its answer to the Kitty probe) to both pictures; each ignores what is not its own.
func (g *galleryApp) update(m *Model, msg tea.Msg) tea.Cmd {
	if loaded, ok := msg.(pictureurl.ImageLoadedMsg); ok && loaded.Err == nil && loaded.Img != nil {
		if len(g.fetched) > 8 {
			g.fetched = map[string]image.Image{}
		}
		g.fetched[loaded.URL] = loaded.Img
	}
	cmds := []tea.Cmd{g.builtIn.Update(msg), g.live.Update(msg), g.relayout(m)}
	return tea.Batch(append(cmds, g.upgrade())...) // the Kitty probe may have just answered
}

// galleryLayout is where everything goes for the current window size.
type galleryLayout struct {
	panes      int // 2 side by side, 1 alone, 0 too small
	paneWidth  int // outer, border included
	innerCols  int
	innerRows  int
	pictureRow int // rows left for the picture after the label and captions
}

const galleryCaptionRows = 3

func (g *galleryApp) layout(m *Model) galleryLayout {
	height := max(m.windowHeight()-2, 0) // a header row above, a footer row below
	var l galleryLayout
	switch {
	case m.width >= 72 && !g.offline:
		l.panes, l.paneWidth = 2, (m.width-1)/2
	case m.width >= 30:
		l.panes, l.paneWidth = 1, m.width
	}
	l.innerCols, l.innerRows = l.paneWidth-2, height-2
	l.pictureRow = l.innerRows - 1 - galleryCaptionRows
	if l.panes == 0 || l.innerCols < 12 || l.pictureRow < 3 {
		l.panes = 0
	}
	return l
}

// relayout sizes both pictures to the panes; nothing when the size is unchanged.
func (g *galleryApp) relayout(m *Model) tea.Cmd {
	l := g.layout(m)
	if l.panes == 0 || (l.innerCols == g.cols && l.pictureRow == g.rows) {
		return nil
	}
	g.cols, g.rows = l.innerCols, l.pictureRow
	return tea.Batch(g.builtIn.SetSize(l.innerCols, l.pictureRow), g.live.SetSize(l.innerCols, l.pictureRow))
}

func (g *galleryApp) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "q", "ctrl+c":
		// Take the pictures down with the window: a Kitty image is removed from the terminal too.
		return true, tea.Batch(g.builtIn.SetImage(nil), g.live.Clear())
	case "right", "l", "n", "space":
		return false, g.show(m, g.index+1)
	case "left", "h", "p":
		return false, g.show(m, g.index-1)
	case "f":
		next := nextFit(g.builtIn.Fit())
		return false, tea.Batch(g.builtIn.SetFit(next), g.live.SetFit(next))
	case "g":
		modes := g.modes()
		if len(modes) == 1 {
			return false, m.toast(toastInfo, "This terminal draws neither Kitty graphics nor Sixel; glyphs are the sharpest it can")
		}
		next := modes[0]
		for i, mode := range modes {
			if mode == g.mode {
				next = modes[(i+1)%len(modes)]
			}
		}
		return false, g.setMode(next)
	case "r":
		if !g.offline {
			return false, g.live.Reload()
		}
	}
	return false, nil
}

func (g *galleryApp) view(m *Model) string {
	th := m.th
	p := gallery.Pick(g.index)
	l := g.layout(m)
	header := spread(" "+th.Title.Render("Gallery")+th.Faint.Render(fmt.Sprintf("  %d of %d · %s", g.index+1, len(gallery.Photos), p.Theme)),
		g.kittyBadge(m)+" ", m.width)
	body := max(m.windowHeight()-2, 0)
	var rows []string
	if l.panes == 0 {
		rows = centre([]string{th.Faint.Render("Make the window larger to see the photo.")}, m.width, body)
	} else {
		builtInContent := g.builtIn.View().Content
		if g.mode == modeSixel {
			builtInContent = "" // drawn over by the Sixel picture
		}
		builtIn := g.pane(m, l, "built into Archymedes · 360 px", builtInContent, p, "photos/"+p.ID+".jpg")
		var block string
		if l.panes == 2 {
			live := g.pane(m, l, "live from Unsplash · "+fmt.Sprint(livePhotoWidth)+" px", g.liveContent(m, l), p, g.source(p))
			block = lipgloss.JoinHorizontal(lipgloss.Top, builtIn, " ", live)
		} else {
			block = builtIn
		}
		rows = fitLines(strings.Split(block, "\n"), m.width, body)
	}
	return strings.Join(append(append([]string{header}, rows...), " "+th.Faint.Render(ansi.Truncate(g.footer(), max(m.width-2, 0), "…"))), "\n")
}

// liveContent is the live picture, or what is happening instead of it.
func (g *galleryApp) liveContent(m *Model, l galleryLayout) string {
	th := m.th
	switch g.live.State() {
	case pictureurl.StateLoading:
		return m.spin.View() + th.Faint.Render(" loading from Unsplash…")
	case pictureurl.StateError:
		return th.Bad.Render(ansi.Wrap("Could not load it: "+g.live.Err().Error(), l.innerCols-2, "")) + "\n" + th.Faint.Render("r tries again; the built-in copy is beside it")
	}
	if g.mode == modeSixel {
		return "" // the Sixel picture is drawn over these cells
	}
	return g.live.View().Content
}

// pane is one bordered box: a label across the top, the picture centred, captions at the foot.
func (g *galleryApp) pane(m *Model, l galleryLayout, label, content string, p gallery.Photo, source string) string {
	th := m.th
	top := lipgloss.NewStyle().Foreground(th.Bg).Background(th.Primary).Bold(true).Width(l.innerCols).Align(lipgloss.Center).
		Render(ansi.Truncate(label, l.innerCols, "…"))
	middle := lipgloss.Place(l.innerCols, l.pictureRow, lipgloss.Center, lipgloss.Center, content)
	caption := lipgloss.NewStyle().Width(l.innerCols).Align(lipgloss.Center)
	captions := []string{
		caption.Inherit(th.Body).Render(ansi.Truncate(p.Title, l.innerCols, "…")),
		caption.Inherit(th.Faint).Hyperlink(p.URL()).Render(ansi.Truncate("by "+p.By+" · Unsplash", l.innerCols, "…")),
		caption.Inherit(th.Faint).Render(ansi.Truncate(source, l.innerCols, "…")),
	}
	inner := strings.Join(append([]string{top, middle}, captions...), "\n")
	// Lip Gloss v2 counts the border inside Width and Height.
	return lipgloss.NewStyle().Border(th.Border).BorderForeground(th.BorderColor).
		Width(l.innerCols + 2).Height(l.innerRows + 2).Render(inner)
}

func (g *galleryApp) footer() string {
	parts := []string{"drawn as " + g.mode.String(), "fit " + fitName(g.builtIn.Fit()), "←/→ photo", "f fit"}
	if len(g.modes()) > 1 {
		parts = append(parts, "g how it draws")
	}
	if !g.offline {
		parts = append(parts, "r reload")
	}
	return strings.Join(append(parts, "esc close"), " · ")
}

// kittyBadge says which graphics the terminal draws: Kitty (yes, no, or still asking) and Sixel.
func (g *galleryApp) kittyBadge(m *Model) string {
	th := m.th
	kitty := th.Warn.Render("Kitty: asking…")
	switch g.builtIn.KittySupported() {
	case picture.KittyCapabilitySupported:
		kitty = th.OK.Render("Kitty: yes")
	case picture.KittyCapabilityUnsupported:
		kitty = th.Faint.Render("Kitty: no")
	}
	sixel := th.Faint.Render("Sixel: no")
	if g.sixel {
		sixel = th.OK.Render("Sixel: yes")
	}
	return kitty + th.Faint.Render(" · ") + sixel
}

func nextFit(f picture.FitMode) picture.FitMode {
	switch f {
	case picture.FitContain:
		return picture.FitCover
	case picture.FitCover:
		return picture.FitFill
	}
	return picture.FitContain
}

func fitName(f picture.FitMode) string {
	switch f {
	case picture.FitCover:
		return "cover"
	case picture.FitFill:
		return "fill"
	}
	return "contain"
}
