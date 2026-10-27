package skills

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

func write(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestSkillsAreFoundWhereOtherAgentsLookAndTheProjectsWin(t *testing.T) {
	root, home, config := t.TempDir(), t.TempDir(), t.TempDir()
	write(t, filepath.Join(root, ".agents/skills/release/SKILL.md"), "---\nname: release\ndescription: Cut a release of this project\n---\nRun the release steps.\n")
	write(t, filepath.Join(root, ".claude/skills/pdf/SKILL.md"), "---\nname: pdf\ndescription: >\n  Fill and merge\n  PDF forms\nallowed-tools:\n  - Read\n---\nUse pypdf.\n")
	write(t, filepath.Join(home, ".agents/skills/release/SKILL.md"), "---\nname: release\ndescription: My own release steps\n---\n")
	write(t, filepath.Join(home, ".claude/skills/Bad Name/SKILL.md"), "---\nname: Bad Name\ndescription: x\n---\n")
	write(t, filepath.Join(config, "skills/notes/SKILL.md"), "---\nname: \"notes\"\ndescription: 'Keep meeting notes'\n---\n")
	write(t, filepath.Join(config, "skills/broken/SKILL.md"), "no frontmatter here\n")
	write(t, filepath.Join(config, "skills/not-a-skill/README.md"), "just a folder\n")

	found, problems := Discover(Folders(root, home, config))
	var got []string
	for _, s := range found {
		got = append(got, s.Name+"|"+s.Source+"|"+s.Description)
	}
	want := []string{"notes|personal|Keep meeting notes", "pdf|project|Fill and merge PDF forms", "release|project|Cut a release of this project"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("found:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	if len(problems) != 2 || !strings.Contains(strings.Join(problems, "\n"), "lower-case words") || !strings.Contains(strings.Join(problems, "\n"), "frontmatter") {
		t.Fatalf("problems: %v", problems)
	}
}

func TestLoadingASkillGivesItsInstructionsAndItsFiles(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".agents/skills/pdf")
	write(t, filepath.Join(dir, "SKILL.md"), "---\nname: pdf\ndescription: Fill PDF forms\n---\n\n# Filling forms\nRun scripts/fill.py.\n")
	write(t, filepath.Join(dir, "scripts/fill.py"), "print('fill')\n")
	write(t, filepath.Join(dir, "reference.md"), "fields\n")
	found, _ := Discover(Folders(root, "", ""))
	run := Tool(func() []Skill { return found }).Run

	r := run(context.Background(), tool.Context{}, tool.Args{"name": "pdf"})
	for _, want := range []string{"Skill pdf (project)", "Folder: " + dir, "# Filling forms", "Run scripts/fill.py.", "- reference.md", filepath.Join("scripts", "fill.py")} {
		if r.IsError || !strings.Contains(r.Content, want) {
			t.Errorf("load_skill lacks %q:\n%s", want, r.Content)
		}
	}
	if strings.Contains(r.Content, "description: Fill PDF forms") {
		t.Errorf("the frontmatter was returned:\n%s", r.Content)
	}
	if r := run(context.Background(), tool.Context{}, tool.Args{"name": "pdff"}); !r.IsError || !strings.Contains(r.Content, "The skills are: pdf.") {
		t.Errorf("unknown name: %+v", r)
	}
	if r := Tool(func() []Skill { return nil }).Run(context.Background(), tool.Context{}, tool.Args{"name": "x"}); !r.IsError {
		t.Errorf("no skills: %+v", r)
	}
}

func TestThePromptListsSkillsInOneLineEachUpToTheCap(t *testing.T) {
	if Prompt(nil) != "" {
		t.Fatal("a prompt with no skills")
	}
	var many []Skill
	for i := 0; i < MaxListed+5; i++ {
		many = append(many, Skill{Name: fmt.Sprintf("s%02d", i), Description: "does\n  thing"})
	}
	p := Prompt(many)
	if !strings.Contains(p, "- s00: does thing") || !strings.Contains(p, "… and 5 more") || strings.Contains(p, fmt.Sprintf("s%02d:", MaxListed)) {
		t.Fatalf("%s", p)
	}
}
