package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// ReadLimit is how many lines a read returns when it does not say.
const ReadLimit = 2000

func (w *Workspace) readFile() *tool.Tool {
	return &tool.Tool{
		Name:        "read_file",
		Description: "Read a UTF-8 text file (config/env files included; never repeat secret values). Lines come numbered (`12<tab>text`); the numbers are not in the file. Prefer whole files; offset/limit for very large ones.",
		Schema: tool.ObjectSchema(map[string]any{
			"path":   map[string]any{"type": "string", "description": "Path relative to the project root."},
			"offset": map[string]any{"type": "integer", "description": "1-based first line to return."},
			"limit":  map[string]any{"type": "integer", "description": "How many lines to return."},
		}, "path"),
		Capability: tool.CapRead, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(_ context.Context, _ tool.Context, args tool.Args) tool.Result {
			abs, rel, err := w.resolve(tool.StringArg(args, "path"))
			if err != nil {
				return tool.Error(err.Error())
			}
			data, err := readText(abs)
			if err != nil {
				return tool.Error(fmt.Sprintf("%s %v", rel, err))
			}
			w.remember(rel, data)
			lines := strings.Split(string(data), "\n")
			if len(lines) > 0 && lines[len(lines)-1] == "" {
				lines = lines[:len(lines)-1]
			}
			total := len(lines)
			offset, _ := tool.IntArg(args, "offset")
			offset = max(offset, 1)
			limit, ok := tool.IntArg(args, "limit")
			if !ok || limit <= 0 {
				limit = ReadLimit
			}
			if offset > total && total > 0 {
				return tool.Error(fmt.Sprintf("%s has %d lines; offset %d is past its end", rel, total, offset))
			}
			end := min(offset-1+limit, total)
			shown := lines[min(offset-1, total):end]
			var b strings.Builder
			truncated := offset > 1 || end < total
			if truncated {
				fmt.Fprintf(&b, "%s (lines %d-%d of %d)\n", rel, offset, offset+len(shown)-1, total)
			}
			for i, line := range shown {
				fmt.Fprintf(&b, "%d\t%s\n", offset+i, line)
			}
			if total == 0 {
				b.WriteString("(empty file)")
			}
			return tool.Result{Content: strings.TrimSuffix(b.String(), "\n"), Data: map[string]any{"path": rel, "startLine": offset, "totalLines": total, "truncated": truncated}}
		},
	}
}

func (w *Workspace) writeFile() *tool.Tool {
	return &tool.Tool{
		Name:        "write_file",
		Description: "Create a file or replace its entire contents. For changing part of an existing file, use edit_file instead.",
		Schema:      tool.ObjectSchema(map[string]any{"path": map[string]any{"type": "string"}, "content": map[string]any{"type": "string"}}, "path", "content"),
		Capability:  tool.CapWrite, Effect: tool.EffectWorkspace,
		Run: func(_ context.Context, _ tool.Context, args tool.Args) tool.Result {
			abs, rel, err := w.resolve(tool.StringArg(args, "path"))
			if err != nil {
				return tool.Error(err.Error())
			}
			content, ok := args["content"].(string)
			if !ok {
				return tool.Error("`content` must be a string")
			}
			if existing, err := os.ReadFile(abs); err == nil && w.stale(rel, existing) {
				return tool.Error(fmt.Sprintf("%s changed since you last read it. Read it again before replacing it.", rel))
			}
			if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
				return tool.Error(err.Error())
			}
			if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
				return tool.Error(err.Error())
			}
			w.remember(rel, []byte(content))
			w.markWritten(rel)
			return tool.Result{Content: fmt.Sprintf("Wrote %s (%d bytes).", rel, len(content)), Data: map[string]any{"path": rel, "bytesWritten": len(content)}}
		},
	}
}

// edit is one replacement.
type edit struct {
	old, new string
	all      bool
}

