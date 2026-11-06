package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/testtime"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// How long a command runs, unless told, and at most; the rest are its internal measures.
const (
	CommandTimeout = 120 * time.Second
	CommandCeiling = 30 * time.Minute
	// persistentTrial is how long a command that looks like a server runs before it is called one.
	persistentTrial = 15 * time.Second
	outputMax       = 200_000
)

func (w *Workspace) runCommand() *tool.Tool {
	return &tool.Tool{
		Name:        "run_command",
		Description: "Run a shell command in the project root and wait for it: builds, tests, scripts. For a server or watcher that never exits, pass background: true; it returns a job id at once, then read it with command_output and end it with stop_command.",
		Schema: tool.ObjectSchema(map[string]any{
			"command":        map[string]any{"type": "string"},
			"timeoutSeconds": map[string]any{"type": "integer", "description": fmt.Sprintf("Default %d, max %d. Not for background commands, which run until stopped.", int(CommandTimeout.Seconds()), int(CommandCeiling.Seconds()))},
			"background":     map[string]any{"type": "boolean", "description": fmt.Sprintf("Start it and return at once with a job id and what it printed in its first %d seconds. It runs until it exits, stop_command, or the session ends.", int(CommandStartWindow.Seconds()))},
			"fresh":          map[string]any{"type": "boolean", "description": "Run tests again even when nothing changed since the same command passed; without it, that pass is returned at once."},
		}, "command"),
		Capability: tool.CapTerminal, Effect: tool.EffectWorkspace,
		// Safe to run beside others only when a call changes nothing: the loop batches calls whose
		// effect, judged per call below, is none (several `rg` and `git diff` at once).
		ParallelSafe: true,
		// `git status`, `rg`, `ls`: nothing to approve and nothing to verify. A rule that says ask
		// is still the person's call whatever the command.
		EffectFor: func(args tool.Args) tool.Effect {
			command := tool.StringArg(args, "command")
			// A process left running is never a read, whatever it runs.
			if command == "" || tool.BoolArg(args, "background") {
				return tool.EffectWorkspace
			}
			if v := policy.JudgeCommand(w.Rules, command); v != nil && v.Decision == "ask" {
				return tool.EffectWorkspace
			}
			if policy.IsReadOnlyCommand(command, runtime.GOOS) {
				return tool.EffectNone
			}
			return tool.EffectWorkspace
		},
		// The card shows a test run's expected time, and whether it can wait for the end, as it starts.
		Preview: func(args tool.Args) map[string]any {
			if tool.BoolArg(args, "background") {
				return nil
			}
			if a, ok := w.adviseTests(tool.StringArg(args, "command")); ok {
				return map[string]any{"testRun": a.Data()}
			}
			return nil
		},
		Run: func(ctx context.Context, tctx tool.Context, args tool.Args) tool.Result {
			command := strings.TrimSpace(tool.StringArg(args, "command"))
			if command == "" {
				return tool.Error("`command` is required")
			}
			if refused := w.screen(command); refused != nil {
				return *refused
			}
			if tool.BoolArg(args, "background") {
				return w.startBackground(ctx, command)
			}
			advice, isTest := w.adviseTests(command)
			timeout := CommandTimeout
			if s, ok := tool.IntArg(args, "timeoutSeconds"); ok && s > 0 {
				timeout = min(time.Duration(s)*time.Second, CommandCeiling)
			} else if isTest {
				// A suite this project measured past the default gets its own time, not a kill and a retry.
				timeout = advice.TimeoutFor(CommandTimeout, CommandCeiling)
			}
			trial := policy.IsLikelyPersistentCommand(command)
			if trial {
				timeout = min(timeout, persistentTrial)
			}
			print := ""
			if isTest && !trial {
				print = w.tests().Fingerprint(ctx)
				if !tool.BoolArg(args, "fresh") {
					if reused, ok := w.reusePass(command, advice, print); ok {
						return reused
					}
				}
			}
			// While it runs, the person can see what it is doing, stop it, or run it again (activity.go).
			watched := w.jobs.beginForeground(tctx.CallID, command, w.Root)
			started := time.Now()
			out := w.shell(ctx, command, timeout, watched)
			restarted := 0
			for ctx.Err() == nil && watched.again() {
				restarted++
				started = time.Now()
				out = w.shell(ctx, command, timeout, watched)
			}
			w.jobs.endForeground(watched)
			took := time.Since(started)
			personal := ""
			switch {
			case watched.stoppedByPerson():
				personal = "\n\n[Stopped by the person from the view of what it was doing. Do not run it again unless they ask.]"
				out.timedOut = false
			case restarted > 0:
				personal = "\n\n[Restarted by the person; this is the output of the run after the restart.]"
			}
			if out.timedOut && trial {
				return tool.Result{Content: fmt.Sprintf("'%s' was still running after %ds, so it was stopped: it is a long-running process, not a command that finishes. If the task needs it running, start it with background: true, read it with command_output and end it with stop_command.\n\nWhat it printed:\n%s", command, int(persistentTrial.Seconds()), out.combined()), IsError: true, Data: map[string]any{"command": command, "reason": "persistent_foreground_command"}}
			}
			body := out.combined()
			if body == "" {
				body = "(no output)"
			}
			if out.timedOut {
				body += fmt.Sprintf("\n\n[Command exceeded its %ds limit and was killed. Pass timeoutSeconds for a longer run.]", int(timeout.Seconds()))
			}
			body += personal
			data := map[string]any{"command": command, "exitCode": out.exit, "stdout": out.stdout, "stderr": out.stderr}
			result := tool.Result{Content: fmt.Sprintf("exit %d\n%s", out.exit, body), IsError: out.exit != 0, Data: data}
			// A run the person stopped is a cancel, like a cancelled turn: it says nothing of how long
			// the suite takes.
			if isTest && ctx.Err() == nil && !watched.stoppedByPerson() && out.missing == "" && out.exit != 127 {
				w.tests().Record(advice.Run, took, out.stdout+"\n"+out.stderr, out.timedOut)
				if out.exit != 0 {
					w.tests().Forget(reuseKey(command))
				}
				testRun := advice.Data()
				testRun["took"] = math.Round(took.Seconds()*10) / 10
				data["testRun"] = testRun
				if note := advice.Note(took.Seconds()); note != "" {
					result.Content += "\n\n" + note
				}
			}
			if out.missing != "" {
				result.Content += fmt.Sprintf("\n\n'%s' is not available in this environment. Do not retry this command; use another program, or check with 'command -v' first.", out.missing)
				data["missingProgram"] = out.missing
				return result
			}
			// Reading proves nothing: `cat tests/app.test.ts` mentions tests and runs none.
			var kind tool.EvidenceKind
			if !policy.IsReadOnlyCommand(command, runtime.GOOS) {
				kind = policy.ClassifyVerification(command)
				if kind == "" && policy.RunsWrittenScript(command, w.Written()) {
					kind = tool.EvidenceSmoke
				}
				if kind == "" && policy.RunsInlineAssertion(command) {
					kind = tool.EvidenceTests
				}
			}
			if kind == "" {
				return result
			}
			if out.exit == 0 {
				if why := policy.RejectedVerificationReason(command, out.stdout, out.stderr); why != "" {
					result.Content += "\n\nFriday did not accept this as verification: " + why
					data["verificationRejectedReason"] = why
					return result
				}
				result.Evidence = &tool.Evidence{Passed: true, Kind: kind, Summary: command + " exited 0"}
				if isTest && !out.timedOut {
					w.tests().Passed(reuseKey(command), print, result.Content, took)
				}
			}
			data["verificationKind"] = string(kind)
			return result
		},
	}
}

