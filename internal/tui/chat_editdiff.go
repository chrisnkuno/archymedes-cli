package tui

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// An edit's diff, drawn from the call itself. The engine's result for an edit says only "Edited x
// (1 replacement)", but its arguments hold what was replaced and by what (`oldText`/`newText`, or
// `edits`; `content` for a write), on every engine. From those this builds a unified diff, and,
// once the file is written, finds where in it each change landed, so the lines carry their real
// numbers. A change it cannot place is drawn without numbers rather than with wrong ones.

// editTools are the calls that change a file and whose arguments say how.
var editTools = map[string]bool{"edit_file": true, "write_file": true}

// editContext is how many unchanged lines a hunk keeps around a change, as git does.
const editContext = 3

// maxDiffCells bounds the line-matching table of one change; past it, the unchanged lines at both
// ends are still matched and the middle is drawn as all removed, then all added.
const maxDiffCells = 250_000

// maxLocateBytes is the largest file read to find where a change landed.
const maxLocateBytes = 2 << 20

// editChange is one replacement: the text before and after, and the line it starts on in the new
// file (0 when not known).
type editChange struct {
	old, new string
	at       int
}

// editChanges reads an edit or write call's arguments; nil for any other call. whole is a write,
// whose content is the entire new file.
func editChanges(name string, args map[string]any) (changes []editChange, whole bool) {
	switch name {
	case "write_file":
		content, ok := args["content"].(string)
		if !ok {
			return nil, false
		}
		return []editChange{{new: content, at: 1}}, true
	case "edit_file":
		if list, ok := args["edits"].([]any); ok && len(list) > 0 {
			for _, e := range list {
				fields, _ := e.(map[string]any)
				old, _ := fields["oldText"].(string)
				repl, _ := fields["newText"].(string)
				changes = append(changes, editChange{old: old, new: repl})
			}
			return changes, false
		}
		old, ok1 := args["oldText"].(string)
		repl, ok2 := args["newText"].(string)
		if ok1 || ok2 {
			return []editChange{{old: old, new: repl}}, false
		}
	}
	return nil, false
}

// locateChanges finds the line each change starts on in the file as written, searching from where
// the change before it was found, so repeated text is placed in order.
func locateChanges(changes []editChange, written string) {
	from := 0
	for i := range changes {
		if changes[i].at > 0 || changes[i].new == "" {
			continue
		}
		idx := strings.Index(written[from:], changes[i].new)
		if idx < 0 {
			idx = strings.Index(written, changes[i].new)
			if idx < 0 {
				continue
			}
		} else {
			idx += from
		}
		changes[i].at = 1 + strings.Count(written[:idx], "\n")
		from = idx + len(changes[i].new)
	}
}

// readWritten is a file as it is now, for placing changes; "" when it is missing or too large.
func readWritten(root, path string) string {
	if path == "" {
		return ""
	}
	abs := path
	if !filepath.IsAbs(abs) {
		abs = filepath.Join(root, filepath.FromSlash(path))
	}
	info, err := os.Stat(abs)
	if err != nil || info.IsDir() || info.Size() > maxLocateBytes {
		return ""
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return ""
	}
	return string(data)
}

// editPatch is the unified diff of an edit's changes, and the lines it adds and removes.
func editPatch(changes []editChange) (text string, added, removed int) {
	var b strings.Builder
	shift := 0 // lines added minus removed by the changes above this one, for its old number
	for _, c := range changes {
		oldLines, newLines := splitLines(c.old), splitLines(c.new)
		oldAt, newAt := 0, c.at
		if c.at > 0 {
			oldAt = max(c.at-shift, 1)
			if len(oldLines) == 0 {
				oldAt = 0 // nothing there before: git's "-0,0"
			}
		}
		ops := lineOps(oldLines, newLines)
		for _, op := range ops {
			switch op.kind {
			case '+':
				added++
			case '-':
				removed++
			}
		}
		writeHunks(&b, ops, oldAt, newAt)
		shift += len(newLines) - len(oldLines)
	}
	return b.String(), added, removed
}

// splitLines is text as lines, with no empty last line for a closing newline.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	return strings.Split(strings.TrimSuffix(s, "\n"), "\n")
}