func (w *Workspace) editFile() *tool.Tool {
	editSchema := map[string]any{"type": "object", "properties": map[string]any{
		"oldText": map[string]any{"type": "string"}, "newText": map[string]any{"type": "string"}, "replaceAll": map[string]any{"type": "boolean"},
	}, "required": []string{"oldText", "newText"}, "additionalProperties": false}
	return &tool.Tool{
		Name:        "edit_file",
		Description: "Replace an exact string. oldText must occur once (add context lines) unless replaceAll. Several changes to one file: pass edits (in order, all or nothing). Fails if the file changed since you read it.",
		Schema: tool.ObjectSchema(map[string]any{
			"path": map[string]any{"type": "string"}, "oldText": map[string]any{"type": "string"}, "newText": map[string]any{"type": "string"},
			"replaceAll": map[string]any{"type": "boolean"},
			"edits":      map[string]any{"type": "array", "description": "Several changes to this file instead of oldText/newText: applied in order, all or nothing.", "items": editSchema},
		}, "path"),
		Capability: tool.CapWrite, Effect: tool.EffectWorkspace,
		Run: func(_ context.Context, _ tool.Context, args tool.Args) tool.Result {
			abs, rel, err := w.resolve(tool.StringArg(args, "path"))
			if err != nil {
				return tool.Error(err.Error())
			}
			edits, err := parseEdits(args)
			if err != nil {
				return tool.Error(err.Error())
			}
			data, err := readText(abs)
			if err != nil {
				return tool.Error(fmt.Sprintf("%s %v", rel, err))
			}
			if w.stale(rel, data) {
				return tool.Error(fmt.Sprintf("%s changed since you last read it. Read it again, then edit.", rel))
			}
			content, count, err := applyEdits(string(data), edits)
			if err != nil {
				return tool.Error(fmt.Sprintf("%s: %v", rel, err))
			}
			if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
				return tool.Error(err.Error())
			}
			w.remember(rel, []byte(content))
			w.markWritten(rel)
			return tool.Result{Content: fmt.Sprintf("Edited %s (%d replacement%s).", rel, count, plural(count)), Data: map[string]any{"path": rel, "replacements": count}}
		},
	}
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func parseEdits(args tool.Args) ([]edit, error) {
	if list, ok := args["edits"].([]any); ok && len(list) > 0 {
		var out []edit
		for i, item := range list {
			m, ok := item.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("edits[%d] must be an object with oldText and newText", i)
			}
			old, okOld := m["oldText"].(string)
			repl, okNew := m["newText"].(string)
			if !okOld || !okNew {
				return nil, fmt.Errorf("edits[%d] needs oldText and newText strings", i)
			}
			all, _ := m["replaceAll"].(bool)
			out = append(out, edit{old, repl, all})
		}
		return out, nil
	}
	old, okOld := args["oldText"].(string)
	repl, okNew := args["newText"].(string)
	if !okOld || !okNew {
		return nil, fmt.Errorf("pass oldText and newText, or edits")
	}
	return []edit{{old, repl, tool.BoolArg(args, "replaceAll")}}, nil
}

// numbered matches the `12<tab>` prefix read_file adds, in case a model pastes it back.
var numbered = regexp.MustCompile(`(?m)^\s*\d+\t`)

// applyEdits applies edits in order, all or nothing.
func applyEdits(content string, edits []edit) (string, int, error) {
	total := 0
	for i, e := range edits {
		if e.old == "" {
			return "", 0, fmt.Errorf("edit %d: oldText is empty; use write_file to create a file", i+1)
		}
		old, repl := e.old, e.new
		n := strings.Count(content, old)
		if n == 0 {
			// Line numbers copied from read_file output are not in the file.
			if stripped := numbered.ReplaceAllString(old, ""); stripped != old && strings.Count(content, stripped) > 0 {
				old, repl = stripped, numbered.ReplaceAllString(repl, "")
				n = strings.Count(content, old)
			}
		}
		if n == 0 && strings.Contains(content, "\r\n") && !strings.Contains(old, "\r\n") {
			crlfOld := strings.ReplaceAll(old, "\n", "\r\n")
			if strings.Count(content, crlfOld) > 0 {
				old, repl = crlfOld, strings.ReplaceAll(repl, "\n", "\r\n")
				n = strings.Count(content, old)
			}
		}
		switch {
		case n == 0:
			return "", 0, fmt.Errorf("edit %d: oldText was not found. Read the file again and copy the text exactly, including whitespace", i+1)
		case n > 1 && !e.all:
			return "", 0, fmt.Errorf("edit %d: oldText occurs %d times. Add surrounding lines to make it unique, or set replaceAll", i+1, n)
		}
		if e.all {
			content = strings.ReplaceAll(content, old, repl)
			total += n
		} else {
			content = strings.Replace(content, old, repl, 1)
			total++
		}
	}
	return content, total, nil
}
