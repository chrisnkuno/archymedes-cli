package tools

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// InstructionFiles are a directory's instruction files, first found wins (INSTRUCTION_FILES in
// prompt.ts). The project root's go in the system prompt; a subdirectory's come with the first file
// tool result under it (nestedInstructions).
var InstructionFiles = []string{"AGENTS.override.md", "ARCHYMEDES.md", "AGENTS.md", "CLAUDE.md", ".archymedesrules"}

// InstructionsMax is the most of one instruction file sent to the model.
const InstructionsMax = 20_000

// ReadInstructions is dir's instruction file and its text, cut to InstructionsMax; "" when it has
// none or only blank ones.
func ReadInstructions(dir string) (name, text string) {
	for _, candidate := range InstructionFiles {
		data, err := os.ReadFile(filepath.Join(dir, candidate))
		if err != nil || strings.TrimSpace(string(data)) == "" {
			continue
		}
		text = strings.TrimSpace(string(data))
		if len(text) > InstructionsMax {
			text = text[:InstructionsMax] + "\n[… cut]"
		}
		return candidate, text
	}
	return "", ""
}

// nestedInstructions is what the instruction files between the root and rel's directory say, outer
// first, for each directory not yet shown this session; with the paths of the files it carried.
// Reading an instruction file itself counts as showing its directory.
func (w *Workspace) nestedInstructions(rel string) (string, []string) {
	dir := filepath.Dir(filepath.FromSlash(rel))
	var dirs []string
	for ; dir != "." && dir != string(filepath.Separator) && dir != ""; dir = filepath.Dir(dir) {
		dirs = append([]string{dir}, dirs...)
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.instructed == nil {
		w.instructed = map[string]bool{}
	}
	var b strings.Builder
	var carried []string
	for _, d := range dirs {
		if w.instructed[d] {
			continue
		}
		w.instructed[d] = true
		name, text := ReadInstructions(filepath.Join(w.Root, d))
		if name == "" || filepath.Join(d, name) == filepath.FromSlash(rel) {
			continue
		}
		path := filepath.ToSlash(filepath.Join(d, name))
		fmt.Fprintf(&b, "\n\nInstructions for %s/ (%s), from the people who work here; follow them for files under it:\n%s", filepath.ToSlash(d), path, text)
		carried = append(carried, path)
	}
	return b.String(), carried
}

// withInstructions adds rel's nested instructions to a successful result, once a session each.
func (w *Workspace) withInstructions(rel string, content string, data map[string]any) (string, map[string]any) {
	text, carried := w.nestedInstructions(rel)
	if len(carried) == 0 {
		return content, data
	}
	if data == nil {
		data = map[string]any{}
	}
	data["instructions"] = carried
	return content + text, data
}
