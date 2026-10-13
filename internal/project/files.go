// Package project is what the interface knows about the project on disk: which files belong to it,
// and their contents for a preview. It never writes.
package project

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// MaxFiles bounds a listing: a project view of a million files helps nobody, and the walk must end.
const MaxFiles = 20_000

// skipped are directories a walk outside a git repository never descends into.
var skipped = map[string]bool{".git": true, "node_modules": true, "vendor": true, "dist": true, "target": true, "__pycache__": true}

// Files lists the project's files under root, relative and slash-separated, sorted. Inside a git
// repository it is what git considers part of the project (tracked, plus untracked files that are
// not ignored); outside one, a bounded walk that skips dependency and dot directories. truncated is
// true when MaxFiles cut the list short.
func Files(ctx context.Context, root string) (files []string, truncated bool, err error) {
	if listed, gitErr := gitFiles(ctx, root); gitErr == nil {
		files = listed
	} else {
		files, err = walk(root)
		if err != nil {
			return nil, false, err
		}
	}
	sort.Strings(files)
	if len(files) > MaxFiles {
		return files[:MaxFiles], true, nil
	}
	return files, false, nil
}

func gitFiles(ctx context.Context, root string) ([]string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", "ls-files", "--cached", "--others", "--exclude-standard", "-z")
	cmd.Dir = root
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var files []string
	seen := map[string]bool{}
	for _, name := range bytes.Split(out, []byte{0}) {
		if path := string(name); path != "" && !seen[path] {
			// A file deleted from the working tree is still in the index; it is not there to open.
			if _, statErr := os.Lstat(filepath.Join(root, path)); statErr == nil {
				seen[path] = true
				files = append(files, path)
			}
		}
	}
	return files, nil
}

var errEnough = errors.New("enough files")

func walk(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil // an unreadable directory is skipped, not fatal
		}
		name := d.Name()
		if d.IsDir() {
			if path != root && (skipped[name] || strings.HasPrefix(name, ".")) {
				return filepath.SkipDir
			}
			return nil
		}
		rel, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return nil
		}
		files = append(files, filepath.ToSlash(rel))
		if len(files) > MaxFiles {
			return errEnough
		}
		return nil
	})
	if errors.Is(err, errEnough) {
		err = nil
	}
	return files, err
}

// Preview is the start of a file for display: at most maxBytes, cut at a line, or a reason it
// cannot be shown as text.
func Preview(root, rel string, maxBytes int) (text string, note string) {
	path, err := Inside(root, rel)
	if err != nil {
		return "", err.Error()
	}
	f, err := os.Open(path)
	if err != nil {
		return "", "cannot open: " + err.Error()
	}
	defer f.Close()
	buf := make([]byte, maxBytes+1)
	n, _ := f.Read(buf)
	data := buf[:n]
	if bytes.IndexByte(data, 0) >= 0 || !utf8.Valid(trimPartialRune(data)) {
		return "", "binary file — not shown"
	}
	if n > maxBytes {
		data = data[:maxBytes]
		if i := bytes.LastIndexByte(data, '\n'); i > 0 {
			data = data[:i]
		}
		note = "showing the start of a large file"
	}
	return string(data), note
}

// Inside resolves rel under root and refuses anything that leaves it, by path or by symlink. The
// path is checked as written before anything touches the disk, so `../..` is refused for what it
// is rather than for whether the place it points to happens to exist.
func Inside(root, rel string) (string, error) {
	if filepath.IsAbs(rel) || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return "", errors.New("outside the project")
	}
	base, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	path, err := filepath.EvalSymlinks(filepath.Join(base, filepath.FromSlash(rel)))
	if err != nil {
		return "", err
	}
	if path != base && !strings.HasPrefix(path, base+string(filepath.Separator)) {
		return "", errors.New("outside the project")
	}
	return path, nil
}

func trimPartialRune(b []byte) []byte {
	for i := 0; i < utf8.UTFMax && len(b) > 0; i++ {
		if utf8.Valid(b) {
			return b
		}
		b = b[:len(b)-1]
	}
	return b
}

// Language names a file's language for syntax highlighting, by extension; empty when unknown.
func Language(rel string) string {
	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(rel)), ".")
	switch ext {
	case "ts", "tsx", "mts", "cts":
		return "typescript"
	case "js", "jsx", "mjs", "cjs":
		return "javascript"
	case "py":
		return "python"
	case "rs":
		return "rust"
	case "rb":
		return "ruby"
	case "sh", "bash", "zsh":
		return "bash"
	case "yml":
		return "yaml"
	case "md", "markdown":
		return "markdown"
	case "go", "json", "yaml", "toml", "html", "css", "sql", "java", "kt", "swift", "c", "h", "cpp", "hpp", "cs", "php", "lua", "zig", "dockerfile":
		return ext
	}
	if strings.EqualFold(filepath.Base(rel), "Dockerfile") {
		return "dockerfile"
	}
	return ""
}
