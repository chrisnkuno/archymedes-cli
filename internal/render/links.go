package render

import (
	"net/url"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"charm.land/lipgloss/v2"
	"charm.land/lipgloss/v2/tree"

	"github.com/chrisnkuno/friday-cli/internal/theme"
)

// FileLink draws text as an OSC 8 hyperlink to path (relative to root): clickable where the
// terminal supports it, unchanged where it does not.
func FileLink(style lipgloss.Style, text, root, path string) string {
	if path == "" || root == "" {
		return style.Render(text)
	}
	abs := path
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(root, filepath.FromSlash(path))
	}
	target := url.URL{Scheme: "file", Path: filepath.ToSlash(abs)}
	return style.Hyperlink(target.String()).Render(text)
}

var webURL = regexp.MustCompile(`https?://[^\s<>"'` + "`" + `]+[^\s<>"'.,;:)\]` + "`" + `]`)

// LinkURLs draws text in style with every http(s) URL in it made a hyperlink.
func LinkURLs(style lipgloss.Style, text string) string {
	matches := webURL.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		return style.Render(text)
	}
	var b strings.Builder
	last := 0
	for _, m := range matches {
		b.WriteString(style.Render(text[last:m[0]]))
		link := text[m[0]:m[1]]
		b.WriteString(style.Underline(true).Hyperlink(link).Render(link))
		last = m[1]
	}
	b.WriteString(style.Render(text[last:]))
	return b.String()
}

// PathTree draws a listing of paths as a tree (directories marked with a trailing "/" or implied
// by their children), or nil when the lines do not look like paths.
func PathTree(th theme.Theme, lines []string) []string {
	var paths []string
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.ContainsAny(line, " \t:") && !strings.Contains(line, "/") {
			return nil // prose, not a listing
		}
		paths = append(paths, strings.TrimPrefix(line, "./"))
	}
	if len(paths) < 2 {
		return nil
	}
	sort.Strings(paths)

	type node struct {
		t        *tree.Tree
		children map[string]*node
	}
	root := &node{t: tree.New(), children: map[string]*node{}}
	for _, p := range paths {
		isDir := strings.HasSuffix(p, "/")
		parts := strings.Split(strings.TrimSuffix(p, "/"), "/")
		cur := root
		for i, part := range parts {
			last := i == len(parts)-1
			if last && !isDir {
				cur.t.Child(part)
				break
			}
			next, ok := cur.children[part]
			if !ok {
				next = &node{t: tree.Root(part + "/"), children: map[string]*node{}}
				cur.children[part] = next
				cur.t.Child(next.t)
			}
			cur = next
		}
	}
	root.t.EnumeratorStyle(th.Faint).IndenterStyle(th.Faint).ItemStyle(th.Body).RootStyle(th.Highlight)
	return strings.Split(root.t.String(), "\n")
}
