package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// startBackground is run_command with background: true. It returns once the command has run for
// the start window or ended, whichever is first, with what it printed so far.
func (w *Workspace) startBackground(ctx context.Context, command string) tool.Result {
	j, err := w.jobs.Start(command, w.Root)
	if err != nil {
		var limit errLimit
		reason := "start_failed"
		if errors.As(err, &limit) {
			reason = "too_many_background_commands"
		} else if errors.Is(err, errClosed) {
			reason = "session_closing"
		}
		return tool.Result{Content: fmt.Sprintf("Not started: %s.", err), IsError: true, Data: map[string]any{"command": command, "background": true, "reason": reason}}
	}
	timer := time.NewTimer(w.jobs.window)
	select {
	case <-j.Done():
	case <-timer.C:
	case <-ctx.Done():
	}
	timer.Stop()
	c, v := j.Read(0, CommandReadMax)
	var b strings.Builder
	fmt.Fprintf(&b, "Started %s in the background (pid %d): %s\n", j.ID, j.Pid, command)
	b.WriteString(headline(v))
	b.WriteString("\n")
	b.WriteString(body(c))
	b.WriteString(footer(c, v))
	data := viewData(v)
	data["background"] = true
	data["next"] = c.Next
	result := tool.Result{Content: b.String(), IsError: failed(v), Data: data}
	if v.Status == JobExited && v.ExitCode == 127 {
		if missing := missingProgram(command, string(c.Bytes())); missing != "" {
			result.Content += fmt.Sprintf("\n'%s' is not available in this environment. Do not retry this command; use another program, or check with 'command -v' first.", missing)
			data["missingProgram"] = missing
		}
	}
	return result
}

func (w *Workspace) commandOutput() *tool.Tool {
	return &tool.Tool{
		Name:        "command_output",
		Description: "Read a background command's output since a cursor, with its status. waitSeconds blocks until new output, a pattern match or its exit; pattern keeps only matching lines; tail keeps the last lines.",
		Schema: tool.ObjectSchema(map[string]any{
			"id":          map[string]any{"type": "string", "description": "The job id run_command returned, such as cmd1."},
			"since":       map[string]any{"type": "integer", "description": "The cursor the previous result gave as next; 0 is from the start. Default: where the last read ended."},
			"waitSeconds": map[string]any{"type": "integer", "description": fmt.Sprintf("Wait up to this long for news; at most %d. Default 0: return at once.", int(CommandWaitCeiling.Seconds()))},
			"pattern":     map[string]any{"type": "string", "description": "A regular expression: return only matching lines, and with waitSeconds wait until one appears."},
			"tail":        map[string]any{"type": "integer", "description": "Return only the last this many lines of the new output."},
		}, "id"),
		Capability: tool.CapTerminal, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			j, missing := w.job(args)
			if missing != nil {
				return *missing
			}
			since := int64(-1)
			if s, ok := tool.IntArg(args, "since"); ok {
				since = int64(max(s, 0))
			}
			since = j.Cursor(since)
			var match *regexp.Regexp
			if p := tool.StringArg(args, "pattern"); p != "" {
				re, err := regexp.Compile(p)
				if err != nil {
					return tool.Error(fmt.Sprintf("`pattern` is not a regular expression: %v", err))
				}
				match = re
			}
			tail, _ := tool.IntArg(args, "tail")
			wait, waited := tool.IntArg(args, "waitSeconds")
			waited = waited && wait > 0
			if waited {
				deadline := time.Now().Add(min(time.Duration(wait)*time.Second, CommandWaitCeiling))
				if match == nil {
					j.Await(ctx, since, deadline)
				} else {
					awaitMatch(ctx, j, since, deadline, match)
				}
			}
			var c chunk
			var v JobView
			switch {
			case match != nil:
				c, v = j.read(since, 0, false, false)
			default:
				c, v = j.read(since, CommandReadMax, tail > 0, true)
			}
			text := ""
			if match != nil {
				text, c = filterLines(c, v.Status == JobRunning, match)
				j.advanceMark(c.Next)
			} else {
				text = body(c)
			}
			if tail > 0 {
				text = lastLines(text, tail)
			}
			data := viewData(v)
			data["since"], data["next"], data["dropped"], data["pending"] = c.Since, c.Next, c.Dropped, c.Pending
			// What the stuck-call detector compares: the same read is a repeat only when it found the
			// job where the last one did. A read that waited on a running job is never a repeat; the
			// wait itself paces it.
			data["progress"] = fmt.Sprintf("%s %d %d", v.Status, v.Bytes, c.Next)
			if waited && v.Status == JobRunning {
				data["progress"] = fmt.Sprintf("waited %d", v.Runtime.Milliseconds())
			}
			return tool.Result{Content: headline(v) + "\n" + text + footer(c, v), Data: data}
		},
	}
}

