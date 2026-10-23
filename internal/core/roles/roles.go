// Package roles is what a sub-agent is asked to be: its instructions, budget, model and the tools it
// may call. A port of the role parts of packages/core/src/cli/subagents.ts.
//
// Sub-agents exist for two reasons, and each role is shaped by one of them:
//
//   - Context. A broad search reads twenty files to find the three that matter. Done by an explore
//     sub-agent, only its report enters the main conversation. The read-only roles (explore, plan,
//     review) exist for this, and because they cannot write or ask for approval, several run at once.
//   - Independence. A second opinion is worth something only if it was not formed by the same
//     reasoning it checks. review and verify start from the brief and the code, never from the main
//     agent's conversation.
//
// Depth is one: no sub-agent is ever given a delegation tool. A project or person adds roles as
// Markdown files with front matter, in .archymedes/agents/ or <config>/agents/ (see ParseFile). A file
// may replace a built-in role by using its name.
package roles

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Profile is one role.
type Profile struct {
	Name string
	// Description is for the main agent, in its tool schema on every request: what this role is for.
	Description string
	// ReadOnly roles get only effect-free, parallel-safe tools, run in plan mode, and run concurrently.
	ReadOnly bool
	// Instructions are the role's own, added to the sub-agent's system prompt.
	Instructions string
	// Effort is a thinking effort, one of Efforts.
	Effort        string
	MaxIterations int
	MaxToolCalls  int
	// Tools, when non-nil, are the only tools the role gets (a custom role's tools:).
	Tools []string
	// Without are tools this role never gets, on top of those no sub-agent gets.
	Without []string
	// Source is "built-in", or the file the role was read from.
	Source string
	// Model is which model the role runs on: "main", "small", or an explicit model id.
	Model string
	// Background is the role's default when a delegation call does not say whether to run it in the
	// background.
	Background bool
}

// Model choices a role may name besides an explicit model id.
const (
	ModelMain  = "main"
	ModelSmall = "small"
)

// DelegationTools are the two delegation tools; neither is ever offered to a sub-agent.
var DelegationTools = []string{"delegate_task", "delegate_readonly_task"}

// NeverDelegated are tools no sub-agent gets, whatever its role. The todo list is the main agent's plan
// for the person, and two writers would interleave it; a sub-agent's question would reach the person
// without the context that makes it answerable; memory and deployment are decisions the main agent
// makes with the person, not side effects of a sub-task.
var NeverDelegated = append(slices.Clone(DelegationTools), "todo_write", "todo_read", "ask_user", "remember", "deploy_app")

// WriteTools are the file-editing tools verify goes without.
var WriteTools = []string{"write_file", "edit_file", "notebook_edit"}

// SearchTools are what a read-only role needs and no more: every turn of a sub-agent re-sends its tool
// schemas, and a smaller set is also fewer wrong turns.
var SearchTools = []string{"read_file", "list_files", "glob_files", "grep_files", "repo_map", "find_symbol"}

// Efforts are the thinking efforts a role may name.
var Efforts = []string{"minimal", "low", "medium", "high", "xhigh", "max"}

// IsDelegationTool reports whether name is one of DelegationTools.
func IsDelegationTool(name string) bool { return slices.Contains(DelegationTools, name) }

// ReadOnce is the discipline that matters most to a sub-agent's cost, said once for every read-only role.
const ReadOnce = "Read each file once, whole (read_file returns up to 2000 lines) and put several searches or reads in one turn. Never re-read a file or a range you already have: it is in your conversation above."

// The default role for each delegation tool, when the call names none.
const (
	DefaultReadOnlyRole = "explore"
	DefaultWritableRole = "general"
)

// How much of one tool result, and of all of them, a sub-agent may keep in front of it. A sub-agent's
// conversation is short and its own, so it gets room to read a file in a few pieces instead of many;
// the floor only raises a lean limit.
const (
	SubagentResultChars      = 9_000
	SubagentTotalResultChars = 54_000
)

