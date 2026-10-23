package thread

import (
	"fmt"
	"strconv"
	"strings"

	"charm.land/fantasy"
)

// Fork modes: what a child starts from.
const (
	// ForkNone: only the brief. The default, and what makes a reviewer independent of the
	// reasoning it checks.
	ForkNone = "none"
	// ForkFull: the parent's whole conversation, when a brief would have to repeat most of it.
	ForkFull = "full"
)

// ParseFork accepts "", "none", "full" and "last:N" (N ≥ 1); "" is none.
func ParseFork(mode string) (string, error) {
	mode = strings.TrimSpace(strings.ToLower(mode))
	switch {
	case mode == "" || mode == ForkNone:
		return ForkNone, nil
	case mode == ForkFull:
		return ForkFull, nil
	case strings.HasPrefix(mode, "last:"):
		n, err := strconv.Atoi(strings.TrimPrefix(mode, "last:"))
		if err != nil || n < 1 {
			return "", fmt.Errorf("fork %q: last:N needs a whole number of turns, at least 1", mode)
		}
		return fmt.Sprintf("last:%d", n), nil
	}
	return "", fmt.Errorf("fork %q: use none, full or last:N", mode)
}

// Fork is the part of the parent's conversation a child starts from (Codex's SpawnAgentForkMode:
// FullHistory or LastNTurns). The result is always structurally complete: every tool call has its
// result. The parent is mid-step when it forks (inside the very call that spawns the child), so
// its last assistant message has calls with no results yet; that message is left out, and so is
// any other call whose result is missing.
func Fork(parent []fantasy.Message, mode string) []fantasy.Message {
	mode, err := ParseFork(mode)
	if err != nil || mode == ForkNone {
		return nil
	}
	messages := Complete(parent)
	if mode == ForkFull {
		return messages
	}
	n, _ := strconv.Atoi(strings.TrimPrefix(mode, "last:"))
	start := 0
	seen := 0
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Role == fantasy.MessageRoleUser {
			seen++
			start = i
			if seen == n {
				break
			}
		}
	}
	return messages[start:]
}

// Complete drops tool calls that have no result, and results whose call is gone, so a provider
// never sees a dangling half of a pair.
func Complete(messages []fantasy.Message) []fantasy.Message {
	results := map[string]bool{}
	calls := map[string]bool{}
	for _, m := range messages {
		for _, part := range m.Content {
			switch p := part.(type) {
			case fantasy.ToolResultPart:
				results[p.ToolCallID] = true
			case fantasy.ToolCallPart:
				calls[p.ToolCallID] = true
			}
		}
	}
	var out []fantasy.Message
	for _, m := range messages {
		var parts []fantasy.MessagePart
		for _, part := range m.Content {
			switch p := part.(type) {
			case fantasy.ToolCallPart:
				if !results[p.ToolCallID] {
					continue
				}
			case fantasy.ToolResultPart:
				if !calls[p.ToolCallID] {
					continue
				}
			}
			parts = append(parts, part)
		}
		if len(parts) == 0 {
			continue
		}
		m.Content = parts
		out = append(out, m)
	}
	return out
}
