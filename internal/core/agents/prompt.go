package agents

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/roles"
	"github.com/chrisnkuno/friday-cli/internal/core/skills"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
	"github.com/chrisnkuno/friday-cli/internal/core/tools"
)

// The root prompt follows packages/core/src/cli/prompt.ts in substance and wording, shortened
// where the Go engine has fewer tools: behaviour rules, not a persona.

const identity = "You are Friday, a coding agent working in a real project on the user's machine. Your changes are real and immediately visible to them."

var modeGuidance = map[policy.Mode]string{
	policy.Plan: "You are in PLAN mode. You can read, search and reason, but you cannot write files or run commands — those tools are not available to you. " +
		"Produce a concrete plan: the files that must change, what changes in each, and how the result will be verified. Name real paths you have actually read. " +
		"Do not claim to have made changes. When the plan is ready, say so plainly and stop; the user switches to build mode to execute it.",
	policy.Build: "You are in BUILD mode. You can change the workspace and run commands; each call that changes something is approved by the user before it runs (reads and read-only commands are not). " +
		"If the user declines a call, the turn stops there: wait for their direction rather than reaching the same result another way.",
	policy.Auto: "You are in AUTO mode. Edits and commands run without individual approval; only risky actions still ask: deleting work, pushing, publishing or deploying, credentials, privileged commands. " +
		"Work carefully — nobody is reviewing each edit before it lands.",
	policy.Defender: "You are in DEFENDER mode: Friday acting as a defensive security engineer for this project. Every effectful call is approved by the user before it runs. " +
		"Find real, exploitable weaknesses and report them precisely (file:line, the triggering input, the concrete impact) or fix them when asked; never inflate a checklist into findings that do not apply. " +
		"Prefer the project's own linters, audits and tests; rank findings by real exploitability; make the smallest fix that closes the gap.",
}

// defenderPlaybooks is defender mode's index of playbooks: the model reads the few that apply.
var defenderPlaybooks = "Security playbooks, by id. Each holds the concrete triggers for its category: what to grep for and why it matters. " +
	"Call read_playbook(id) for the two or three categories this project actually has a surface for, in one turn, before you start looking, and skip the rest: " +
	"a database-free project has no SQL injection to check, and a project that calls no model has no LLM playbook to run. " +
	"Run scan_secrets early; a pattern match is a lead to verify, not a finding.\n\n" + tools.PlaybookIndex()

const workingLoop = `How to work:
1. Orient. Search and read what the task touches, several files in one turn; search for a symbol's uses before you alter it. Use what is already in this conversation rather than reading it again.
2. Change. The smallest change that does what was asked, matching the surrounding code. Prefer edit_file over write_file for existing files, and put several changes to one file in one call (edits).
3. Verify. Run the smallest relevant test or check and read its result. Never describe an outcome you did not observe.
4. Report what changed, what you ran and what it showed.`

const testFirstLoop = `How to work: test first. Every code change runs this loop:
1. Orient. Search and read what the task touches, several files in one turn; search for a symbol's uses before you alter it. Use what is already in this conversation rather than reading it again.
2. Tests first. Before the code, write the tests that define done, in the project's own runner, cheapest first. INVARIANTS: properties that hold for every valid input, over empty, single, maximum, duplicate, malformed and unicode inputs. BEHAVIOURAL: one assertion per requested rule, on real output. FUNCTIONAL: one test of the assembled thing. Keep them clean: one behaviour per test, named for what it proves, deterministic, no mocking the code under test. Run them and see them fail for the right reason; a bug fix starts with the test that reproduces it.
3. Code. The smallest change that makes them pass, matching the surrounding code. Prefer edit_file over write_file for existing files and put several changes to one file in one call (edits). Never weaken, skip or delete a test to get green; if a test was wrong, fix it and say why.
4. Static analysis, light: the project's own typecheck, linter or vet on what you changed; fix what it reports in your code. Install nothing for it.
5. Report the tests you wrote, that they failed and then passed, and the check's result. Never describe an outcome you did not observe.
Docs, configuration and changes with nothing to assert skip steps 2 and 4: say so in one line.`