// tests is this project's test times.
func (w *Workspace) tests() *testtime.Estimator { return testtime.For(w.Root) }

// adviseTests is what is known of command as a test run; ok is false when it runs no tests.
func (w *Workspace) adviseTests(command string) (testtime.Advice, bool) {
	command = strings.TrimSpace(command)
	if command == "" || policy.IsReadOnlyCommand(command, runtime.GOOS) {
		return testtime.Advice{}, false
	}
	written := w.Written()
	files := make([]string, 0, len(written))
	for f := range written {
		files = append(files, f)
	}
	return w.tests().Advise(command, files)
}

// reuseKey is a command as reuse matches it: the same words, whatever the spacing.
func reuseKey(command string) string { return strings.Join(strings.Fields(command), " ") }

// reusePass answers a test run with its last pass when the work tree has not changed since: the
// same tests on the same files pass again, and waiting for them is time spent learning nothing.
func (w *Workspace) reusePass(command string, advice testtime.Advice, print string) (tool.Result, bool) {
	content, took, at, ok := w.tests().Reused(reuseKey(command), print)
	if !ok {
		return tool.Result{}, false
	}
	kind := policy.ClassifyVerification(command)
	if kind == "" {
		kind = tool.EvidenceTests
	}
	ago := time.Since(at).Round(time.Second)
	content += fmt.Sprintf("\n\n[Not run again: nothing in the work tree changed since this command passed %s ago (it took %s), so this is that run's result. Pass fresh: true to run it anyway.]", ago, testtime.Duration(took.Seconds()))
	testRun := advice.Data()
	testRun["reused"], testRun["took"], testRun["saved"] = true, 0.0, math.Round(took.Seconds()*10)/10
	return tool.Result{
		Content:  content,
		Data:     map[string]any{"command": command, "exitCode": 0, "reused": true, "testRun": testRun, "verificationKind": string(kind)},
		Evidence: &tool.Evidence{Passed: true, Kind: kind, Summary: command + " passed on this same tree"},
	}, true
}