// WrapUp is said to a sub-agent that ended on its budget, so that what it found is not thrown away.
const WrapUp = "You have run out of steps. Do not call any tool. Write your report now from what you have already found: the answer so far first (say what is still unknown), then the evidence as path:line."

// ReportContract is in every sub-agent's system prompt.
const ReportContract = "You have no memory of the conversation that sent you: the brief below is everything you know, and your final message is the only thing the agent that sent you will see.\n" +
	"Write that message as a report of at most about 400 words: the answer or outcome first, then the evidence (path:line, commands with their exit codes), then anything you could not do and why. No preamble, and no narration of the steps you took.\n" +
	"You have a limited number of steps. If you are running short, stop searching and report what you have found so far: a partial answer is useful, an empty one is not."

func lines(parts ...string) string { return strings.Join(parts, "\n") }

func builtIn() []Profile {
	return []Profile{
		{
			Name:        "explore",
			Description: "find where/how something works (files, symbols, callers); one area each, several at once",
			ReadOnly:    true,
			Instructions: lines(
				"You are an exploration sub-agent. Search wide first (grep_files, glob_files, find_symbol, repo_map), several searches in one turn, then read only the files that answer the brief.",
				ReadOnce,
				"Every claim cites path:line. Say what you looked for and did not find, so the reader knows it is absent rather than missed. Stop as soon as the brief is answered.",
			),
			Effort:        "low",
			MaxIterations: 10,
			MaxToolCalls:  30,
			Tools:         slices.Clone(SearchTools),
			Source:        "built-in",
			Model:         ModelSmall,
		},
		{
			Name:        "plan",
			Description: "files, order, risks and checks for a change across several files",
			ReadOnly:    true,
			Instructions: lines(
				"You are a planning sub-agent. Read the code the change touches and the code that calls it, then write the plan: each step names the file and the function, in the order to do them.",
				ReadOnce,
				"Name the risks (callers that break, behaviour that changes, tests that must change) and how to verify the whole change. Prefer the smallest change that does what the brief asks; follow the conventions already in the code.",
			),
			Effort:        "medium",
			MaxIterations: 12,
			MaxToolCalls:  36,
			Tools:         slices.Clone(SearchTools),
			Source:        "built-in",
			Model:         ModelMain,
		},
		{
			Name:        "review",
			Description: "independent bug review of changed code, before you report it done",
			ReadOnly:    true,
			Instructions: lines(
				"You are a review sub-agent. You did not write this code; check it rather than trust it. Look at the change (git_diff) and at what calls it.",
				ReadOnce,
				"Report only real defects: a concrete input or state, and the wrong result it produces, with path:line. No style notes, no praise, no speculation you have not checked. If you find nothing, say so plainly.",
			),
			Effort:        "medium",
			MaxIterations: 12,
			MaxToolCalls:  36,
			Tools:         append(slices.Clone(SearchTools), "git_diff", "git_status", "git_log", "git_show"),
			Source:        "built-in",
			Model:         ModelMain,
		},
		{
			Name:        "general",
			Description: "an independent, fully specified piece of work, edits included",
			Instructions: lines(
				"You are a sub-agent doing one well-defined piece of a larger task. Do exactly the brief: read before you edit, keep to its scope, and verify what you changed (run the relevant test or check).",
				"Do not touch files outside the brief; if the brief cannot be done as written, stop and say why rather than doing something else.",
			),
			Effort:        "medium",
			MaxIterations: 25,
			MaxToolCalls:  80,
			Source:        "built-in",
			Model:         ModelMain,
		},
		{
			Name:        "verify",
			Description: "run tests/build/typecheck and report failures; never edits",
			Instructions: lines(
				"You are a verification sub-agent. Find how this project checks itself (package scripts, Makefile, CI config), run the checks the brief asks for, and read the failures.",
				"You cannot edit files. Report each failure with the command, its exit code, the exact error and the path:line it points at, and say which failures look related to the brief and which were there before.",
			),
			Effort:        "low",
			MaxIterations: 15,
			MaxToolCalls:  40,
			Without:       slices.Clone(WriteTools),
			Source:        "built-in",
			Model:         ModelSmall,
		},
	}
}

