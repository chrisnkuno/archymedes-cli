package tools

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// skipDirs are never listed or searched: dependencies, build output, version control.
var skipDirs = map[string]bool{".git": true, "node_modules": true, ".hg": true, ".svn": true, "dist": true, "target": true, "vendor": true, "__pycache__": true, ".venv": true, ".next": true, "go-sessions": true}

const (
	grepShown = 100
	grepMax   = 500
	listMax   = 500
)

func (w *Workspace) listFiles() *tool.Tool {
	return &tool.Tool{
		Name:        "list_files",
		Description: "List files and directories under a path in the project.",
		Schema: tool.ObjectSchema(map[string]any{
			"path":  map[string]any{"type": "string"},
			"depth": map[string]any{"type": "integer", "description": "Directory levels to descend. Default 2."},
		}),
		Capability: tool.CapRead, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			abs, rel, err := w.resolve(tool.StringArg(args, "path"))
			if err != nil {
				return tool.Error(err.Error())
			}
			depth, ok := tool.IntArg(args, "depth")
			if !ok || depth < 1 {
				depth = 2
			}
			var entries []string
			more := false
			_ = filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
				if err != nil || ctx.Err() != nil {
					return nil
				}
				r, _ := filepath.Rel(abs, p)
				if r == "." {
					return nil
				}
				level := strings.Count(r, string(filepath.Separator)) + 1
				if d.IsDir() && skipDirs[d.Name()] {
					return filepath.SkipDir
				}
				if len(entries) >= listMax {
					more = true
					return filepath.SkipAll
				}
				name := filepath.ToSlash(r)
				if d.IsDir() {
					name += "/"
				}
				entries = append(entries, name)
				if d.IsDir() && level >= depth {
					return filepath.SkipDir
				}
				return nil
			})
			if len(entries) == 0 {
				return tool.Text(rel + " is empty.")
			}
			text := strings.Join(entries, "\n")
			if more {
				text += fmt.Sprintf("\n[first %d entries; list a subdirectory or use glob_files for the rest]", listMax)
			}
			return tool.Result{Content: text, Data: map[string]any{"path": rel, "count": len(entries)}}
		},
	}
}

func (w *Workspace) globFiles() *tool.Tool {
	return &tool.Tool{
		Name:        "glob_files",
		Description: "Find files by name pattern, e.g. '**/*.go' or 'src/**/test_*.py'. Newest first.",
		Schema: tool.ObjectSchema(map[string]any{
			"pattern": map[string]any{"type": "string"},
			"path":    map[string]any{"type": "string", "description": "Directory to search in. Default: project root."},
		}, "pattern"),
		Capability: tool.CapRead, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			pattern := strings.TrimPrefix(filepath.ToSlash(tool.StringArg(args, "pattern")), "./")
			if pattern == "" {
				return tool.Error("`pattern` is required")
			}
			abs, _, err := w.resolve(tool.StringArg(args, "path"))
			if err != nil {
				return tool.Error(err.Error())
			}
			type hit struct {
				rel string
				mod int64
			}
			var hits []hit
			_ = filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
				if err != nil || ctx.Err() != nil {
					return nil
				}
				if d.IsDir() {
					if skipDirs[d.Name()] && p != abs {
						return filepath.SkipDir
					}
					return nil
				}
				r, _ := filepath.Rel(abs, p)
				if MatchGlob(pattern, filepath.ToSlash(r)) {
					info, _ := d.Info()
					var mod int64
					if info != nil {
						mod = info.ModTime().UnixNano()
					}
					rootRel, _ := filepath.Rel(w.Root, p)
					hits = append(hits, hit{filepath.ToSlash(rootRel), mod})
				}
				return nil
			})
			sort.SliceStable(hits, func(i, j int) bool { return hits[i].mod > hits[j].mod })
			if len(hits) == 0 {
				return tool.Text("No files match " + pattern + ".")
			}
			var lines []string
			for i, h := range hits {
				if i == listMax {
					lines = append(lines, fmt.Sprintf("[%d more; narrow the pattern]", len(hits)-listMax))
					break
				}
				lines = append(lines, h.rel)
			}
			return tool.Result{Content: strings.Join(lines, "\n"), Data: map[string]any{"count": len(hits)}}
		},
	}
}

// MatchGlob matches a slash path against a pattern where `**` spans directories. A pattern with
// no slash matches the base name at any depth (`*.go` finds every Go file), as ripgrep's -g does.
func MatchGlob(pattern, name string) bool {
	if !strings.Contains(pattern, "/") {
		ok, _ := path.Match(pattern, path.Base(name))
		return ok
	}
	return matchSegments(strings.Split(pattern, "/"), strings.Split(name, "/"))
}

func matchSegments(pattern, name []string) bool {
	for len(pattern) > 0 {
		if pattern[0] == "**" {
			rest := pattern[1:]
			for i := 0; i <= len(name); i++ {
				if matchSegments(rest, name[i:]) {
					return true
				}
			}
			return false
		}
		if len(name) == 0 {
			return false
		}
		if ok, _ := path.Match(pattern[0], name[0]); !ok {
			return false
		}
		pattern, name = pattern[1:], name[1:]
	}
	return len(name) == 0
}

