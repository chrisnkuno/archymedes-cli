package tui

import (
	"fmt"
	"slices"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/archymedes-cli/internal/theme"
)

// command is one slash command. The registry is the single source for completion, /help and dispatch.
type command struct {
	name, args, help string
	run              func(m *Model, arg string) tea.Cmd
}

// completion is one row of the list above the input: a command, or a project path (@path).
type completion struct {
	command
	path string // set for an @path mention
}

var commands []command

func init() {
	commands = []command{
		{"help", "", "Show commands and keys", (*Model).cmdHelp},
		{"mode", "[plan|build|auto|defender]", "Show or change what the agent may do", (*Model).cmdMode},
		{"model", "[name]", "Pick a model, or switch straight to one; the conversation carries on", (*Model).cmdModel},
		{"models", "", "Every model you can switch to, with prices", func(m *Model, _ string) tea.Cmd { return m.cmdModel("") }},
		{"resume", "", "Pick an earlier session in this project and continue it", (*Model).cmdResume},
		{"history", "", "The same: earlier sessions, newest first", (*Model).cmdResume},
		{"diff", "[stat]", "What changed since the last checkpoint", func(m *Model, arg string) tea.Cmd { return m.sessionCommand("diff", arg) }},
		{"undo", "[code|conversation]", "Revert the last turn: files, conversation, or both; again for the one before", func(m *Model, arg string) tea.Cmd { return m.sessionCommand("undo", arg) }},
		{"push", "", "Push this branch to its remote (on the default branch, a new branch is offered first)", (*Model).cmdPush},
		{"pr", "[guidance]", "Push this branch and have the agent open a pull request for it with the GitHub CLI", (*Model).cmdPR},
		{"goal", "[condition|stop]", "Keep the agent working, turn after turn, until the condition holds (checked after each turn)", (*Model).cmdGoal},
		{"worktree", "[name|back]", "Start a new session on a new branch in its own worktree (runs .archymedes/setup.sh there); back returns", (*Model).cmdWorktree},
		{"fork", "", "Copy this conversation into a new session and continue there; this one stays as it is", func(m *Model, _ string) tea.Cmd { return m.sessionCommand("fork", "") }},
		{"context", "", "What fills the model's context window: prompt, tools, conversation, tool results, and what is free", func(m *Model, arg string) tea.Cmd { return m.sessionCommand("context", arg) }},
		{"compact", "[focus]", "Summarize the conversation so far to free the context window, keeping what you name", func(m *Model, arg string) tea.Cmd {
			return tea.Batch(m.toast(toastInfo, "Summarizing the conversation…"), m.sessionCommand("compact", arg))
		}},
		{"review", "[base <ref>|commit <ref>|branch <ref>|focus]", "Review a change for real problems without touching it: the uncommitted work by default", (*Model).cmdReview},
		{"rewind", "[turn [code|conversation]]", "Go back to before any turn of this session, with what each one changed", (*Model).cmdRewind},
		{"cost", "", "What this session has spent, and on what", func(m *Model, _ string) tea.Cmd { return m.sessionCommand("cost", "") }},
		{"stats", "", "The session as charts: tokens, time and tools per turn", func(m *Model, _ string) tea.Cmd { return m.runAction("stats") }},
		{"changes", "", "What changed since the last commit, file by file, as diffs", func(m *Model, _ string) tea.Cmd { return m.runAction("changes") }},
		{"gallery", "", "The photographs, full size: built in and live from Unsplash", func(m *Model, _ string) tea.Cmd { return m.runAction("gallery") }},
		{"todos", "", "The agent's current plan", func(m *Model, _ string) tea.Cmd { return m.sessionCommand("todos", "") }},
		{"key", "[provider]", "Set or replace an API key: pick a provider, paste the key", (*Model).cmdKey},
		{"copy", "[code]", "Copy the last reply, or its last code block, to the clipboard", (*Model).cmdCopy},
		{"select", "", "Let the terminal select text with the mouse (toggle)", (*Model).cmdSelect},
		{"tasks", "", "What is running: the turn, queued prompts and every tool call; x stops it", func(m *Model, _ string) tea.Cmd { return m.runAction("tasks") }},
		{"notifications", "", "Everything the toasts said, newest first", func(m *Model, _ string) tea.Cmd { return m.runAction("notifications") }},
		{"memory", "[add <text> | forget <n> | clear]", "What the agent remembers about you and this project", func(m *Model, arg string) tea.Cmd { return m.sessionCommand("memory", arg) }},
		{"tools", "", "Every tool the agent has, and which ask first", func(m *Model, _ string) tea.Cmd { return m.sessionCommand("tools", "") }},
		{"open", "<path>[:line]", "Open a project file in your $EDITOR, at a line", (*Model).cmdOpen},
		{"new", "", "Start a fresh session here; the current one stays in /resume", (*Model).cmdNew},
		{"commit", "[guidance]", "Have the agent review the uncommitted changes and commit them (no push)", (*Model).cmdCommit},
		{"retry", "", "Send your last message again", (*Model).cmdRetry},
		{"continue", "", "Tell the agent to carry on from where it stopped", (*Model).cmdContinue},
		{"export", "[file]", "Write this session to a Markdown file in the project", (*Model).cmdExport},
		{"where", "", "Which folder, model, mode and session this is", (*Model).cmdWhere},
		{"edit", "", "Write the prompt in $EDITOR, then bring it back here", (*Model).cmdEdit},
		{"pager", "", "Read the whole session, with line numbers, search and copy", func(m *Model, _ string) tea.Cmd { m.openWindow(m.transcriptPager()); return nil }},
		{"find", "<text>", "Search the session and jump to the newest match", (*Model).cmdFind},
		{"files", "", "The project as a tree, with a preview; @ mentions a file", func(m *Model, _ string) tea.Cmd { return m.openFiles() }},
		{"cat", "<path>", "Read a project file, highlighted", (*Model).cmdCat},
		{"sessions", "", "Earlier sessions in this project (same as /resume)", (*Model).cmdResume},
		{"providers", "", "Every provider: use one, give it a key, pick its model, make it the default (alt+p)", func(m *Model, _ string) tea.Cmd { return m.runAction("providers") }},
		{"settings", "", "Every setting, in sections, edited in place (alt+s)", func(m *Model, _ string) tea.Cmd { return m.runAction("settings") }},
		{"update", "", "Check for a newer Archymedes and install it", func(m *Model, _ string) tea.Cmd { return m.handOff("update", "update") }},
		{"plan", "", "Read-only: investigate and propose", func(m *Model, _ string) tea.Cmd { return m.setMode("plan") }},
		{"build", "", "Edit with approval (the default)", func(m *Model, _ string) tea.Cmd { return m.setMode("build") }},
		{"auto", "", "Edit and run without asking", func(m *Model, _ string) tea.Cmd { return m.setMode("auto") }},
		{"defender", "", "Security triage: find and fix real issues, every change asks", func(m *Model, _ string) tea.Cmd { return m.setMode("defender") }},
		{"palette", "", "The start menu: find any app, action, session or file", func(m *Model, _ string) tea.Cmd { return m.runAction("start") }},
		{"keys", "", "See and change every key", func(m *Model, _ string) tea.Cmd { return m.runAction("keys") }},
		{"expand", "", "Show tool output in full, or fold it again (ctrl+o)", (*Model).cmdExpand},
		{"theme", "[name]", "Pick a theme with a live preview, or switch to one (ctrl+t)", (*Model).cmdTheme},
		{"clear", "", "Clear the screen (the session keeps its history)", func(m *Model, _ string) tea.Cmd { m.tr.clear(); return m.animate() }},
		{"cancel", "", "Stop the running turn (esc)", func(m *Model, _ string) tea.Cmd { return m.cancelTurn() }},
		{"quit", "", "Leave Archymedes", func(m *Model, _ string) tea.Cmd { return m.quit() }},
		{"exit", "", "Leave Archymedes", func(m *Model, _ string) tea.Cmd { return m.quit() }},
	}
}