// screen is the refusal for a command no mode may run, foreground or background: one a command
// rule forbids, or one that can destroy work irrecoverably. nil when it may run.
func (w *Workspace) screen(command string) *tool.Result {
	if v := policy.JudgeCommand(w.Rules, command); v != nil && v.Decision == "forbid" {
		return &tool.Result{Content: policy.ForbiddenMessage(command, *v), IsError: true, Data: map[string]any{"command": command, "reason": "command_rule"}}
	}
	if policy.IsRefusedCommand(command) {
		r := tool.Error(fmt.Sprintf("Refused: '%s' can destroy work irrecoverably. Ask the user to run it themselves if it is really intended.", command))
		r.Data = map[string]any{"command": command, "reason": "refused_command"}
		return &r
	}
	return nil
}

// shellCommand is command through the platform shell in dir, in its own process group, killed
// with that group when ctx ends.
func shellCommand(ctx context.Context, command, dir string) *exec.Cmd {
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.CommandContext(ctx, "cmd", "/C", command)
	} else {
		cmd = exec.CommandContext(ctx, "sh", "-c", command)
	}
	cmd.Dir = dir
	setProcessGroup(cmd)
	return cmd
}

type shellOutput struct {
	stdout, stderr string
	exit           int
	timedOut       bool
	missing        string
}

func (o shellOutput) combined() string {
	parts := []string{}
	for _, s := range []string{strings.TrimSpace(o.stdout), strings.TrimSpace(o.stderr)} {
		if s != "" {
			parts = append(parts, s)
		}
	}
	return strings.Join(parts, "\n")
}

// shell runs command through the platform shell in the root, killing it (and what it started)
// when the run is cancelled or the timeout passes.
//
// watched, when set, sees its output and pid as it runs, and may end it (the person's stop or restart).
func (w *Workspace) shell(ctx context.Context, command string, timeout time.Duration, watched *foreground) shellOutput {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	attempt, stop := context.WithCancel(ctx)
	defer stop()
	cmd := shellCommand(attempt, command, w.Root)
	var stdout, stderr bytes.Buffer
	var toOut, toErr io.Writer = &limited{buf: &stdout, max: outputMax}, &limited{buf: &stderr, max: outputMax}
	if watched != nil {
		toOut, toErr = io.MultiWriter(toOut, watched), io.MultiWriter(toErr, watched)
	}
	cmd.Stdout, cmd.Stderr = toOut, toErr
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Start()
	if err == nil {
		if watched != nil {
			watched.attempt(cmd.Process.Pid, stop)
		}
		err = cmd.Wait()
	}
	out := shellOutput{stdout: stdout.String(), stderr: stderr.String()}
	var exit *exec.ExitError
	switch {
	case errors.As(err, &exit):
		out.exit = exit.ExitCode()
		if out.exit == -1 {
			out.exit = 137
		}
	case err != nil:
		out.exit = 127
		out.stderr += err.Error()
	}
	if ctx.Err() == context.DeadlineExceeded {
		out.timedOut = true
	}
	if out.exit == 127 {
		out.missing = missingProgram(command, out.stderr)
	}
	return out
}

// missingProgram names the program a shell could not find, from its "not found" message.
func missingProgram(command, stderr string) string {
	if !strings.Contains(stderr, "not found") && !strings.Contains(stderr, "is not recognized") {
		return ""
	}
	fields := strings.Fields(command)
	for _, f := range fields {
		if !strings.Contains(f, "=") {
			if strings.Contains(stderr, f) {
				return f
			}
			break
		}
	}
	return ""
}

// limited keeps at most max bytes and drops the rest, so a runaway command cannot fill memory.
type limited struct {
	buf     *bytes.Buffer
	max     int
	dropped bool
}

func (l *limited) Write(p []byte) (int, error) {
	if room := l.max - l.buf.Len(); room > 0 {
		if len(p) > room {
			l.buf.Write(p[:room])
			l.buf.WriteString("\n[output cut here]")
			l.dropped = true
		} else {
			l.buf.Write(p)
		}
	}
	return len(p), nil
}
