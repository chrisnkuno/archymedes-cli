// Package skills finds Agent Skills: folders holding a SKILL.md whose frontmatter names the skill
// and says when to use it, with any scripts or references beside it. Only the name and the
// description go into the prompt; the model loads a skill's instructions when a task calls for it
// (load_skill), and reads its other files as it needs them, so a skill costs a line until used.
//
// The folders are the ones other agents read, so a skill written for one works in all:
// .agents/skills (the shared convention), .claude/skills and .archymedes/skills in the project, then
// the same in the person's home and Friday's config directory. A project's skill wins over a
// personal one of the same name.
package skills

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Skill is one skill found on disk.
type Skill struct {
	Name        string
	Description string
	// Dir is the skill's folder; File its SKILL.md.
	Dir  string
	File string
	// Source is where it was found: "project" or "personal".
	Source string
}

const (
	// MaxListed is how many skills the prompt lists; the rest are found by /skills and load_skill.
	MaxListed = 60
	// maxDescription is the convention's limit on a description.
	maxDescription = 1024
	// maxBody is how much of a SKILL.md load_skill returns.
	maxBody = 60_000
	// maxFiles is how many of a skill's other files load_skill names.
	maxFiles = 50
)

var namePattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

// Folders are where skills are looked for, project first: root is the project, home the person's
// home directory, configDir Friday's config directory. Each pair is a folder and its source.
func Folders(root, home, configDir string) [][2]string {
	var out [][2]string
	for _, rel := range []string{".agents/skills", ".claude/skills", ".archymedes/skills"} {
		out = append(out, [2]string{filepath.Join(root, rel), "project"})
	}
	if home != "" {
		for _, rel := range []string{".agents/skills", ".claude/skills"} {
			out = append(out, [2]string{filepath.Join(home, rel), "personal"})
		}
	}
	if configDir != "" {
		out = append(out, [2]string{filepath.Join(configDir, "skills"), "personal"})
	}
	return out
}

// Discover lists the skills in folders (Folders' order decides which of two same-named skills
// wins), sorted by name, and what was wrong with the ones it skipped.
func Discover(folders [][2]string) ([]Skill, []string) {
	seen := map[string]bool{}
	var found []Skill
	var problems []string
	for _, folder := range folders {
		entries, err := os.ReadDir(folder[0])
		if err != nil {
			continue
		}
		for _, e := range entries {
			dir := filepath.Join(folder[0], e.Name())
			if info, err := os.Stat(dir); err != nil || !info.IsDir() {
				continue
			}
			file := filepath.Join(dir, "SKILL.md")
			if _, err := os.Stat(file); err != nil {
				continue
			}
			s, err := parse(file)
			if err != nil {
				problems = append(problems, fmt.Sprintf("%s: %v", file, err))
				continue
			}
			if seen[s.Name] {
				continue
			}
			seen[s.Name] = true
			s.Dir, s.File, s.Source = dir, file, folder[1]
			found = append(found, s)
		}
	}
	sort.Slice(found, func(i, j int) bool { return found[i].Name < found[j].Name })
	return found, problems
}

// parse reads a SKILL.md's frontmatter: name and description are required.
func parse(file string) (Skill, error) {
	f, err := os.Open(file)
	if err != nil {
		return Skill{}, err
	}
	defer f.Close()
	fields, err := frontmatter(bufio.NewScanner(f))
	if err != nil {
		return Skill{}, err
	}
	s := Skill{Name: fields["name"], Description: fields["description"]}
	switch {
	case s.Name == "":
		return Skill{}, fmt.Errorf("its frontmatter has no name")
	case !namePattern.MatchString(s.Name) || len(s.Name) > 64:
		return Skill{}, fmt.Errorf("name %q must be lower-case words joined by hyphens, at most 64 characters", s.Name)
	case s.Description == "":
		return Skill{}, fmt.Errorf("its frontmatter has no description, which is how Friday knows when to use it")
	case len(s.Description) > maxDescription:
		s.Description = s.Description[:maxDescription]
	}
	return s, nil
}