// BuiltIn is the built-in roles, as fresh copies a caller may change.
func BuiltIn() []Profile { return builtIn() }

// AgentsDirectory is where a project keeps its roles, relative to its root.
const AgentsDirectory = ".archymedes/agents"

var (
	roleName    = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
	frontMatter = regexp.MustCompile(`(?s)^---\r?\n(.*?)\r?\n---\r?\n?(.*)$`)
	fieldLine   = regexp.MustCompile(`^([A-Za-z_-]+)\s*:\s*(.*)$`)
	lineBreak   = regexp.MustCompile(`\r?\n`)
	quotes      = regexp.MustCompile(`^["']|["']$`)
	keyMarks    = regexp.MustCompile(`[-_]`)
	brackets    = regexp.MustCompile(`^\[|\]$`)
	yes         = regexp.MustCompile(`(?i)^(true|yes)$`)
)

// ParseFile reads one role from a Markdown file:
//
//	---
//	name: migrations
//	description: Writes and checks database migrations.
//	tools: read_file, grep_files, write_file, run_command
//	readonly: false
//	effort: medium
//	model: small
//	background: false
//	---
//	The instructions, as the body.
//
// name and description are required; a read-only role is limited to effect-free tools whatever tools
// lists. The error names the file, so a role that never loaded is not a mystery.
func ParseFile(displayPath, raw string) (Profile, error) {
	match := frontMatter.FindStringSubmatch(raw)
	if match == nil {
		return Profile{}, fmt.Errorf("%s: needs front matter between --- lines", displayPath)
	}
	fields := map[string]string{}
	for _, line := range lineBreak.Split(match[1], -1) {
		field := fieldLine.FindStringSubmatch(strings.TrimSpace(line))
		if field != nil {
			key := keyMarks.ReplaceAllString(strings.ToLower(field[1]), "")
			fields[key] = quotes.ReplaceAllString(strings.TrimSpace(field[2]), "")
		}
	}
	name := fields["name"]
	if !roleName.MatchString(name) {
		return Profile{}, fmt.Errorf(`%s: "name" must be lowercase letters, digits and dashes`, displayPath)
	}
	description := fields["description"]
	if description == "" {
		return Profile{}, fmt.Errorf(`%s: "description" is required`, displayPath)
	}
	effort, set := fields["effort"]
	if !set {
		effort = "medium"
	}
	if !slices.Contains(Efforts, effort) {
		return Profile{}, fmt.Errorf(`%s: "effort" must be one of %s`, displayPath, strings.Join(Efforts, ", "))
	}
	var tools []string
	if listed, ok := fields["tools"]; ok {
		for _, item := range strings.Split(brackets.ReplaceAllString(listed, ""), ",") {
			if item = strings.TrimSpace(item); item != "" {
				tools = append(tools, item)
			}
		}
	}
	readOnly := yes.MatchString(fields["readonly"])
	bounded := func(key string, fallback, ceiling int) int {
		value, err := strconv.ParseFloat(fields[key], 64)
		if err != nil || math.IsInf(value, 0) || value != math.Trunc(value) || value <= 0 {
			return fallback
		}
		return int(min(value, float64(ceiling)))
	}
	model := fields["model"]
	if model == "" {
		model = ModelMain
	}
	iterations, calls := 25, 80
	if readOnly {
		iterations, calls = 12, 36
	}
	return Profile{
		Name:          name,
		Description:   description,
		ReadOnly:      readOnly,
		Instructions:  strings.TrimSpace(match[2]),
		Effort:        effort,
		MaxIterations: bounded("maxiterations", iterations, 40),
		MaxToolCalls:  bounded("maxtoolcalls", calls, 150),
		Tools:         tools,
		Source:        displayPath,
		Model:         model,
		Background:    yes.MatchString(fields["background"]),
	}, nil
}

