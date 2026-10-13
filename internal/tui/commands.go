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
		{"undo", "[code|conversation]", "Revert the last turn: files, conversation, or both", func(m *Model, arg string) tea.Cmd { return m.sessionCommand("undo", arg) }},
		{"cost", "", "What this session has spent, and on what", func(m *Model, _ string) tea.Cmd { return m.sessionCommand("cost", "") }},
		{"stats", "", "The session as charts: tokens, time and tools per turn", func(m *Model, _ string) tea.Cmd { return m.runAction("stats") }},
		{"todos", "", "The agent's current plan", func(m *Model, _ string) tea.Cmd { return m.sessionCommand("todos", "") }},
		{"pager", "", "Read the whole session, with line numbers, search and copy", func(m *Model, _ string) tea.Cmd { m.openWindow(m.transcriptPager()); return nil }},
		{"find", "<text>", "Search the session and jump to the newest match", (*Model).cmdFind},
		{"files", "", "The project as a tree, with a preview; @ mentions a file", func(m *Model, _ string) tea.Cmd { return m.openFiles() }},
		{"cat", "<path>", "Read a project file, highlighted", (*Model).cmdCat},
		{"sessions", "", "Earlier sessions in this project (same as /resume)", (*Model).cmdResume},
		{"providers", "", "Which providers are configured, and what each needs", func(m *Model, _ string) tea.Cmd { return m.report("providers", "--providers") }},
		{"settings", "", "Keys, defaults and preferences (opens the settings menu)", func(m *Model, _ string) tea.Cmd { return m.handOff("settings", "settings") }},
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
	for _, name := range []string{"attach", "balance", "continue", "detach", "diagnostics", "edit", "export", "fallback",
		"guide", "jobs", "memory", "pull", "retry", "route", "scan", "tab", "task", "tools", "upgrade", "voice", "wander", "watch", "where", "workspace"} {
		notInThisInterface[name] = "is not in this version of the interface yet"
	}
}

// matchingCommands are the completions for what has been typed so far: "/" alone lists them all.
func matchingCommands(input string) []command {
	if !strings.HasPrefix(input, "/") || strings.ContainsAny(input, " \n") {
		return nil
	}
	prefix := strings.ToLower(input[1:])
	var out []command
	for _, c := range commands {
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