func (w *Workspace) stopCommand() *tool.Tool {
	return &tool.Tool{
		Name:        "stop_command",
		Description: fmt.Sprintf("Stop a background command and everything it started: SIGTERM, then SIGKILL after %d seconds. Stopping one that already ended changes nothing.", int(CommandStopGrace.Seconds())),
		Schema: tool.ObjectSchema(map[string]any{
			"id": map[string]any{"type": "string", "description": "The job id, such as cmd1."},
		}, "id"),
		// It ends only what Friday started this session, so there is nothing to approve; it runs
		// alone, never beside another call.
		Capability: tool.CapTerminal, Effect: tool.EffectNone,
		Run: func(_ context.Context, _ tool.Context, args tool.Args) tool.Result {
			j, missing := w.job(args)
			if missing != nil {
				return *missing
			}
			before := j.View()
			w.jobs.Stop(j)
			v := j.View()
			data := viewData(v)
			if before.Status != JobRunning {
				data["alreadyEnded"] = true
				return tool.Result{Content: fmt.Sprintf("%s had already ended: %s", j.ID, headline(v)), Data: data}
			}
			return tool.Result{Content: "Stopped. " + headline(v), Data: data}
		},
	}
}

func (w *Workspace) listCommands() *tool.Tool {
	return &tool.Tool{
		Name:        "list_commands",
		Description: "List this session's background commands: id, status, runtime, output size and command.",
		Schema:      tool.ObjectSchema(map[string]any{}),
		Capability:  tool.CapTerminal, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(_ context.Context, _ tool.Context, _ tool.Args) tool.Result {
			jobs := w.jobs.List()
			if len(jobs) == 0 {
				return tool.Result{Content: "No background commands this session.", Data: map[string]any{"commands": []map[string]any{}}}
			}
			lines := make([]string, 0, len(jobs))
			rows := make([]map[string]any, 0, len(jobs))
			for _, j := range jobs {
				v := j.View()
				lines = append(lines, headline(v)+" · "+v.Command)
				rows = append(rows, viewData(v))
			}
			return tool.Result{Content: strings.Join(lines, "\n"), Data: map[string]any{"commands": rows}}
		},
	}
}

// job finds the job an `id` argument names, or the error to return.
func (w *Workspace) job(args tool.Args) (*Job, *tool.Result) {
	id := strings.TrimSpace(tool.StringArg(args, "id"))
	if id == "" {
		r := tool.Error("`id` is required: the job id run_command returned, such as cmd1")
		return nil, &r
	}
	j, ok := w.jobs.Get(id)
	if !ok {
		var known []string
		for _, k := range w.jobs.List() {
			known = append(known, k.ID)
		}
		list := "there are none"
		if len(known) > 0 {
			list = "there are " + strings.Join(known, ", ")
		}
		r := tool.Result{Content: fmt.Sprintf("No background command %s this session; %s.", id, list), IsError: true, Data: map[string]any{"id": id, "reason": "unknown_command"}}
		return nil, &r
	}
	return j, nil
}

// awaitMatch waits until a complete line past since matches, the job ends, or the deadline. Each
// byte is scanned once (an unfinished last line again when it grows), so the cost is the new output.
func awaitMatch(ctx context.Context, j *Job, since int64, deadline time.Time, match *regexp.Regexp) {
	scan, seen := since, since
	for {
		_, running := j.Await(ctx, seen, deadline)
		c, _ := j.read(scan, 0, false, false)
		seen = c.Next
		data := c.Bytes()
		complete := data
		if running {
			if i := bytes.LastIndexByte(data, '\n'); i >= 0 {
				complete = data[:i+1]
			} else if len(data) < CommandReadMax {
				complete = nil
			}
		}
		for _, line := range bytes.Split(complete, []byte{'\n'}) {
			if match.Match(line) {
				return
			}
		}
		scan = c.Since + int64(len(complete))
		if len(complete) > len(c.Before) {
			scan += c.Dropped
		}
		if !running || !time.Now().Before(deadline) || ctx.Err() != nil {
			return
		}
	}
}

