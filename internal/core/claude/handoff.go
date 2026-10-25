package claude

import (
	"strings"

	"charm.land/fantasy"
)

// Context across engines (handoff.ts in the TypeScript engine). One Friday session can be run by
// Friday's own models and by the person's Claude Code, switching between them with the transcript
// kept. Friday's models read the transcript themselves; Claude Code keeps its own conversation, so
// it is told, as text, what was said while it was not there:
//
//   - if it has never seen this session (or its own copy is gone), the whole conversation, newest
//     kept within MaxPrefaceChars;
//   - if it is coming back to a session it ran before, only what was said since it last took part.
//
// What is passed is what was said, not a summary and not tool state: the work itself is in the files.

// MaxPrefaceChars is how much of an earlier conversation Claude is told, at most.
const MaxPrefaceChars = 24_000

// Preface is the whole conversation, for a Claude that was not there.
func Preface(messages []fantasy.Message) string {
	return prefaceOf(messages, `This conversation began with another model.`)
}

// Since is what was said after the first seen messages, for a Claude coming back.
func Since(messages []fantasy.Message, seen int) string {
	seen = min(max(seen, 0), len(messages))
	return prefaceOf(messages[seen:], `While you were away, this conversation went on with another model.`)
}

func prefaceOf(messages []fantasy.Message, opening string) string {
	var lines []string
	for _, m := range messages {
		var who string
		switch m.Role {
		case fantasy.MessageRoleUser:
			who = "User"
		case fantasy.MessageRoleAssistant:
			who = "Assistant"
		default:
			continue // tool output is the work, which is in the files
		}
		var text strings.Builder
		for _, part := range m.Content {
			if t, ok := part.(fantasy.TextPart); ok {
				text.WriteString(t.Text)
			}
		}
		if said := strings.TrimSpace(text.String()); said != "" {
			lines = append(lines, who+": "+said)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	body := strings.Join(lines, "\n\n")
	if len(body) > MaxPrefaceChars {
		body = "…\n" + strings.ToValidUTF8(body[len(body)-MaxPrefaceChars:], "")
	}
	return `<earlier_conversation note="` + opening + ` It is what was said, for context; the work it describes is in the files.">` + "\n" + body + "\n</earlier_conversation>"
}