// notInThisInterface are the terminal CLI's commands this interface does not have, each with the
// reason, so someone used to them is told plainly instead of seeing "no such command".
var notInThisInterface = map[string]string{
	"layout": "is gone: this interface always keeps the transcript in a fixed workspace",
	"slow":   "is gone: output is drawn as it arrives, at the terminal's pace",
}

func init() {
	for _, name := range []string{"attach", "balance", "detach", "diagnostics", "fallback",
		"guide", "jobs", "pull", "route", "scan", "tab", "task", "upgrade", "voice", "wander", "watch", "workspace"} {
		notInThisInterface[name] = "is not in this version of the interface yet"
	}
}

// matchingCommands are the completions for what has been typed so far: "/" alone lists them all.
func matchingCommands(input string, extra ...command) []command {
	if !strings.HasPrefix(input, "/") || strings.ContainsAny(input, " \n") {
		return nil
	}
	prefix := strings.ToLower(input[1:])
	var out []command
	for _, c := range append(slices.Clone(commands), extra...) {
		if strings.HasPrefix(c.name, prefix) {
			out = append(out, c)
		}
	}
	return out
}

// runCommand dispatches "/name args". Returns false when the input is not a command at all.
func (m *Model) runCommand(input string) (tea.Cmd, bool) {
	if !strings.HasPrefix(input, "/") || strings.HasPrefix(input, "//") {
		return nil, false // "//" sends a literal leading slash to the model
	}
	name, arg, _ := strings.Cut(strings.TrimPrefix(input, "/"), " ")
	name = strings.ToLower(name)
	for _, c := range commands {
		if c.name == name {
			return c.run(m, strings.TrimSpace(arg)), true
		}
	}
	for _, c := range m.custom {
		if c.name == name {
			return c.run(m, strings.TrimSpace(arg)), true
		}
	}
	if why, ok := notInThisInterface[name]; ok {
		return m.toast(toastWarn, "/"+name+" "+why), true
	}
	return m.toast(toastWarn, fmt.Sprintf("No command /%s — ctrl+p lists them", name)), true
}