func (w *Workspace) grepFiles() *tool.Tool {
	return &tool.Tool{
		Name:        "grep_files",
		Description: "Search file contents (ripgrep). Fixed string unless regex. Narrow with path and include. output: content (matching lines, default), files (paths only), count (per file). context adds lines around each match.",
		Schema: tool.ObjectSchema(map[string]any{
			"query":      map[string]any{"type": "string", "description": "Text to find, or a regular expression with regex: true."},
			"path":       map[string]any{"type": "string", "description": "File or directory to search. Default: project root."},
			"include":    map[string]any{"type": "string", "description": "Glob for file names, e.g. '*.ts' (any depth) or 'src/**/*.tsx'."},
			"regex":      map[string]any{"type": "boolean"},
			"ignoreCase": map[string]any{"type": "boolean"},
			"output":     map[string]any{"type": "string", "enum": []string{"content", "files", "count"}},
			"context":    map[string]any{"type": "integer", "description": "Lines before and after each match (content output), up to 10."},
			"limit":      map[string]any{"type": "integer", "description": fmt.Sprintf("Most matching lines shown. Default %d, max %d.", grepShown, grepMax)},
		}, "query"),
		Capability: tool.CapRead, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			q := grepQuery{
				query: tool.StringArg(args, "query"), include: tool.StringArg(args, "include"),
				regex: tool.BoolArg(args, "regex"), ignoreCase: tool.BoolArg(args, "ignoreCase"),
				output: tool.StringArg(args, "output"),
			}
			if q.query == "" {
				return tool.Error("`query` is required")
			}
			if q.output == "" {
				q.output = "content"
			}
			if q.output != "content" && q.output != "files" && q.output != "count" {
				return tool.Error("`output` must be content, files or count")
			}
			q.context, _ = tool.IntArg(args, "context")
			q.context = min(max(q.context, 0), 10)
			limit, ok := tool.IntArg(args, "limit")
			if !ok || limit <= 0 {
				limit = grepShown
			}
			q.limit = min(limit, grepMax)
			abs, _, err := w.resolve(tool.StringArg(args, "path"))
			if err != nil {
				return tool.Error(err.Error())
			}
			lines, err := w.grep(ctx, abs, q)
			if err != nil {
				return tool.Error(err.Error())
			}
			if len(lines) == 0 {
				return tool.Result{Content: "No matches for " + q.query + ".", Data: map[string]any{"matches": 0}}
			}
			text := strings.Join(lines, "\n")
			if len(lines) > q.limit {
				text = strings.Join(lines[:q.limit], "\n") + fmt.Sprintf("\n[%d more lines; narrow with path or include, or raise limit]", len(lines)-q.limit)
			}
			return tool.Result{Content: text, Data: map[string]any{"matches": len(lines)}}
		},
	}
}

type grepQuery struct {
	query, include, output string
	regex, ignoreCase      bool
	context, limit         int
}

// grep runs ripgrep when it is installed (it honours .gitignore), else searches in Go.
func (w *Workspace) grep(ctx context.Context, abs string, q grepQuery) ([]string, error) {
	if rg, err := exec.LookPath("rg"); err == nil {
		argv := []string{"--no-heading", "--color=never", "--max-columns=400", "--max-columns-preview"}
		if !q.regex {
			argv = append(argv, "--fixed-strings")
		}
		if q.ignoreCase {
			argv = append(argv, "--ignore-case")
		}
		switch q.output {
		case "files":
			argv = append(argv, "--files-with-matches")
		case "count":
			argv = append(argv, "--count")
		default:
			argv = append(argv, "--line-number")
			if q.context > 0 {
				argv = append(argv, fmt.Sprintf("--context=%d", q.context))
			}
		}
		if q.include != "" {
			argv = append(argv, "--glob", q.include)
		}
		target, _ := filepath.Rel(w.Root, abs)
		argv = append(argv, "--", q.query, filepath.ToSlash(target))
		cmd := exec.CommandContext(ctx, rg, argv...)
		cmd.Dir = w.Root
		var out, stderr bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &stderr
		err := cmd.Run()
		if exit, ok := err.(*exec.ExitError); ok && exit.ExitCode() == 1 {
			return nil, nil // no match
		}
		if err != nil {
			return nil, fmt.Errorf("grep failed: %s", strings.TrimSpace(stderr.String()+" "+err.Error()))
		}
		return splitLines(out.String(), q.limit+1), nil
	}
	return w.grepGo(ctx, abs, q)
}

func splitLines(text string, max int) []string {
	var out []string
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		if line == "" {
			continue
		}
		out = append(out, strings.TrimPrefix(line, "./"))
		if len(out) >= max {
			break
		}
	}
	return out
}

func (w *Workspace) grepGo(ctx context.Context, abs string, q grepQuery) ([]string, error) {
	expr := q.query
	if !q.regex {
		expr = regexp.QuoteMeta(expr)
	}
	if q.ignoreCase {
		expr = "(?i)" + expr
	}
	re, err := regexp.Compile(expr)
	if err != nil {
		return nil, fmt.Errorf("query is not a valid regular expression: %v", err)
	}
	var out []string
	_ = filepath.WalkDir(abs, func(p string, d fs.DirEntry, err error) error {
		if err != nil || ctx.Err() != nil || len(out) > q.limit {
			return nil
		}
		if d.IsDir() {
			if skipDirs[d.Name()] && p != abs {
				return filepath.SkipDir
			}
			return nil
		}
		rel, _ := filepath.Rel(w.Root, p)
		rel = filepath.ToSlash(rel)
		if q.include != "" && !MatchGlob(q.include, rel) {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return nil
		}
		defer f.Close()
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 64<<10), 1<<20)
		n, count := 0, 0
		for scanner.Scan() {
			n++
			line := scanner.Text()
			if strings.ContainsRune(line, 0) {
				return nil // binary
			}
			if re.MatchString(line) {
				count++
				if q.output == "content" {
					out = append(out, fmt.Sprintf("%s:%d:%s", rel, n, line))
				}
			}
		}
		switch {
		case count > 0 && q.output == "files":
			out = append(out, rel)
		case count > 0 && q.output == "count":
			out = append(out, fmt.Sprintf("%s:%d", rel, count))
		}
		return nil
	})
	return out, nil
}