// lineOp is one line of a diff: ' ' kept, '-' removed, '+' added.
type lineOp struct {
	kind byte
	text string
}

// lineOps matches two versions line by line: the shared lines at both ends first, then the
// longest common subsequence of what is left between them while that stays small.
func lineOps(a, b []string) []lineOp {
	head := 0
	for head < len(a) && head < len(b) && a[head] == b[head] {
		head++
	}
	tail := 0
	for tail < len(a)-head && tail < len(b)-head && a[len(a)-1-tail] == b[len(b)-1-tail] {
		tail++
	}
	ops := make([]lineOp, 0, len(a)+len(b))
	for _, l := range a[:head] {
		ops = append(ops, lineOp{' ', l})
	}
	ops = append(ops, middleOps(a[head:len(a)-tail], b[head:len(b)-tail])...)
	for _, l := range a[len(a)-tail:] {
		ops = append(ops, lineOp{' ', l})
	}
	return ops
}

func middleOps(a, b []string) []lineOp {
	var ops []lineOp
	if len(a)*len(b) == 0 || len(a)*len(b) > maxDiffCells {
		for _, l := range a {
			ops = append(ops, lineOp{'-', l})
		}
		for _, l := range b {
			ops = append(ops, lineOp{'+', l})
		}
		return ops
	}
	// lcs[i][j] is the longest common subsequence of a[i:] and b[j:].
	lcs := make([][]int32, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int32, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else {
				lcs[i][j] = max(lcs[i+1][j], lcs[i][j+1])
			}
		}
	}
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			ops = append(ops, lineOp{' ', a[i]})
			i, j = i+1, j+1
		case lcs[i+1][j] >= lcs[i][j+1]:
			ops = append(ops, lineOp{'-', a[i]})
			i++
		default:
			ops = append(ops, lineOp{'+', b[j]})
			j++
		}
	}
	for ; i < len(a); i++ {
		ops = append(ops, lineOp{'-', a[i]})
	}
	for ; j < len(b); j++ {
		ops = append(ops, lineOp{'+', b[j]})
	}
	return ops
}

// writeHunks writes ops as unified-diff hunks: each run of changes with editContext unchanged lines
// around it, and long unchanged stretches between changes left out. oldAt and newAt are the
// numbers of the first op's lines (0 when not known).
func writeHunks(b *strings.Builder, ops []lineOp, oldAt, newAt int) {
	changed := make([]bool, len(ops))
	found := false
	for i, op := range ops {
		if op.kind != ' ' {
			for k := max(i-editContext, 0); k <= min(i+editContext, len(ops)-1); k++ {
				changed[k] = true
			}
			found = true
		}
	}
	if !found {
		return // replaced with the same text: nothing to show
	}
	oldLine, newLine := oldAt, newAt
	for i := 0; i < len(ops); {
		if !changed[i] {
			oldLine, newLine = advance(oldLine), advance(newLine)
			i++
			continue
		}
		end := i
		for end < len(ops) && changed[end] {
			end++
		}
		var oldCount, newCount int
		for _, op := range ops[i:end] {
			if op.kind != '+' {
				oldCount++
			}
			if op.kind != '-' {
				newCount++
			}
		}
		fmt.Fprintf(b, "@@ -%d,%d +%d,%d @@\n", oldLine, oldCount, newLine, newCount)
		for _, op := range ops[i:end] {
			b.WriteByte(op.kind)
			b.WriteString(op.text)
			b.WriteByte('\n')
			if op.kind != '+' {
				oldLine = advance(oldLine)
			}
			if op.kind != '-' {
				newLine = advance(newLine)
			}
		}
		i = end
	}
}

// attachDiff gives a finished edit or write card its diff, placed in the file as written.
func attachDiff(t *toolItem, root string) {
	if !editTools[t.name] || t.isError {
		return
	}
	changes, whole := editChanges(t.name, t.args)
	if changes == nil {
		return
	}
	if !whole {
		path, _ := t.args["path"].(string)
		if written := readWritten(root, path); written != "" {
			locateChanges(changes, written)
		}
	}
	t.diff, t.added, t.removed = editPatch(changes)
	t.touch()
}