// filterLines is the matching lines of c, at most CommandReadMax bytes of them (the last). While the
// job runs, an unfinished last line is left for the next read: the cursor stops before it.
func filterLines(c chunk, running bool, match *regexp.Regexp) (string, chunk) {
	if running && c.Pending == 0 {
		all := c.After
		if c.Dropped == 0 {
			all = c.Before
		}
		if i := bytes.LastIndexByte(all, '\n'); len(all) > 0 && i < len(all)-1 && len(all)-i-1 < CommandReadMax {
			cut := int64(len(all) - i - 1)
			c.Next -= cut // Pending stays what max held back; the unfinished line is not news yet
			if c.Dropped == 0 {
				c.Before = c.Before[:i+1]
			} else {
				c.After = c.After[:i+1]
			}
		}
	}
	var kept []string
	for _, part := range [][]byte{c.Before, c.After} {
		for _, line := range strings.Split(string(part), "\n") {
			if line != "" && match.MatchString(line) {
				kept = append(kept, line)
			}
		}
	}
	if len(kept) == 0 {
		return "(no matching lines)", c
	}
	text := strings.Join(kept, "\n")
	if len(text) > CommandReadMax {
		text = "[… earlier matches cut …]\n" + text[len(text)-CommandReadMax:]
	}
	if c.Dropped > 0 {
		text = fmt.Sprintf("[… %s bytes dropped before these lines were read …]\n", thousands(c.Dropped)) + text
	}
	return text, c
}

// lastLines is the last n lines of text.
func lastLines(text string, n int) string {
	text = strings.TrimRight(text, "\n")
	i := len(text)
	for k := 0; k < n; k++ {
		j := strings.LastIndexByte(text[:i], '\n')
		if j < 0 {
			return text
		}
		i = j
	}
	return text[i+1:]
}

// headline is a job in one line: `cmd1 exited 0 · 3.1s · 1,204 bytes`.
func headline(v JobView) string {
	return fmt.Sprintf("%s %s · %s · %s bytes", v.ID, statusText(v), v.Runtime.Round(100*time.Millisecond), thousands(v.Bytes))
}

func statusText(v JobView) string {
	switch v.Status {
	case JobExited:
		return fmt.Sprintf("exited %d", v.ExitCode)
	case JobFailed:
		return "failed: " + v.Failure
	}
	return string(v.Status)
}

func failed(v JobView) bool {
	return v.Status == JobFailed || (v.Status == JobExited && v.ExitCode != 0)
}

// body is a chunk as text, the dropped bytes marked where they were.
func body(c chunk) string {
	var b strings.Builder
	b.WriteString(strings.ToValidUTF8(string(c.Before), "�"))
	if c.Dropped > 0 {
		if b.Len() > 0 && !strings.HasSuffix(b.String(), "\n") {
			b.WriteString("\n")
		}
		fmt.Fprintf(&b, "[… %s bytes dropped …]\n", thousands(c.Dropped))
		b.WriteString(strings.ToValidUTF8(string(c.After), "�"))
	}
	if b.Len() == 0 {
		return "(no new output)"
	}
	return strings.TrimRight(b.String(), "\n")
}

// footer says where to read next, when there is more to read.
func footer(c chunk, v JobView) string {
	switch {
	case c.Pending > 0:
		return fmt.Sprintf("\n[%s more bytes; read on with since=%d]", thousands(c.Pending), c.Next)
	case v.Status == JobRunning:
		return fmt.Sprintf("\n[next: since=%d]", c.Next)
	}
	return ""
}

func viewData(v JobView) map[string]any {
	data := map[string]any{"id": v.ID, "command": v.Command, "pid": v.Pid, "status": string(v.Status), "runtimeMs": v.Runtime.Milliseconds(), "bytes": v.Bytes}
	if v.Status != JobRunning {
		data["exitCode"] = v.ExitCode
	}
	if v.Failure != "" {
		data["failure"] = v.Failure
	}
	return data
}

// thousands writes n as 12,345.
func thousands(n int64) string {
	s := fmt.Sprint(n)
	if n < 0 {
		return s
	}
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}
