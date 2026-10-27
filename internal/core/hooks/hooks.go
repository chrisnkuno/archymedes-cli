// Package hooks runs the person's commands at Friday's lifecycle points: before and after a tool
// call, when a request is sent, before a turn ends, and when a session starts and ends.
//
// Two ways to declare them, so hooks already written keep working:
//   - the Claude Code format, a "hooks" object of events (PreToolUse, PostToolUse, UserPromptSubmit,
//     Stop, SessionStart, SessionEnd) holding matchers and commands, read from .archymedes/hooks.json,
//     the config directory's hooks.json, and .claude/settings.json (project, local and personal);
//   - Friday's script folders, .archymedes/hooks/<phase>/ (pre-tool-use, post-tool-use, pre-turn,
//     post-turn, pre-session, post-session), where any non-zero exit of a pre- script blocks.
//
// A command gets the event as JSON on stdin, in Claude Code's field names (tool_name, tool_input with
// file_path, tool_response, prompt), so a script written for one works for both. For a Claude-format
// hook, exit 2 is the one that blocks or answers back, with stderr as the reason; JSON on stdout
// may say {"decision":"block","reason":…} instead.
package hooks

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Events, in Claude Code's names.
const (
	PreToolUse       = "PreToolUse"
	PostToolUse      = "PostToolUse"
	UserPromptSubmit = "UserPromptSubmit"
	Stop             = "Stop"
	SessionStart     = "SessionStart"
	SessionEnd       = "SessionEnd"
	// PostTurn is Friday's post-turn scripts: told how the turn ended, never answering back.
	PostTurn = "PostTurn"
)

// phases are Friday's script folders and the events they are.
var phases = map[string]string{
	"pre-tool-use": PreToolUse, "post-tool-use": PostToolUse, "pre-turn": UserPromptSubmit,
	"post-turn": PostTurn, "pre-session": SessionStart, "post-session": SessionEnd,
}

// Hook is one command for one event.
type Hook struct {
	Event   string
	Matcher *regexp.Regexp // tool events: which tools; nil is every tool
	Command string
	Timeout time.Duration
	// Script is set for Friday's script folders: any non-zero exit of a pre- script blocks.
	Script bool
	From   string
}

// Set is a session's hooks.
type Set struct {
	root    string
	session string
	hooks   []Hook
	// Problems are files or entries skipped, and why.
	Problems []string
}

// Files are the Claude-format files hooks are read from, in order.
func Files(root, configDir, home string) []string {
	files := []string{filepath.Join(root, ".archymedes", "hooks.json"), filepath.Join(root, ".claude", "settings.json"), filepath.Join(root, ".claude", "settings.local.json")}
	if configDir != "" {
		files = append(files, filepath.Join(configDir, "hooks.json"))
	}
	if home != "" {
		files = append(files, filepath.Join(home, ".claude", "settings.json"))
	}
	return files
}

// Load reads every hook for a project.
func Load(root, configDir, home, session string) *Set {
	s := &Set{root: root, session: session}
	for _, file := range Files(root, configDir, home) {
		s.readFile(file)
	}
	s.readScripts(filepath.Join(root, ".archymedes", "hooks"))
	return s
}

func (s *Set) readFile(file string) {
	data, err := os.ReadFile(file)
	if err != nil {
		return
	}
	var doc struct {
		Hooks map[string][]struct {
			Matcher string `json:"matcher"`
			Hooks   []struct {
				Type    string  `json:"type"`
				Command string  `json:"command"`
				Timeout float64 `json:"timeout"`
			} `json:"hooks"`
		} `json:"hooks"`
	}
	if err := json.Unmarshal(data, &doc); err != nil {
		s.Problems = append(s.Problems, fmt.Sprintf("%s: not valid JSON (%v)", file, err))
		return
	}
	events := make([]string, 0, len(doc.Hooks))
	for event := range doc.Hooks {
		events = append(events, event)
	}
	sort.Strings(events)
	for _, event := range events {
		switch event {
		case PreToolUse, PostToolUse, UserPromptSubmit, Stop, SessionStart, SessionEnd:
		default:
			continue // an event Friday has no moment for (Notification, PreCompact…): not an error
		}
		for _, group := range doc.Hooks[event] {
			var matcher *regexp.Regexp
			if m := strings.TrimSpace(group.Matcher); m != "" && m != "*" {
				re, err := regexp.Compile("^(?:" + m + ")$")
				if err != nil {
					s.Problems = append(s.Problems, fmt.Sprintf("%s: %s matcher %q is not a valid pattern", file, event, m))
					continue
				}
				matcher = re
			}
			for _, h := range group.Hooks {
				if h.Type != "command" || strings.TrimSpace(h.Command) == "" {
					continue
				}
				timeout := 60 * time.Second
				if h.Timeout > 0 {
					timeout = time.Duration(h.Timeout * float64(time.Second))
				}
				s.hooks = append(s.hooks, Hook{Event: event, Matcher: matcher, Command: h.Command, Timeout: timeout, From: file})
			}
		}
	}
}

