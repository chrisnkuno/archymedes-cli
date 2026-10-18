package tui

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	tea "charm.land/bubbletea/v2"
)

// Custom commands: a prompt saved as Markdown. `.archymedes/commands/review.md` in the project, or
// `commands/review.md` in the config directory, becomes /review; the project's file wins, and a
// built-in name can never be replaced. `$ARGUMENTS` is replaced by what was typed after the command,
// and an optional `description:` line in `---` front matter is what the list shows.

var commandName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)

type customCommand struct {
	name, description, body, source string
}

// loadCustomCommands reads both directories; a missing or unreadable one is no commands, not an error.
func loadCustomCommands(projectRoot, configDir string) []customCommand {
	byName := map[string]customCommand{}
	// User first, so the project's file replaces it.
	for _, dir := range []string{filepath.Join(configDir, "commands"), filepath.Join(projectRoot, ".archymedes", "commands")} {
		if dir == "commands" || strings.HasPrefix(dir, ".archymedes") {
			continue // an empty root or config directory names no place
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".md") {
				continue
			}
			name := strings.ToLower(strings.TrimSuffix(e.Name(), filepath.Ext(e.Name())))
			if !commandName.MatchString(name) || builtinCommand(name) {
				continue
			}
			raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				continue
			}
			description, body := parseFrontMatter(string(raw))
			if strings.TrimSpace(body) == "" {
				continue
			}
			if description == "" {
				description = firstLine(body)
			}
			byName[name] = customCommand{name: name, description: description, body: body, source: filepath.Join(dir, e.Name())}
		}
	}
	out := make([]customCommand, 0, len(byName))
	for _, c := range byName {
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].name < out[j].name })
	return out
}

func builtinCommand(name string) bool {
	for _, c := range commands {
		if c.name == name {
			return true
		}
	}
	_, gone := notInThisInterface[name]
	return gone
}

// parseFrontMatter splits a leading `---` block off the body and reads its `description:` line.
func parseFrontMatter(text string) (description, body string) {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	rest, ok := strings.CutPrefix(text, "---\n")
	if !ok {
		return "", text
	}
	head, after, found := strings.Cut("\n"+rest, "\n---") // the "\n" lets an empty block close at once
	if !found {
		return "", text
	}
	for _, line := range strings.Split(head, "\n") {
		if key, value, ok := strings.Cut(line, ":"); ok && strings.EqualFold(strings.TrimSpace(key), "description") {
			description = strings.Trim(strings.TrimSpace(value), "\"'")
		}
	}
	return description, strings.TrimPrefix(after, "\n")
}

func firstLine(text string) string {
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimSpace(line); line != "" {
			return strings.TrimLeft(line, "# ")
		}
	}
	return ""
}

// prompt is the body with $ARGUMENTS filled in. A body that never mentions $ARGUMENTS gets what was
// typed appended, so "/review the auth module" is never silently dropped.
func (c customCommand) prompt(args string) string {
	if strings.Contains(c.body, "$ARGUMENTS") {
		return strings.TrimSpace(strings.ReplaceAll(c.body, "$ARGUMENTS", args))
	}
	if args == "" {
		return strings.TrimSpace(c.body)
	}
	return strings.TrimSpace(c.body) + "\n\n" + args
}

// asCommand makes the custom command a row in the same registry as the built-ins.
func (c customCommand) asCommand() command {
	return command{name: c.name, args: "[text]", help: c.description + " (custom)", run: func(m *Model, arg string) tea.Cmd {
		return m.sendPrompt(c.prompt(arg))
	}}
}

// reloadCustomCommands rereads both directories; called when the session's root is known.
func (m *Model) reloadCustomCommands() {
	m.custom = m.custom[:0]
	for _, c := range loadCustomCommands(m.projectRoot(), m.opts.ConfigDir) {
		m.custom = append(m.custom, c.asCommand())
	}
	m.input.custom = m.custom
	m.input.refreshCompletions()
}

// sendPrompt sends text as if it had been typed: now when ready, queued while a turn runs.
func (m *Model) sendPrompt(text string) tea.Cmd {
	switch m.phase {
	case ready:
		return m.send(text)
	case busy, connecting:
		m.queue = append(m.queue, text)
		return m.toast(toastInfo, "Queued — runs when this turn ends")
	}
	return m.toast(toastWarn, "The agent is not running")
}
