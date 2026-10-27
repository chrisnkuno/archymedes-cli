package tui

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// Images in a request: a path to a picture anywhere in it (typed, @-mentioned, or dropped onto the
// terminal, which pastes the path, quoted or with its spaces escaped) is sent along as the image,
// and the path stays in the text so the model knows which file it is.

// imageTypes are the pictures that travel, by extension.
var imageTypes = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp"}

// maxAttachedImage is the most one picture may be (the engine refuses more).
const maxAttachedImage = 5 << 20

// attachedImages finds the pictures a request names. skipped says why a named one was not sent.
func attachedImages(text, cwd string) (images []acp.Image, skipped []string) {
	seen := map[string]bool{}
	for _, token := range pathTokens(text) {
		token = strings.TrimPrefix(token, "@")
		if u, err := url.Parse(token); err == nil && u.Scheme == "file" {
			token = u.Path
		}
		mime := imageTypes[strings.ToLower(filepath.Ext(token))]
		if mime == "" {
			continue
		}
		path := token
		if strings.HasPrefix(path, "~/") {
			if home, err := os.UserHomeDir(); err == nil {
				path = filepath.Join(home, path[2:])
			}
		}
		if !filepath.IsAbs(path) {
			path = filepath.Join(cwd, path)
		}
		if seen[path] {
			continue
		}
		seen[path] = true
		info, err := os.Stat(path)
		switch {
		case err != nil:
			continue // a word that looks like a file name but is not one: nothing to attach
		case info.Size() > maxAttachedImage:
			skipped = append(skipped, filepath.Base(path)+" is over 5 MB")
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			skipped = append(skipped, filepath.Base(path)+": "+err.Error())
			continue
		}
		images = append(images, acp.Image{MimeType: mime, Data: data, URI: "file://" + path})
	}
	return images, skipped
}

// pathTokens splits text at spaces, keeping quoted runs and backslash-escaped spaces together.
func pathTokens(text string) []string {
	var out []string
	var cur strings.Builder
	quote := rune(0)
	escaped := false
	flush := func() {
		if cur.Len() > 0 {
			out = append(out, cur.String())
			cur.Reset()
		}
	}
	for _, r := range text {
		switch {
		case escaped:
			cur.WriteRune(r)
			escaped = false
		case r == '\\' && quote == 0:
			escaped = true
		case quote != 0 && r == quote:
			quote = 0
		case quote == 0 && (r == '"' || r == '\''):
			quote = r
		case quote == 0 && (r == ' ' || r == '\n' || r == '\t'):
			flush()
		default:
			cur.WriteRune(r)
		}
	}
	flush()
	return out
}
