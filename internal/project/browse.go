package project

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf8"
)

// Browsing the project from afar (the phone link): a folder's entries, a file read in chunks, a
// file's kind, search, and an overview. Everything stays inside the project (Inside), and secret
// files never leave the computer, whatever asks.

// MaxView is the largest file sent to view.
const MaxView = 25 << 20

// secretFile names files that hold keys and passwords: never read for anyone afar.
var secretFile = regexp.MustCompile(`(?i)(^|/)(\.env(\..*)?|[^/]*\.env|id_(rsa|dsa|ecdsa|ed25519)[^/]*|\.npmrc|\.netrc|\.pypirc|\.git-credentials|credentials(\.[a-z]+)?|[^/]*\.(pem|key|p12|pfx|keystore|jks|secret))$`)

// Secret is whether a file holds keys or passwords and must stay on the computer.
func Secret(rel string) bool { return secretFile.MatchString(filepath.ToSlash(rel)) }

// Entry is one thing in a folder.
type Entry struct {
	Name   string `json:"name"`
	Path   string `json:"path"`
	Dir    bool   `json:"dir"`
	Size   int64  `json:"size"`
	Secret bool   `json:"secret,omitempty"`
}

// List is a folder's entries that belong to the project (git's own list, so ignored files are
// left out), folders first, each sorted. dir "" is the project's top.
func List(ctx context.Context, root, dir string) ([]Entry, error) {
	dir = strings.Trim(filepath.ToSlash(dir), "/")
	if dir != "" {
		p, err := Inside(root, dir)
		if err != nil {
			return nil, err
		}
		if info, err := os.Stat(p); err != nil || !info.IsDir() {
			return nil, errors.New("not a folder")
		}
	}
	files, _, err := Files(ctx, root)
	if err != nil {
		return nil, err
	}
	prefix := ""
	if dir != "" {
		prefix = dir + "/"
	}
	dirs, seen := []Entry{}, map[string]bool{}
	var plain []Entry
	for _, f := range files {
		rest, ok := strings.CutPrefix(f, prefix)
		if !ok || rest == "" {
			continue
		}
		if name, _, nested := strings.Cut(rest, "/"); nested {
			if !seen[name] {
				seen[name] = true
				dirs = append(dirs, Entry{Name: name, Path: prefix + name, Dir: true})
			}
			continue
		}
		e := Entry{Name: rest, Path: f, Secret: Secret(f)}
		if p, err := Inside(root, f); err == nil {
			if info, err := os.Stat(p); err == nil {
				e.Size = info.Size()
			}
		} else {
			continue // a link out of the project
		}
		plain = append(plain, e)
	}
	sort.Slice(dirs, func(i, j int) bool { return dirs[i].Name < dirs[j].Name })
	sort.Slice(plain, func(i, j int) bool { return plain[i].Name < plain[j].Name })
	return append(dirs, plain...), nil
}

// Chunk is part of a file: its bytes from Offset, the file's whole Size, whether More follows,
// its kind, and whether it is text.
type Chunk struct {
	Path   string
	Size   int64
	Offset int64
	Data   []byte
	More   bool
	Mime   string
	Text   bool
}

// ReadChunk is up to size bytes of a file from offset. Secret files, folders, anything outside the
// project and files over MaxView are refused.
func ReadChunk(root, rel string, offset int64, size int) (Chunk, error) {
	rel = strings.Trim(filepath.ToSlash(rel), "/")
	if rel == "" || strings.ContainsRune(rel, 0) {
		return Chunk{}, errors.New("no file")
	}
	if Secret(rel) {
		return Chunk{}, errors.New("a file of keys or passwords stays on the computer")
	}
	p, err := Inside(root, rel)
	if err != nil {
		return Chunk{}, err
	}
	f, err := os.Open(p)
	if err != nil {
		return Chunk{}, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return Chunk{}, err
	}
	if info.IsDir() {
		return Chunk{}, errors.New("a folder, not a file")
	}
	if info.Size() > MaxView {
		return Chunk{}, fmt.Errorf("%s is %d MB; at most %d MB is shown", rel, info.Size()>>20, MaxView>>20)
	}
	if offset < 0 || offset > info.Size() || (offset == info.Size() && offset > 0) || size < 1 {
		return Chunk{}, errors.New("past the end of the file")
	}
	head := make([]byte, 512)
	n, _ := f.ReadAt(head, 0)
	mime, text := kindOf(rel, head[:n])
	data := make([]byte, min(int64(size), info.Size()-offset))
	if _, err := f.ReadAt(data, offset); err != nil && !errors.Is(err, io.EOF) {
		return Chunk{}, err
	}
	end := offset + int64(len(data))
	return Chunk{Path: rel, Size: info.Size(), Offset: offset, Data: data, More: end < info.Size(), Mime: mime, Text: text}, nil
}