func (s *Set) readScripts(dir string) {
	names := make([]string, 0, len(phases))
	for phase := range phases {
		names = append(names, phase)
	}
	sort.Strings(names)
	for _, phase := range names {
		entries, err := os.ReadDir(filepath.Join(dir, phase))
		if err != nil {
			continue
		}
		for _, e := range entries {
			path := filepath.Join(dir, phase, e.Name())
			info, err := os.Stat(path)
			if err != nil || info.IsDir() || strings.HasPrefix(e.Name(), ".") {
				continue
			}
			if runtime.GOOS != "windows" && info.Mode()&0o111 == 0 {
				s.Problems = append(s.Problems, fmt.Sprintf("%s: not executable (chmod +x it)", path))
				continue
			}
			s.hooks = append(s.hooks, Hook{Event: phases[phase], Command: path, Timeout: 60 * time.Second, Script: true, From: path})
		}
	}
}

// Hooks are every hook, for /hooks.
func (s *Set) Hooks() []Hook { return s.hooks }

// claudeNames are Friday's tools under the names Claude Code gives the same tools, so a matcher
// written for one ("Edit|Write", "Bash") matches the other.
var claudeNames = map[string]string{
	"run_command": "Bash", "edit_file": "Edit", "write_file": "Write", "read_file": "Read",
	"grep_files": "Grep", "glob_files": "Glob", "list_files": "LS", "web_search": "WebSearch",
	"web_fetch": "WebFetch", "delegate_task": "Task", "delegate_readonly_task": "Task", "todo_write": "TodoWrite",
}

func (h Hook) matches(toolName string) bool {
	if h.Matcher == nil {
		return true
	}
	return h.Matcher.MatchString(toolName) || (claudeNames[toolName] != "" && h.Matcher.MatchString(claudeNames[toolName]))
}

// outcome is what one command said.
type outcome struct {
	exit   int
	stdout string
	stderr string
	err    error
}

func (s *Set) run(ctx context.Context, h Hook, payload map[string]any) outcome {
	payload["session_id"] = s.session
	payload["cwd"] = s.root
	payload["hook_event_name"] = h.Event
	data, _ := json.Marshal(payload)
	ctx, cancel := context.WithTimeout(ctx, h.Timeout)
	defer cancel()
	var cmd *exec.Cmd
	switch {
	case h.Script:
		cmd = exec.CommandContext(ctx, h.Command)
	case runtime.GOOS == "windows":
		cmd = exec.CommandContext(ctx, "cmd", "/C", h.Command)
	default:
		cmd = exec.CommandContext(ctx, "sh", "-c", h.Command)
	}
	cmd.Dir = s.root
	cmd.Env = append(os.Environ(), "CLAUDE_PROJECT_DIR="+s.root, "FRIDAY_PROJECT_DIR="+s.root,
		"ARCHYMEDES_HOOK_EVENT_B64="+base64.StdEncoding.EncodeToString(data))
	cmd.Stdin = bytes.NewReader(data)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &limited{&stdout}, &limited{&stderr}
	err := cmd.Run()
	o := outcome{stdout: strings.TrimSpace(stdout.String()), stderr: strings.TrimSpace(stderr.String())}
	if ctx.Err() == context.DeadlineExceeded {
		o.err = fmt.Errorf("it ran past its %s limit", h.Timeout)
		o.exit = -1
		return o
	}
	if exit, ok := err.(*exec.ExitError); ok {
		o.exit = exit.ExitCode()
	} else if err != nil {
		o.err, o.exit = err, -1
	}
	return o
}

// answer is what an outcome says back: a reason to block or to tell the model, or "".
func (h Hook) answer(o outcome) string {
	if h.Script {
		if o.exit != 0 {
			return firstNonEmpty(o.stderr, fmt.Sprintf("%s exited %d", filepath.Base(h.Command), o.exit))
		}
		return ""
	}
	if o.exit == 2 {
		return firstNonEmpty(o.stderr, "a hook said no ("+h.Command+")")
	}
	if o.exit == 0 && strings.HasPrefix(o.stdout, "{") {
		var out struct {
			Decision string `json:"decision"`
			Reason   string `json:"reason"`
			Specific struct {
				PermissionDecision string `json:"permissionDecision"`
				Reason             string `json:"permissionDecisionReason"`
			} `json:"hookSpecificOutput"`
		}
		if json.Unmarshal([]byte(o.stdout), &out) == nil {
			if out.Decision == "block" {
				return firstNonEmpty(out.Reason, "a hook said no")
			}
			if out.Specific.PermissionDecision == "deny" {
				return firstNonEmpty(out.Specific.Reason, "a hook said no")
			}
		}
	}
	return ""
}

