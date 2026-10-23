package roles

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

func role(t *testing.T, name string) Profile {
	t.Helper()
	for _, p := range BuiltIn() {
		if p.Name == name {
			return p
		}
	}
	t.Fatalf("no built-in %s", name)
	return Profile{}
}

func TestParseReadsEveryField(t *testing.T) {
	p, err := ParseFile("a.md", "---\nname: migrations\ndescription: \"Writes migrations\"\ntools: [read_file, write_file]\nreadonly: false\neffort: high\nmax-iterations: 99\n---\nUse the migrate script.\n")
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "migrations" || p.Description != "Writes migrations" || !slices.Equal(p.Tools, []string{"read_file", "write_file"}) || p.ReadOnly || p.Effort != "high" || p.Instructions != "Use the migrate script." || p.Source != "a.md" {
		t.Fatalf("%+v", p)
	}
	// A file cannot lift a role past the ceiling.
	if p.MaxIterations != 40 || p.MaxToolCalls != 80 {
		t.Fatalf("limits %d/%d", p.MaxIterations, p.MaxToolCalls)
	}
	if p.Model != ModelMain || p.Background {
		t.Fatalf("defaults: model %q background %v", p.Model, p.Background)
	}
}

func TestParseModelBackgroundAndReadOnlyDefaults(t *testing.T) {
	p, err := ParseFile("b.md", "---\r\nname: scout\r\ndescription: d\r\nreadonly: YES\r\nmodel: small\r\nbackground: true\r\nmax_tool_calls: 12\r\n---\r\nLook.")
	if err != nil {
		t.Fatal(err)
	}
	if !p.ReadOnly || p.Model != ModelSmall || !p.Background || p.MaxIterations != 12 || p.MaxToolCalls != 12 || p.Tools != nil || p.Instructions != "Look." {
		t.Fatalf("%+v", p)
	}
	q, _ := ParseFile("c.md", "---\nname: x\ndescription: d\nmodel: 'gpt-5-mini'\nmax-iterations: 2.5\n---\n")
	if q.Model != "gpt-5-mini" || q.MaxIterations != 25 || q.Instructions != "" {
		t.Fatalf("%+v", q)
	}
}

