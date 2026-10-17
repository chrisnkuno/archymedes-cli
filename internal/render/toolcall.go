// Package render is the pure transcript renderers: text in, styled lines out, no terminal I/O.
package render

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// TruncateMiddle shortens value to maximum runes without hiding which end was cut: paths and
// commands carry their meaning at both ends.
func TruncateMiddle(value string, maximum int) string {
	clean := []rune(strings.Join(strings.Fields(value), " "))
	if len(clean) <= maximum {
		return string(clean)
	}
	if maximum <= 1 {
		return string(clean[:max(0, maximum)])
	}
	head := (maximum) / 2 // ceil((maximum-1)/2)
	tail := (maximum - 1) / 2
	out := string(clean[:head]) + "…"
	if tail > 0 {
		out += string(clean[len(clean)-tail:])
	}
	return out
}

func asString(value any) string {
	if s, ok := value.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

func asNumber(value any) (int, bool) {
	if f, ok := value.(float64); ok {
		return int(f), true
	}
	return 0, false
}

func countOf(value any) int {
	if list, ok := value.([]any); ok {
		return len(list)
	}
	return 0
}

func orDefault(value, fallback string) string {
	if value == "" {
		return fallback
	}
	return value
}

// DescribeToolCall is the one argument worth showing for a call, chosen per tool
// (`describeToolCall` in render/transcript.ts).
func DescribeToolCall(toolName string, args map[string]any) string {
	switch toolName {
	case "read_file":
		path := asString(args["path"])
		offset, hasOffset := asNumber(args["offset"])
		if !hasOffset {
			return path
		}
		if limit, ok := asNumber(args["limit"]); ok {
			return fmt.Sprintf("%s:%d-%d", path, offset, offset+limit-1)
		}
		return fmt.Sprintf("%s:%d+", path, offset)
	case "write_file", "edit_file":
		return asString(args["path"])
	case "list_files":
		return orDefault(asString(args["path"]), ".")
	case "glob_files":
		return asString(args["pattern"])
	case "grep_files":
		query, include := asString(args["query"]), asString(args["include"])
		if include != "" {
			return fmt.Sprintf("%q in %s", query, include)
		}
		return `"` + query + `"`
	case "scan_secrets":
		return asString(args["include"])
	case "run_command":
		return asString(args["command"])
	case "start_application":
		command := asString(args["command"])
		if port, ok := asNumber(args["port"]); ok {
			return fmt.Sprintf("%s :%d", command, port)
		}
		return command
	case "application_status", "stop_application":
		return asString(args["id"])
	case "web_search", "deep_research":
		return `"` + asString(args["query"]) + `"`
	case "web_fetch":
		return asString(args["url"])
	case "ask_user":
		return asString(args["question"])
	case "todo_write":
		if items, ok := args["items"].([]any); ok {
			return plural(len(items), "step", "steps")
		}
		var parts []string
		if n := countOf(args["start"]); n > 0 {
			parts = append(parts, fmt.Sprintf("%d started", n))
		}
		if n := countOf(args["complete"]); n > 0 {
			parts = append(parts, fmt.Sprintf("%d done", n))
		}
		return strings.Join(parts, ", ")
	default:
		// An unknown tool still deserves a useful line, so a string argument stands in. Map order
		// is random in Go, so the well-known subject keys are tried first, then any, sorted.
		for _, key := range []string{"path", "command", "pattern", "query", "task", "url", "id"} {
			if s := asString(args[key]); s != "" {
				return s
			}
		}
		for _, key := range sortedKeys(args) {
			if s := asString(args[key]); s != "" {
				return s
			}
		}
		return ""
	}
}

var (
	exitLine       = regexp.MustCompile(`^exit (\d+)`)
	previewURL     = regexp.MustCompile(`https?://\S+`)
	trailingPunct  = regexp.MustCompile(`[.,;:)\]]+$`)
	appStatusLine  = regexp.MustCompile(`^(\S+): (starting|running|exited) (?:at (\S+)|(in the background))`)
	secretCount    = regexp.MustCompile(`^(\d+) possible secret`)
	todoDone       = regexp.MustCompile(`(?m)^\[x\]`)
	todoAny        = regexp.MustCompile(`(?m)^\[[ x~]\]`)
	noMatches      = regexp.MustCompile(`(?i)^No matches`)
	noSecrets      = regexp.MustCompile(`(?i)^No likely secrets`)
	noFilesMatched = regexp.MustCompile(`(?i)^No files matched`)
)

func lineCount(content string) int {
	trimmed := strings.TrimRight(content, "\n")
	if trimmed == "" {
		return 0
	}
	return strings.Count(trimmed, "\n") + 1
}

func firstLine(body string) string {
	line, _, _ := strings.Cut(body, "\n")
	return line
}

func firstNonBlank(lines []string) string {
	for _, line := range lines {
		if strings.TrimSpace(line) != "" {
			return line
		}
	}
	return ""
}

// SummarizeToolResult is what a call produced, in as few words as carry the meaning
// (`summarizeToolResult` in render/transcript.ts).
func SummarizeToolResult(toolName, body string, isError bool) string {
	switch toolName {
	case "run_command":
		exit := exitLine.FindStringSubmatch(body)
		if exit == nil {
			return TruncateMiddle(firstLine(body), 60)
		}
		code, _ := strconv.Atoi(exit[1])
		if code == 0 {
			return "exit 0"
		}
		if detail := firstNonBlank(strings.Split(body, "\n")[1:]); detail != "" {
			return fmt.Sprintf("exit %d · %s", code, TruncateMiddle(detail, 48))
		}
		return fmt.Sprintf("exit %d", code)
	case "start_application":
		if isError {
			return TruncateMiddle(firstNonBlank(strings.Split(body, "\n")), 60)
		}
		if url := previewURL.FindString(body); url != "" {
			return "ready at " + trailingPunct.ReplaceAllString(url, "")
		}
		return TruncateMiddle(firstLine(body), 60)
	case "application_status":
		var entries [][]string
		for _, line := range strings.Split(body, "\n") {
			if m := appStatusLine.FindStringSubmatch(strings.TrimSpace(line)); m != nil {
				entries = append(entries, m)
			}
		}
		switch len(entries) {
		case 0:
			return "none"
		case 1:
			if entries[0][4] != "" {
				return entries[0][2] + " in the background"
			}
			return entries[0][2] + " at " + entries[0][3]
		}
		return fmt.Sprintf("%d applications", len(entries))
	case "grep_files":
		if noMatches.MatchString(body) {
			return "no matches"
		}
		return plural(lineCount(body), "match", "matches")
	case "scan_secrets":
		if noSecrets.MatchString(body) {
			return "clean"
		}
		if m := secretCount.FindStringSubmatch(body); m != nil {
			return m[1] + " possible secret" + map[bool]string{true: "", false: "s"}[m[1] == "1"]
		}
		return "findings"
	case "glob_files":
		if noFilesMatched.MatchString(body) {
			return "no files"
		}
		return plural(lineCount(body), "file", "files")
	case "list_files":
		return plural(lineCount(body), "entry", "entries")
	case "read_file":
		return plural(lineCount(body), "line", "lines")
	case "write_file", "edit_file":
		return TruncateMiddle(firstLine(body), 60)
	case "ask_user":
		if answer, ok := strings.CutPrefix(firstLine(body), "The user answered: "); ok {
			return TruncateMiddle(answer, 60)
		}
		if strings.Contains(body, "dismissed the question") {
			return "dismissed"
		}
		return TruncateMiddle(firstLine(body), 48)
	case "todo_write", "todo_read":
		done, total := len(todoDone.FindAllString(body, -1)), len(todoAny.FindAllString(body, -1))
		if total > 0 {
			return fmt.Sprintf("%d/%d done", done, total)
		}
		return TruncateMiddle(firstLine(body), 40)
	default:
		limit := 48
		if isError {
			limit = 60
		}
		return TruncateMiddle(firstNonBlank(strings.Split(body, "\n")), limit)
	}
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}