// Load is the built-in roles, then the person's (<configDir>/agents/*.md), then the project's
// (<root>/.archymedes/agents/*.md, top level only), each directory in name order; a later role with
// the same name replaces the earlier in its place. A file that does not parse is reported in problems
// and left out. An empty configDir or root skips that directory.
func Load(root, configDir string) (profiles []Profile, problems []string) {
	profiles = builtIn()
	index := map[string]int{}
	for i, profile := range profiles {
		index[profile.Name] = i
	}
	add := func(displayPath, raw string) {
		profile, err := ParseFile(displayPath, raw)
		if err != nil {
			problems = append(problems, err.Error())
			return
		}
		if i, ok := index[profile.Name]; ok {
			profiles[i] = profile
			return
		}
		index[profile.Name] = len(profiles)
		profiles = append(profiles, profile)
	}
	if configDir != "" {
		directory := filepath.Join(configDir, "agents")
		for _, name := range markdownFiles(directory) {
			if raw, err := os.ReadFile(filepath.Join(directory, name)); err == nil {
				add(filepath.Join(directory, name), string(raw))
			}
		}
	}
	if root != "" {
		directory := filepath.Join(root, filepath.FromSlash(AgentsDirectory))
		for _, name := range markdownFiles(directory) {
			if raw, err := os.ReadFile(filepath.Join(directory, name)); err == nil {
				add(AgentsDirectory+"/"+name, string(raw))
			}
		}
	}
	return profiles, problems
}

// markdownFiles is the .md files directly in directory, sorted; none when it cannot be read.
func markdownFiles(directory string) []string {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	var names []string
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".md") {
			names = append(names, entry.Name())
		}
	}
	slices.Sort(names)
	return names
}

// ToolsFor is what a sub-agent may call: the parent's tools, cut down by role.
func ToolsFor(p Profile, parent []*tool.Tool, readOnlyCaps []string) []*tool.Tool {
	var out []*tool.Tool
	for _, t := range parent {
		if slices.Contains(NeverDelegated, t.Name) || slices.Contains(p.Without, t.Name) {
			continue
		}
		if p.Tools != nil && !slices.Contains(p.Tools, t.Name) {
			continue
		}
		if p.ReadOnly && !(t.Effect == tool.EffectNone && t.ParallelSafe && slices.Contains(readOnlyCaps, t.Capability)) {
			continue
		}
		out = append(out, t)
	}
	return out
}

// DelegationGuidance is when to delegate, for the main agent's system prompt; "" when no delegation
// tool is offered. The rules are about cost as much as benefit: a sub-agent starts from nothing, so a
// task the main agent can finish in one or two calls is cheaper done directly.
func DelegationGuidance(toolNames []string, lean bool) string {
	readOnly := slices.Contains(toolNames, "delegate_readonly_task")
	writable := slices.Contains(toolNames, "delegate_task")
	if !readOnly && !writable {
		return ""
	}
	if lean {
		return "- Sub-agents: delegate only broad searches (delegate_readonly_task, several at once, one area each) or a fully specified independent piece (background: true keeps you working; wait_agents collects it); do one- or two-call work yourself, and do not repeat a sub-agent's search: use its report."
	}
	out := []string{"Sub-agents (only their report enters your context; the brief is all they know: goal, area, what you know, what to report):"}
	if readOnly {
		out = append(out,
			"- explore: a search that would take you several rounds. Send several delegate_readonly_task calls in one turn, one area each; they run at once.",
			"- plan before a change across files you have not read; review after substantial edits, then fix what it finds before reporting done.",
		)
	}
	if writable {
		out = append(out, "- delegate_task: general for an independent, fully specified piece while you do the rest; verify to run the checks.")
	}
	out = append(out,
		"- Do one- or two-call lookups yourself. Use a report as given: do not repeat its search, check only the one claim you will rely on.",
		`- Pass background: true to keep working while a sub-agent runs, then collect its report with wait_agents; send_agent follows up with a running or finished sub-agent; fork: "full" gives it this conversation when a brief would have to repeat most of it.`,
	)
	return strings.Join(out, "\n")
}
