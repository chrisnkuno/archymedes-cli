package tools

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

const gitMaxChars = 20_000

// git runs a read-only git command in the root. Arguments never reach a shell.
func (w *Workspace) git(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"--no-pager", "-c", "color.ui=never"}, args...)...)
	cmd.Dir = w.Root
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", args[0], msg)
	}
	return out.String(), nil
}

// refPattern is what a ref or range argument may look like: no options, no shell.
var refPattern = regexp.MustCompile(`^[A-Za-z0-9_./~^@{}:+-]+$`)

func checkRef(ref string) error {
	if ref == "" || (refPattern.MatchString(ref) && !strings.HasPrefix(ref, "-")) {
		return nil
	}
	return fmt.Errorf("%q is not a git ref or range", ref)
}

func capped(text string, args tool.Args) string {
	limit, ok := tool.IntArg(args, "maxChars")
	if !ok || limit <= 0 {
		limit = gitMaxChars
	}
	limit = min(limit, 100_000)
	if len(text) <= limit {
		return text
	}
	return text[:limit] + fmt.Sprintf("\n[… %d more characters; narrow with path or stat]", len(text)-limit)
}

func readGit(name, description string, schema map[string]any, run func(context.Context, tool.Args) (string, error)) *tool.Tool {
	return &tool.Tool{
		Name: name, Description: description, Schema: schema,
		Capability: tool.CapRead, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			out, err := run(ctx, args)
			if err != nil {
				return tool.Error(err.Error())
			}
			if strings.TrimSpace(out) == "" {
				out = "(nothing)"
			}
			return tool.Text(capped(out, args))
		},
	}
}

func (w *Workspace) gitStatus() *tool.Tool {
	return readGit("git_status", "Git branch (ahead/behind upstream) and staged, unstaged, untracked and conflicted files.",
		tool.ObjectSchema(map[string]any{}),
		func(ctx context.Context, _ tool.Args) (string, error) {
			return w.git(ctx, "status", "--short", "--branch")
		})
}

func (w *Workspace) gitDiff() *tool.Tool {
	return readGit("git_diff", "The working tree's changes (unstaged by default), staged ones, or between refs.",
		tool.ObjectSchema(map[string]any{
			"staged":   map[string]any{"type": "boolean"},
			"ref":      map[string]any{"type": "string", "description": "e.g. 'HEAD~1', 'main..feature'."},
			"path":     map[string]any{"type": "string"},
			"stat":     map[string]any{"type": "boolean", "description": "Per-file summary only."},
			"maxChars": map[string]any{"type": "integer", "description": "Default 20000, max 100000."},
		}),
		func(ctx context.Context, args tool.Args) (string, error) {
			argv := []string{"diff"}
			if tool.BoolArg(args, "staged") {
				argv = append(argv, "--cached")
			}
			if tool.BoolArg(args, "stat") {
				argv = append(argv, "--stat")
			}
			ref := tool.StringArg(args, "ref")
			if err := checkRef(ref); err != nil {
				return "", err
			}
			if ref != "" {
				argv = append(argv, ref)
			}
			if p := tool.StringArg(args, "path"); p != "" {
				if _, rel, err := w.resolve(p); err == nil {
					argv = append(argv, "--", rel)
				} else {
					return "", err
				}
			}
			return w.git(ctx, argv...)
		})
}

func (w *Workspace) gitLog() *tool.Tool {
	return readGit("git_log", "Recent commits (hash, author, date, subject), newest first.",
		tool.ObjectSchema(map[string]any{
			"n":    map[string]any{"type": "integer", "description": "Default 20, max 200."},
			"path": map[string]any{"type": "string", "description": "Only commits touching this path."},
			"ref":  map[string]any{"type": "string", "description": "Instead of HEAD."},
		}),
		func(ctx context.Context, args tool.Args) (string, error) {
			n, ok := tool.IntArg(args, "n")
			if !ok || n <= 0 {
				n = 20
			}
			argv := []string{"log", fmt.Sprintf("-n%d", min(n, 200)), "--date=short", "--pretty=format:%h %ad %an %s"}
			ref := tool.StringArg(args, "ref")
			if err := checkRef(ref); err != nil {
				return "", err
			}
			if ref != "" {
				argv = append(argv, ref)
			}
			if p := tool.StringArg(args, "path"); p != "" {
				_, rel, err := w.resolve(p)
				if err != nil {
					return "", err
				}
				argv = append(argv, "--", rel)
			}
			return w.git(ctx, argv...)
		})
}

func (w *Workspace) gitShow() *tool.Tool {
	return readGit("git_show", "One commit: its message and diff (or stat).",
		tool.ObjectSchema(map[string]any{
			"ref":      map[string]any{"type": "string"},
			"stat":     map[string]any{"type": "boolean"},
			"maxChars": map[string]any{"type": "integer", "description": "Default 20000, max 100000."},
		}, "ref"),
		func(ctx context.Context, args tool.Args) (string, error) {
			ref := tool.StringArg(args, "ref")
			if ref == "" {
				return "", fmt.Errorf("ref is required")
			}
			if err := checkRef(ref); err != nil {
				return "", err
			}
			argv := []string{"show"}
			if tool.BoolArg(args, "stat") {
				argv = append(argv, "--stat")
			}
			return w.git(ctx, append(argv, ref)...)
		})
}