// kindOf is how a file is shown: markdown, an image, a PDF, other text, or bytes.
func kindOf(rel string, head []byte) (mime string, text bool) {
	switch strings.ToLower(path.Ext(rel)) {
	case ".md", ".markdown", ".mdx":
		return "text/markdown", true
	case ".pdf":
		return "application/pdf", false
	case ".png":
		return "image/png", false
	case ".jpg", ".jpeg":
		return "image/jpeg", false
	case ".gif":
		return "image/gif", false
	case ".webp":
		return "image/webp", false
	case ".svg":
		return "image/svg+xml", false
	}
	if len(head) == 0 || (bytes.IndexByte(head, 0) < 0 && utf8.Valid(trimPartialRune(head))) {
		return "text/plain", true
	}
	return http.DetectContentType(head), false
}

// Hit is one line that matched a search.
type Hit struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

// Search finds query in the project's text files, ignoring case: at most max hits, in path and line
// order. Secret, ignored, binary and very large files are never read.
func Search(ctx context.Context, root, query string, max int) (hits []Hit, truncated bool) {
	needle := strings.ToLower(strings.TrimSpace(query))
	if needle == "" {
		return nil, false
	}
	files, _, err := Files(ctx, root)
	if err != nil {
		return nil, false
	}
	for _, f := range files {
		if ctx.Err() != nil || Secret(f) {
			continue
		}
		p, err := Inside(root, f)
		if err != nil {
			continue
		}
		info, err := os.Stat(p)
		if err != nil || info.IsDir() || info.Size() > 2<<20 {
			continue
		}
		data, err := os.ReadFile(p)
		if err != nil || bytes.IndexByte(data[:min(len(data), 8000)], 0) >= 0 {
			continue
		}
		s := bufio.NewScanner(bytes.NewReader(data))
		s.Buffer(make([]byte, 64<<10), 1<<20)
		for line := 1; s.Scan(); line++ {
			if strings.Contains(strings.ToLower(s.Text()), needle) {
				if len(hits) == max {
					return hits, true
				}
				text := strings.TrimSpace(s.Text())
				if len(text) > 200 {
					text = text[:200] + "…"
				}
				hits = append(hits, Hit{Path: f, Line: line, Text: text})
			}
		}
	}
	return hits, false
}

// LogEntry is one entry of the log.
type LogEntry struct {
	SHA     string    `json:"sha"`
	Subject string    `json:"subject"`
	Author  string    `json:"author"`
	When    time.Time `json:"when"`
}

// Log is the newest n commits of the current branch.
func Log(ctx context.Context, root string, n int) ([]LogEntry, error) {
	out, err := git(ctx, root, "log", fmt.Sprintf("-%d", n), "--format=%h%x1f%s%x1f%an%x1f%ct")
	if err != nil {
		return nil, err
	}
	var commits []LogEntry
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.Split(line, "\x1f")
		if len(parts) != 4 {
			continue
		}
		commits = append(commits, LogEntry{SHA: parts[0], Subject: parts[1], Author: parts[2], When: unixTime(parts[3])})
	}
	return commits, nil
}

// LanguageCount is how much of the project is in a language.
type LanguageCount struct {
	Language string `json:"language"`
	Files    int    `json:"files"`
	Bytes    int64  `json:"bytes"`
}

// ProjectOverview is what the project is, at a glance.
type ProjectOverview struct {
	Name      string          `json:"name"`
	Branch    string          `json:"branch"`
	Files     int             `json:"files"`
	Bytes     int64           `json:"bytes"`
	Languages []LanguageCount `json:"languages"`
	Readme    string          `json:"readme"`
	Commits   []LogEntry      `json:"commits"`
	Changed   int             `json:"changed"`
}

// Overview is the project at a glance: its name, branch, files and languages (by bytes), its
// README, its latest commits, and how many files have changed since the last commit.
func Overview(ctx context.Context, root string) (ProjectOverview, error) {
	o := ProjectOverview{Name: filepath.Base(root)}
	files, _, err := Files(ctx, root)
	if err != nil {
		return o, err
	}
	langs := map[string]*LanguageCount{}
	for _, f := range files {
		p, err := Inside(root, f)
		if err != nil {
			continue
		}
		info, err := os.Stat(p)
		if err != nil || info.IsDir() {
			continue
		}
		o.Files++
		o.Bytes += info.Size()
		if lang := Language(f); lang != "" {
			if langs[lang] == nil {
				langs[lang] = &LanguageCount{Language: lang}
			}
			langs[lang].Files++
			langs[lang].Bytes += info.Size()
		}
		if o.Readme == "" && !strings.Contains(f, "/") && strings.HasPrefix(strings.ToLower(f), "readme") {
			o.Readme = f
		}
	}
	for _, l := range langs {
		o.Languages = append(o.Languages, *l)
	}
	sort.Slice(o.Languages, func(i, j int) bool {
		if o.Languages[i].Bytes != o.Languages[j].Bytes {
			return o.Languages[i].Bytes > o.Languages[j].Bytes
		}
		return o.Languages[i].Language < o.Languages[j].Language
	})
	o.Branch, _ = CurrentBranch(ctx, root)
	o.Commits, _ = Log(ctx, root, 10)
	if changes, err := Changes(ctx, root); err == nil {
		o.Changed = len(changes)
	}
	return o, nil
}
