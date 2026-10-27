package server

import (
	"fmt"
	"strconv"
	"strings"

	"github.com/chrisnkuno/friday-cli/internal/core/hooks"
	"github.com/chrisnkuno/friday-cli/internal/core/mcp"
	"github.com/chrisnkuno/friday-cli/internal/core/skills"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

// The words of the session commands that report (/subagents, /cost, /skills, /mcp, /hooks).

// hooksText is `/hooks`: each hook, then any file or entry skipped and why.
func hooksText(set *hooks.Set) string {
	var lines []string
	for _, h := range set.Hooks() {
		which := ""
		if h.Matcher != nil {
			which = " [" + strings.TrimSuffix(strings.TrimPrefix(h.Matcher.String(), "^(?:"), ")$") + "]"
		}
		lines = append(lines, fmt.Sprintf("%s%s: %s (%s)", h.Event, which, h.Command, h.From))
	}
	if len(lines) == 0 {
		lines = append(lines, "No hooks. Declare them as Claude Code does, in .archymedes/hooks.json or .claude/settings.json (\"hooks\": {\"PreToolUse\": [{\"matcher\": \"Bash\", \"hooks\": [{\"type\": \"command\", \"command\": \"…\"}]}]}), or as scripts in .archymedes/hooks/<phase>/.")
	}
	for _, p := range set.Problems {
		lines = append(lines, "Skipped "+p)
	}
	return strings.Join(lines, "\n")
}

// mcpText is `/mcp`: each server and its state, then any declaration skipped and why.
func mcpText(m *mcp.Manager) string {
	lines := m.Status()
	if len(m.Servers()) == 0 {
		lines = append(lines, "No MCP servers. Declare them in .mcp.json or .archymedes/mcp.json in the project, or mcp.json in Friday's config directory, as {\"mcpServers\": {\"name\": {\"command\": \"…\"}}}.")
	} else {
		lines = append(lines, "Their tools are not sent with every request: Friday finds them with tool_search when a task needs one.")
	}
	for _, p := range m.Problems() {
		lines = append(lines, "Skipped "+p)
	}
	return strings.Join(lines, "\n")
}

// skillsText is `/skills`: each skill, where it was found and when to use it, then any skipped.
func skillsText(found []skills.Skill, problems []string) string {
	var lines []string
	if len(found) == 0 {
		lines = append(lines, "No skills yet. A skill is a folder with a SKILL.md (frontmatter: name, description) in .agents/skills in the project, or in ~/.agents/skills for every project.")
	}
	for _, s := range found {
		lines = append(lines, fmt.Sprintf("%-24s %-9s %s", s.Name, s.Source, firstLine(s.Description)))
	}
	for _, p := range problems {
		lines = append(lines, "Skipped "+p)
	}
	return strings.Join(lines, "\n")
}

// costText is `/cost`: the main conversation's calls and tokens, each sub-agent's, and the total.
// Money is not priced on this engine yet, and it says so rather than show a guess.
func costText(meta thread.Meta, threads []thread.Thread) string {
	main := thread.Usage{}
	if meta.Usage != nil {
		main = *meta.Usage
	}
	line := func(u thread.Usage) string {
		return fmt.Sprintf("%s tokens in (%s from cache) · %s out", groupDigits(u.InputTokens), groupDigits(u.CachedInputTokens), groupDigits(u.OutputTokens))
	}
	lines := []string{fmt.Sprintf("Main conversation: %s · %s", plural(meta.ModelCalls, "model call"), line(main))}
	total := main
	for _, t := range threads {
		if t.Usage == nil {
			continue
		}
		lines = append(lines, fmt.Sprintf("  %s (%s): %s", t.ID, t.Role, line(*t.Usage)))
		total.InputTokens += t.Usage.InputTokens
		total.CachedInputTokens += t.Usage.CachedInputTokens
		total.OutputTokens += t.Usage.OutputTokens
	}
	lines = append(lines, fmt.Sprintf("Total: %s tokens · %s", groupDigits(total.InputTokens+total.OutputTokens), line(total)),
		"Prices are not shown on the Go engine yet; your provider's dashboard has what was billed.")
	return strings.Join(lines, "\n")
}

func plural(n int, word string) string {
	if n == 1 {
		return "1 " + word
	}
	return fmt.Sprintf("%s %ss", groupDigits(n), word)
}

func threadsText(threads []thread.Thread) string {
	if len(threads) == 0 {
		return "No sub-agents in this session yet."
	}
	var lines []string
	var total thread.Usage
	for _, t := range threads {
		mode := "foreground"
		if t.Background {
			mode = "background"
		}
		line := fmt.Sprintf("%s  %-8s %-10s %-10s %8s  %s", t.ID, t.Role, t.Status, mode, tokens(t.Usage), firstLine(t.Brief))
		if t.Branch != "" {
			line += "  (branch " + t.Branch + ")"
		}
		lines = append(lines, line)
		if u := t.Usage; u != nil {
			total.InputTokens += u.InputTokens
			total.OutputTokens += u.OutputTokens
			total.CachedInputTokens += u.CachedInputTokens
			total.ReasoningTokens += u.ReasoningTokens
		}
	}
	lines = append(lines, fmt.Sprintf("Sub-agents used %s tokens: %s in (%s from cache), %s out.",
		groupDigits(total.InputTokens+total.OutputTokens), groupDigits(total.InputTokens), groupDigits(total.CachedInputTokens), groupDigits(total.OutputTokens)))
	return strings.Join(lines, "\n")
}

// tokens is a thread's tokens in and out, short ("12.4k tokens"); "—" before its first model call.
func tokens(u *thread.Usage) string {
	if u == nil || u.InputTokens+u.OutputTokens == 0 {
		return "—"
	}
	n := u.InputTokens + u.OutputTokens
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM tok", float64(n)/1e6)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk tok", float64(n)/1e3)
	}
	return fmt.Sprintf("%d tok", n)
}

// groupDigits writes a count with thousands separated: 295920 → 295,920.
func groupDigits(n int) string {
	s := strconv.Itoa(n)
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func firstLine(text string) string {
	line := strings.TrimSpace(strings.SplitN(text, "\n", 2)[0])
	if r := []rune(line); len(r) > 60 {
		line = string(r[:59]) + "…"
	}
	return line
}
