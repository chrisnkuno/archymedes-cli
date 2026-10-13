package render

import (
	"sort"
	"strings"
	"sync"

	"charm.land/glamour/v2"
	"charm.land/glamour/v2/ansi"
	"charm.land/glamour/v2/styles"

	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

// Markdown renders assistant text for a width, in the theme's colours.
//
// Glamour renderers are costly to build and safe to reuse, so one is kept per width; a resize adds
// at most one more. Safe for concurrent use.
type Markdown struct {
	mu        sync.Mutex
	config    ansi.StyleConfig
	renderers map[int]*glamour.TermRenderer
}

// NewMarkdown starts from glamour's dark or light style and repaints its roles from th.
func NewMarkdown(th theme.Theme) *Markdown {
	return &Markdown{config: markdownStyle(th), renderers: map[int]*glamour.TermRenderer{}}
}

// Render returns text as styled lines no wider than width, with no leading or trailing blank lines.
// On a renderer failure it returns the text itself: a reply shown plain beats a reply not shown.
func (m *Markdown) Render(text string, width int) string {
	width = max(width, 20)
	m.mu.Lock()
	r := m.renderers[width]
	if r == nil {
		var err error
		r, err = glamour.NewTermRenderer(glamour.WithStyles(m.config), glamour.WithWordWrap(width))
		if err != nil {
			m.mu.Unlock()
			return text
		}
		m.renderers[width] = r
	}
	out, err := r.Render(text)
	m.mu.Unlock()
	if err != nil {
		return text
	}
	return strings.Trim(out, "\n")
}

func markdownStyle(th theme.Theme) ansi.StyleConfig {
	config := styles.DarkStyleConfig
	if th.Light {
		config = styles.LightStyleConfig
	}
	t := th.Tokens
	ptr := func(s string) *string { v := theme.Spec(s); return &v }
	yes := func() *bool { v := true; return &v }
	zero := func() *uint { v := uint(0); return &v }

	// The transcript owns the margins and gutters; the document adds none of its own.
	config.Document.Margin = zero()
	config.Document.BlockPrefix, config.Document.BlockSuffix = "", ""
	config.Document.Color = ptr(t.Text)
	config.Heading.Color = ptr(t.Primary)
	config.Heading.Bold = yes()
	config.H1.Color, config.H1.BackgroundColor = ptr(t.Bg), ptr(t.Primary)
	config.Link.Color = ptr(t.Secondary)
	config.LinkText.Color = ptr(t.Secondary)
	config.Code.Color = ptr(t.Accent)
	// Glamour pads a code span with a space each side for its background; without the
	// background the padding just reads as a double space in the sentence.
	config.Code.BackgroundColor = nil
	config.Code.Prefix, config.Code.Suffix = "", ""
	config.CodeBlock.Margin = zero()
	config.BlockQuote.Color = ptr(t.TextMuted)
	config.HorizontalRule.Color = ptr(t.BorderColor)
	config.Item.Color = ptr(t.Text)
	config.Enumeration.Color = ptr(t.Primary)
	config.Strong.Color = ptr(t.Text)
	config.Emph.Color = ptr(t.Text)
	return config
}

func sortedKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