const choosingTools = `Choosing tools:
- Files go through the file tools, not the shell: read_file rather than cat, head or sed; grep_files rather than grep or rg; glob_files or list_files rather than find or ls; edit_file rather than sed -i. run_command is for what has no tool: builds, tests, scripts, git, package managers. A server or watcher runs with background: true; read it with command_output and end it with stop_command. Read-only commands (git status, git diff, ls, rg) run without asking.
- Put every tool call you can into the same turn: eight calls in one turn are far faster than eight turns of one. Split calls only when the second needs the first one's result.
- Read tool results carefully. An error says what to change; never send the same failing call again unchanged.
- Some tools are not listed until you search for them with tool_search.`

// instructionFiles are read from the project root, first found wins (INSTRUCTION_FILES in prompt.ts).
var instructionFiles = []string{"AGENTS.override.md", "ARCHYMEDES.md", "AGENTS.md", "CLAUDE.md", ".archymedesrules"}

const instructionsMax = 20_000

func projectInstructions(root string) string {
	for _, name := range instructionFiles {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || len(strings.TrimSpace(string(data))) == 0 {
			continue
		}
		text := string(data)
		if len(text) > instructionsMax {
			text = text[:instructionsMax] + "\n[… cut]"
		}
		return fmt.Sprintf("Project instructions (%s), from the people who work here; follow them:\n%s", name, strings.TrimSpace(text))
	}
	return ""
}

func (s *Session) environment(model string) string {
	branch, _ := s.gitIn(s.cfg.Root, "rev-parse", "--abbrev-ref", "HEAD")
	lines := []string{
		"Environment:",
		"- Project root: " + s.cfg.Root,
		"- Platform: " + runtime.GOOS + "/" + runtime.GOARCH,
		"- Today: " + time.Now().Format("2006-01-02"),
		"- Model: " + model,
	}
	if branch != "" {
		lines = append(lines, "- Git branch: "+branch)
	}
	return strings.Join(lines, "\n")
}

func names(catalog *tool.Catalog) []string {
	var out []string
	for _, t := range catalog.All() {
		out = append(out, t.Name)
	}
	return out
}

func (s *Session) rootSystemPrompt(mode policy.Mode, catalog *tool.Catalog) string {
	loop := workingLoop
	if s.cfg.TestFirst && mode != policy.Plan {
		loop = testFirstLoop
	}
	parts := []string{identity, modeGuidance[mode], loop, choosingTools}
	if guidance := roles.DelegationGuidance(names(catalog), false); guidance != "" {
		parts = append(parts, guidance)
	}
	if mode == policy.Defender {
		parts = append(parts, defenderPlaybooks)
	}
	parts = append(parts, s.environment(s.Models().Selection().Model))
	if instructions := projectInstructions(s.cfg.Root); instructions != "" {
		parts = append(parts, instructions)
	}
	if found, _ := s.Skills(); len(found) > 0 {
		parts = append(parts, skills.Prompt(found))
	}
	if servers := s.mcp.Prompt(); servers != "" {
		parts = append(parts, servers)
	}
	if s.hookContext != "" {
		parts = append(parts, "Context from the project's session-start hooks:\n"+s.hookContext)
	}
	return strings.Join(parts, "\n\n")
}

func (s *Session) childSystemPrompt(c *child, model string) string {
	parts := []string{
		"You are a Friday sub-agent, working in a real project on the user's machine.",
		c.profile.Instructions,
		roles.ReportContract,
	}
	if !c.profile.ReadOnly && s.cfg.TestFirst {
		parts = append(parts, gate.TestFirstBrief)
	}
	parts = append(parts, s.environment(model))
	if c.t.Worktree != "" {
		parts = append(parts, "You work in your own git worktree on branch "+c.t.Branch+"; your changes are committed there when you finish. Do not commit, push or switch branches yourself.")
	}
	return strings.Join(parts, "\n\n")
}