func (m *Model) cmdHelp(string) tea.Cmd {
	m.openOverlay(helpOverlay{})
	return nil
}

func (m *Model) cmdMode(arg string) tea.Cmd {
	if arg == "" {
		return m.toast(toastInfo, fmt.Sprintf("Mode: %s — %s", m.mode, modeBlurb[m.mode]))
	}
	return m.setMode(strings.ToLower(arg))
}

func (m *Model) cmdModel(arg string) tea.Cmd {
	if m.agent == nil || m.session.ID == "" {
		return m.toast(toastWarn, "The session is not open yet")
	}
	if arg != "" {
		return m.loadModels(false, arg)
	}
	m.openOverlay(newModelPicker(m, ""))
	return m.loadModels(false, "")
}

func (m *Model) cmdFind(arg string) tea.Cmd {
	p := m.transcriptPager()
	m.openWindow(p)
	if arg == "" {
		_, cmd := p.handle(m, tea.KeyPressMsg{Code: '/', Text: "/"})
		return cmd
	}
	p.search(m, arg)
	return nil
}

func (m *Model) cmdCat(arg string) tea.Cmd {
	if arg == "" {
		return m.openFiles()
	}
	return m.openFile(strings.TrimPrefix(arg, "@"))
}

func (m *Model) cmdResume(string) tea.Cmd {
	m.openOverlay(newResumePicker(m))
	return m.loadSessions()
}

func (m *Model) cmdExpand(string) tea.Cmd {
	m.expanded = !m.expanded
	return nil
}

func (m *Model) cmdTheme(arg string) tea.Cmd {
	if arg == "" || arg == "list" {
		m.openOverlay(newThemePicker(m))
		return nil
	}
	if !slices.Contains(theme.Names(), strings.ToLower(arg)) {
		return m.toast(toastWarn, fmt.Sprintf("No theme %q — /theme opens the picker", arg))
	}
	m.applyTheme(arg)
	return m.toast(toastInfo, "Theme: "+m.th.Name)
}