func TestParseRefusesBrokenFilesNamingThem(t *testing.T) {
	for raw, want := range map[string]string{
		"just text": `x\.md.*front matter`,
		"---\nname: Bad Name\ndescription: d\n---\n":         `x\.md.*name`,
		"---\nname: ok\n---\n":                               `x\.md.*description`,
		"---\nname: ok\ndescription: d\neffort: huge\n---\n": `x\.md.*effort`,
	} {
		_, err := ParseFile("x.md", raw)
		if err == nil || !regexp.MustCompile(want).MatchString(err.Error()) {
			t.Errorf("%q: %v, want %s", raw, err, want)
		}
	}
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadOrderOverridesAndProblems(t *testing.T) {
	root := t.TempDir()
	config := filepath.Join(root, "config")
	writeFile(t, filepath.Join(config, "agents", "docs.md"), "---\nname: docs\ndescription: writes docs\n---\nBe brief.\n")
	writeFile(t, filepath.Join(config, "agents", "notes.txt"), "ignored")
	writeFile(t, filepath.Join(root, ".archymedes", "agents", "explore.md"), "---\nname: explore\ndescription: project explore\nreadonly: true\n---\nStart in src/.\n")
	writeFile(t, filepath.Join(root, ".archymedes", "agents", "broken.md"), "no front matter")
	writeFile(t, filepath.Join(root, ".archymedes", "agents", "nested", "deep.md"), "---\nname: deep\ndescription: nested\n---\n")
	writeFile(t, filepath.Join(root, ".archymedes", "agents", "docs.md"), "---\nname: docs\ndescription: project docs\n---\nProject wins.\n")

	profiles, problems := Load(root, config)
	var names []string
	for _, p := range profiles {
		names = append(names, p.Name)
	}
	if want := []string{"explore", "plan", "review", "general", "verify", "docs"}; !slices.Equal(names, want) {
		t.Fatalf("names %v, want %v", names, want)
	}
	if profiles[0].Instructions != "Start in src/." || profiles[0].Source != ".archymedes/agents/explore.md" || profiles[0].Model != ModelMain {
		t.Fatalf("explore %+v", profiles[0])
	}
	if profiles[5].Instructions != "Project wins." {
		t.Fatalf("docs %+v", profiles[5])
	}
	if len(problems) != 1 || !strings.Contains(problems[0], "broken.md") {
		t.Fatalf("problems %v", problems)
	}
	// No directories at all: just the built-ins.
	only, none := Load(filepath.Join(root, "missing"), "")
	if len(only) != 5 || len(none) != 0 {
		t.Fatalf("%d profiles, problems %v", len(only), none)
	}
}

func TestBuiltInsAreCopiesWithModels(t *testing.T) {
	first := BuiltIn()
	first[0].Tools[0] = "changed"
	first[0].Name = "changed"
	if second := BuiltIn(); second[0].Name != "explore" || second[0].Tools[0] != "read_file" {
		t.Fatal("BuiltIn shares state between calls")
	}
	models := map[string]string{"explore": ModelSmall, "verify": ModelSmall, "plan": ModelMain, "review": ModelMain, "general": ModelMain}
	for _, p := range BuiltIn() {
		if p.Model != models[p.Name] || p.Background || p.Source != "built-in" {
			t.Errorf("%s: model %q background %v", p.Name, p.Model, p.Background)
		}
	}
}

// parentTools stands in for the main agent's tools, with the effects and capabilities they declare.
func parentTools() []*tool.Tool {
	read := func(name string) *tool.Tool {
		return &tool.Tool{Name: name, Capability: tool.CapRead, Effect: tool.EffectNone, ParallelSafe: true}
	}
	return []*tool.Tool{
		read("read_file"), read("list_files"), read("glob_files"), read("grep_files"), read("repo_map"), read("find_symbol"),
		read("git_status"), read("git_diff"), read("git_log"), read("git_show"),
		{Name: "compute", Capability: tool.CapPlanning, Effect: tool.EffectNone, ParallelSafe: true},
		{Name: "web_search", Capability: tool.CapResearch, Effect: tool.EffectNone, ParallelSafe: true},
		{Name: "write_file", Capability: tool.CapWrite, Effect: tool.EffectWorkspace},
		{Name: "edit_file", Capability: tool.CapWrite, Effect: tool.EffectWorkspace},
		{Name: "run_command", Capability: tool.CapTerminal, Effect: tool.EffectWorkspace},
		{Name: "todo_write", Capability: tool.CapPlanning, Effect: tool.EffectNone},
		{Name: "todo_read", Capability: tool.CapPlanning, Effect: tool.EffectNone, ParallelSafe: true},
		{Name: "ask_user", Capability: tool.CapPlanning, Effect: tool.EffectNone},
		{Name: "remember", Capability: tool.CapWrite, Effect: tool.EffectWorkspace},
		{Name: "deploy_app", Capability: tool.CapExternal, Effect: tool.EffectExternal},
		{Name: "delegate_task", Capability: tool.CapPlanning, Effect: tool.EffectWorkspace},
		{Name: "delegate_readonly_task", Capability: tool.CapPlanning, Effect: tool.EffectNone, ParallelSafe: true},
	}
}

var readOnlyCaps = []string{tool.CapRead, tool.CapPlanning}

func names(tools []*tool.Tool) []string {
	out := []string{}
	for _, t := range tools {
		out = append(out, t.Name)
	}
	return out
}

func allCaps(tools []*tool.Tool) []string {
	var out []string
	for _, t := range tools {
		out = append(out, t.Capability)
	}
	return out
}

func TestNoRoleGetsDelegationTodosQuestionsMemoryOrDeploy(t *testing.T) {
	for _, p := range BuiltIn() {
		got := names(ToolsFor(p, parentTools(), readOnlyCaps))
		for _, name := range []string{"delegate_task", "delegate_readonly_task", "todo_write", "todo_read", "ask_user", "remember", "deploy_app"} {
			if slices.Contains(got, name) {
				t.Errorf("%s got %s", p.Name, name)
			}
		}
	}
}

func TestReadOnlyEffectFreeVerifyCommandsNoEdits(t *testing.T) {
	tools := parentTools()
	explore := ToolsFor(role(t, "explore"), tools, allCaps(tools))
	for _, tl := range explore {
		if tl.Effect != tool.EffectNone || !tl.ParallelSafe {
			t.Errorf("explore got %s", tl.Name)
		}
	}
	if !slices.Contains(names(explore), "grep_files") {
		t.Error("explore lacks grep_files")
	}
	verify := names(ToolsFor(role(t, "verify"), tools, readOnlyCaps))
	if !slices.Contains(verify, "run_command") || slices.Contains(verify, "write_file") || slices.Contains(verify, "edit_file") {
		t.Errorf("verify %v", verify)
	}
	general := names(ToolsFor(role(t, "general"), tools, readOnlyCaps))
	for _, name := range []string{"write_file", "edit_file", "run_command"} {
		if !slices.Contains(general, name) {
			t.Errorf("general lacks %s", name)
		}
	}
}

func TestReadOnlyRoleNeedsAnOfferedCapability(t *testing.T) {
	custom := Profile{Name: "r", ReadOnly: true}
	got := names(ToolsFor(custom, parentTools(), []string{tool.CapResearch}))
	if !slices.Equal(got, []string{"web_search"}) {
		t.Fatalf("%v", got)
	}
}

func TestCustomRoleLimitedToItsTools(t *testing.T) {
	custom := role(t, "general")
	custom.Name, custom.Tools, custom.Without, custom.Source = "reader", []string{"read_file"}, nil, "x.md"
	if got := names(ToolsFor(custom, parentTools(), readOnlyCaps)); !slices.Equal(got, []string{"read_file"}) {
		t.Fatalf("%v", got)
	}
}

func TestExplorerGetsOnlySearchTools(t *testing.T) {
	tools := parentTools()
	got := names(ToolsFor(role(t, "explore"), tools, allCaps(tools)))
	for _, want := range []string{"read_file", "grep_files", "glob_files", "list_files"} {
		if !slices.Contains(got, want) {
			t.Errorf("lacks %s", want)
		}
	}
	for _, unwanted := range []string{"compute", "git_status", "git_diff", "run_command", "web_search", "write_file"} {
		if slices.Contains(got, unwanted) {
			t.Errorf("has %s", unwanted)
		}
	}
	if len(got) > 6 {
		t.Errorf("%d tools", len(got))
	}
}

func TestReviewerGetsTheDiff(t *testing.T) {
	tools := parentTools()
	got := names(ToolsFor(role(t, "review"), tools, allCaps(tools)))
	for _, want := range []string{"git_diff", "read_file", "grep_files"} {
		if !slices.Contains(got, want) {
			t.Errorf("lacks %s", want)
		}
	}
	if slices.Contains(got, "write_file") {
		t.Error("has write_file")
	}
}

func TestReadOnlyRolesShortBudgetsReadOnce(t *testing.T) {
	for _, name := range []string{"explore", "plan", "review"} {
		p := role(t, name)
		if p.MaxIterations > 12 || p.MaxToolCalls > 36 || !strings.Contains(p.Instructions, "Never re-read a file") {
			t.Errorf("%s: %+v", name, p)
		}
	}
}

func TestReportsShortAndPartialRatherThanEmpty(t *testing.T) {
	if !strings.Contains(DelegationGuidance([]string{"delegate_readonly_task"}, false), "do not repeat its search") {
		t.Error("full guidance")
	}
	if !strings.Contains(DelegationGuidance([]string{"delegate_readonly_task"}, true), "do not repeat a sub-agent's search") {
		t.Error("lean guidance")
	}
	if !strings.Contains(ReportContract, "your final message is the only thing") || !strings.Contains(ReportContract, "a partial answer is useful") {
		t.Error("contract")
	}
}

func TestGuidanceOnlyWhenDelegationOffered(t *testing.T) {
	if got := DelegationGuidance([]string{"read_file"}, false); got != "" {
		t.Fatalf("%q", got)
	}
	if got := DelegationGuidance([]string{"read_file"}, true); got != "" {
		t.Fatalf("lean %q", got)
	}
	readOnly := DelegationGuidance([]string{"delegate_readonly_task"}, false)
	if !strings.Contains(readOnly, "explore") || strings.Contains(readOnly, "delegate_task:") || !strings.HasPrefix(readOnly, "Sub-agents") {
		t.Fatalf("%q", readOnly)
	}
	both := DelegationGuidance([]string{"read_file", "delegate_task", "delegate_readonly_task"}, false)
	if !strings.Contains(both, "delegate_task:") {
		t.Fatalf("%q", both)
	}
	if lean := DelegationGuidance([]string{"read_file", "delegate_task"}, true); !strings.HasPrefix(lean, "- Sub-agents: delegate only") {
		t.Fatalf("%q", lean)
	}
}

func TestGuidanceNamesTheGoEngineCapabilities(t *testing.T) {
	full := DelegationGuidance([]string{"delegate_task"}, false)
	for _, want := range []string{"background: true", "wait_agents", "send_agent", `fork: "full"`} {
		if !strings.Contains(full, want) {
			t.Errorf("full lacks %q", want)
		}
	}
	lean := DelegationGuidance([]string{"delegate_readonly_task"}, true)
	if strings.Count(lean, "\n") != 0 || !strings.Contains(lean, "background: true") || strings.Contains(lean, "send_agent") || strings.Contains(lean, "fork") {
		t.Errorf("lean %q", lean)
	}
}

func TestConstantsKeptFromTypeScript(t *testing.T) {
	if !IsDelegationTool("delegate_task") || IsDelegationTool("read_file") {
		t.Error("IsDelegationTool")
	}
	if SubagentResultChars != 9_000 || SubagentTotalResultChars != 54_000 {
		t.Error("limits")
	}
	if !strings.HasPrefix(WrapUp, "You have run out of steps.") {
		t.Error("wrap up")
	}
}