func (s *Set) each(event, toolName string) []Hook {
	var out []Hook
	for _, h := range s.hooks {
		if h.Event == event && (toolName == "" || h.matches(toolName)) {
			out = append(out, h)
		}
	}
	return out
}

// toolInput is the call's arguments as Claude Code names them too: path is also file_path.
func toolInput(args tool.Args) map[string]any {
	in := map[string]any{}
	for k, v := range args {
		in[k] = v
	}
	if p, ok := args["path"]; ok {
		in["file_path"] = p
	}
	return in
}

// toolPayload is a tool event in the hook's own shape: Claude Code's for a Claude-format hook, the
// TypeScript engine's ({event, toolName, arguments}) for Friday's scripts.
func toolPayload(h Hook, event string, call tool.Call) map[string]any {
	if h.Script {
		return map[string]any{"event": event, "toolName": call.Name, "arguments": call.Args}
	}
	name := call.Name
	if claude := claudeNames[name]; claude != "" {
		name = claude
	}
	return map[string]any{"tool_name": name, "friday_tool_name": call.Name, "tool_input": toolInput(call.Args)}
}

// BeforeTool runs PreToolUse hooks; a reason means the call does not run.
func (s *Set) BeforeTool(ctx context.Context, call tool.Call, _ *tool.Tool) string {
	for _, h := range s.each(PreToolUse, call.Name) {
		if why := h.answer(s.run(ctx, h, toolPayload(h, "pre_tool_use", call))); why != "" {
			return why
		}
	}
	return ""
}

// AfterTool runs PostToolUse hooks; what they answer back is added to the result for the model.
func (s *Set) AfterTool(ctx context.Context, call tool.Call, _ *tool.Tool, result tool.Result) string {
	var said []string
	for _, h := range s.each(PostToolUse, call.Name) {
		payload := toolPayload(h, "post_tool_use", call)
		if h.Script {
			payload["result"] = map[string]any{"content": result.Content, "isError": result.IsError}
		} else {
			payload["tool_response"] = map[string]any{"content": result.Content, "is_error": result.IsError}
		}
		if why := h.answer(s.run(ctx, h, payload)); why != "" && !h.Script {
			said = append(said, why)
		}
	}
	return strings.Join(said, "\n")
}

// BeforeStop runs Stop hooks when the model is done; a reason keeps the turn going with it.
// again is true when the turn is already going on because of an earlier answer.
func (s *Set) BeforeStop(ctx context.Context, again bool) string {
	for _, h := range s.each(Stop, "") {
		if why := h.answer(s.run(ctx, h, map[string]any{"stop_hook_active": again})); why != "" {
			return why
		}
	}
	return ""
}

// PromptSubmitted runs UserPromptSubmit hooks (and pre-turn scripts): a refusal stops the request;
// what they print otherwise is context added to it.
func (s *Set) PromptSubmitted(ctx context.Context, prompt string) (refusal, context string) {
	var extra []string
	for _, h := range s.each(UserPromptSubmit, "") {
		payload := map[string]any{"prompt": prompt}
		if h.Script {
			payload = map[string]any{"event": "pre_turn", "objective": prompt}
		}
		o := s.run(ctx, h, payload)
		if why := h.answer(o); why != "" {
			return why, ""
		}
		if o.exit == 0 && o.stdout != "" && !strings.HasPrefix(o.stdout, "{") && !h.Script {
			extra = append(extra, o.stdout)
		}
	}
	return "", strings.Join(extra, "\n")
}

// TurnEnded runs Friday's post-turn scripts; they cannot answer back.
func (s *Set) TurnEnded(ctx context.Context, prompt, status, summary string) {
	for _, h := range s.each(PostTurn, "") {
		s.run(ctx, h, map[string]any{"event": "post_turn", "objective": prompt, "status": status, "summary": summary})
	}
}

// SessionStarted runs SessionStart hooks; what they print joins the system prompt.
func (s *Set) SessionStarted(ctx context.Context, source string) string {
	var extra []string
	for _, h := range s.each(SessionStart, "") {
		o := s.run(ctx, h, map[string]any{"source": source})
		if o.exit == 0 && o.stdout != "" && !h.Script {
			extra = append(extra, o.stdout)
		}
	}
	return strings.Join(extra, "\n")
}

// SessionEnded runs SessionEnd hooks.
func (s *Set) SessionEnded(ctx context.Context) {
	for _, h := range s.each(SessionEnd, "") {
		s.run(ctx, h, map[string]any{"reason": "close"})
	}
}

type limited struct{ b *bytes.Buffer }

func (l *limited) Write(p []byte) (int, error) {
	if room := 64<<10 - l.b.Len(); room > 0 {
		if len(p) > room {
			l.b.Write(p[:room])
		} else {
			l.b.Write(p)
		}
	}
	return len(p), nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
