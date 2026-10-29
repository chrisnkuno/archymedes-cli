package tools

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
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
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
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
			timeout := CommandTimeout
			if s, ok := tool.IntArg(args, "timeoutSeconds"); ok && s > 0 {
				timeout = min(time.Duration(s)*time.Second, CommandCeiling)
			}
			trial := policy.IsLikelyPersistentCommand(command)
			if trial {
				timeout = min(timeout, persistentTrial)
			}
			out := w.shell(ctx, command, timeout)
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
			data := map[string]any{"command": command, "exitCode": out.exit, "stdout": out.stdout, "stderr": out.stderr}
			result := tool.Result{Content: fmt.Sprintf("exit %d\n%s", out.exit, body), IsError: out.exit != 0, Data: data}
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
			}
			data["verificationKind"] = string(kind)
			return result
		},
	}
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
func (w *Workspace) shell(ctx context.Context, command string, timeout time.Duration) shellOutput {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := shellCommand(ctx, command, w.Root)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &limited{buf: &stdout, max: outputMax}
	cmd.Stderr = &limited{buf: &stderr, max: outputMax}
	cmd.WaitDelay = 2 * time.Second
	err := cmd.Run()
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