// frontmatter reads the `---` block at the top: `key: value` lines, values plain or quoted, and a
// folded or literal block (`key: >` or `key: |`) followed by indented lines. Anything else in the
// block (lists, nested maps) is skipped: only the top-level text keys are wanted.
func frontmatter(sc *bufio.Scanner) (map[string]string, error) {
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	if !sc.Scan() || strings.TrimSpace(sc.Text()) != "---" {
		return nil, fmt.Errorf("it does not start with a --- frontmatter block")
	}
	fields := map[string]string{}
	block, folded := "", false
	var lines []string
	flush := func() {
		if block == "" {
			return
		}
		sep := "\n"
		if folded {
			sep = " "
		}
		fields[block] = strings.TrimSpace(strings.Join(lines, sep))
		block, lines = "", nil
	}
	for sc.Scan() {
		line := sc.Text()
		if strings.TrimSpace(line) == "---" {
			flush()
			return fields, nil
		}
		if block != "" && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") || strings.TrimSpace(line) == "") {
			lines = append(lines, strings.TrimSpace(line))
			continue
		}
		flush()
		if strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t") || strings.HasPrefix(line, "-") {
			continue // part of a list or map
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		key, value = strings.TrimSpace(key), strings.TrimSpace(value)
		switch value {
		case ">", ">-", "|", "|-":
			block, folded = key, strings.HasPrefix(value, ">")
			continue
		}
		fields[key] = unquote(value)
	}
	return nil, fmt.Errorf("its frontmatter block is not closed with ---")
}

func unquote(v string) string {
	if len(v) >= 2 && (v[0] == '"' && v[len(v)-1] == '"' || v[0] == '\'' && v[len(v)-1] == '\'') {
		return v[1 : len(v)-1]
	}
	return v
}

// Prompt is the skills section of the system prompt: one line per skill, and when to load one.
func Prompt(found []Skill) string {
	if len(found) == 0 {
		return ""
	}
	lines := []string{"Skills: instructions written for tasks like these. When a task matches one, call load_skill with its name before you start, and follow what it says. Its other files are in its folder; read them as it directs."}
	for i, s := range found {
		if i == MaxListed {
			lines = append(lines, fmt.Sprintf("- … and %d more (load_skill finds any by name)", len(found)-MaxListed))
			break
		}
		lines = append(lines, "- "+s.Name+": "+oneLine(s.Description))
	}
	return strings.Join(lines, "\n")
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

// Load is a skill's instructions (the SKILL.md after its frontmatter), its folder and its other files.
func Load(s Skill) (string, error) {
	data, err := os.ReadFile(s.File)
	if err != nil {
		return "", err
	}
	body := string(data)
	if rest, ok := strings.CutPrefix(strings.TrimLeft(body, "\ufeff"), "---"); ok {
		if _, after, found := strings.Cut(rest, "\n---"); found {
			body = after
			if i := strings.IndexByte(body, '\n'); i >= 0 {
				body = body[i+1:]
			}
		}
	}
	body = strings.TrimSpace(body)
	if len(body) > maxBody {
		body = body[:maxBody] + "\n[… cut]"
	}
	var files []string
	_ = filepath.WalkDir(s.Dir, func(path string, d os.DirEntry, err error) error {
		if err != nil || path == s.File {
			return nil
		}
		if d.IsDir() && strings.HasPrefix(d.Name(), ".") && path != s.Dir {
			return filepath.SkipDir
		}
		if !d.IsDir() && len(files) < maxFiles {
			rel, _ := filepath.Rel(s.Dir, path)
			files = append(files, rel)
		}
		return nil
	})
	out := fmt.Sprintf("Skill %s (%s)\nFolder: %s\n\n%s", s.Name, s.Source, s.Dir, body)
	if len(files) > 0 {
		out += "\n\nOther files in its folder (paths relative to it):\n- " + strings.Join(files, "\n- ")
	}
	return out, nil
}

// Tool is load_skill over the skills find returns now, so a skill added mid-session is found.
func Tool(find func() []Skill) *tool.Tool {
	return &tool.Tool{
		Name:        "load_skill",
		Description: "Load a skill's instructions by name, from the Skills list. Call it before a task the skill covers, then follow what it says.",
		Schema: map[string]any{"type": "object", "properties": map[string]any{
			"name": map[string]any{"type": "string", "description": "The skill's name, as listed"},
		}, "required": []string{"name"}},
		Capability:   tool.CapRead,
		Effect:       tool.EffectNone,
		ParallelSafe: true,
		Run: func(_ context.Context, _ tool.Context, args tool.Args) tool.Result {
			name, _ := args["name"].(string)
			name = strings.TrimSpace(name)
			var names []string
			for _, s := range find() {
				if s.Name == name {
					text, err := Load(s)
					if err != nil {
						return tool.Error("The skill " + name + " could not be read: " + err.Error() + ".")
					}
					return tool.Text(text)
				}
				names = append(names, s.Name)
			}
			if len(names) == 0 {
				return tool.Error("There are no skills in this project or your skills folders.")
			}
			return tool.Error("There is no skill named " + name + ". The skills are: " + strings.Join(names, ", ") + ".")
		},
	}
}
