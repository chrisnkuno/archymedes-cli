package claude

import (
	"runtime"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Which of Claude Code's permission questions Friday answers itself, so Claude in a mode behaves as
// Friday's own models do in it:
//
//   - tools that change nothing never ask, in any mode (Friday's read_file, grep_files, web_search
//     and web_fetch change nothing either);
//   - the person's command rules speak first: forbid refuses with the rule's reason, allow runs
//     (except in defender mode, which looks at every change), ask always asks;
//   - a read-only command (`git status`, `rg`, `ls`) never asks;
//   - auto mode runs a command without asking when Friday's safety screen finds nothing sensitive.
//     Edits are already Claude Code's own acceptEdits. A command leaving Claude Code's sandbox
//     always asks.

// verdict is what the screen decided: allow, deny (with why), or ask the person.
type verdict int

const (
	ask verdict = iota
	allow
	deny
)

// readOnlyTools are Claude Code's tools with no effect beyond reading the project or the web.
var readOnlyTools = map[string]bool{"Read": true, "Glob": true, "Grep": true, "LS": true, "NotebookRead": true, "WebSearch": true,
	"WebFetch": true, "TodoWrite": true, "BashOutput": true, "ToolSearch": true}

// runCommand is Friday's run_command as the safety screen reads it: a workspace effect, judged by its command.
var runCommand = &tool.Tool{Name: "run_command", Effect: tool.EffectWorkspace}

func screen(name string, input map[string]any, mode policy.Mode, rules []policy.CommandRule) (verdict, string) {
	if readOnlyTools[name] {
		return allow, ""
	}
	command, ok := input["command"].(string)
	if name != "Bash" || !ok {
		return ask, ""
	}
	ruled := policy.JudgeCommand(rules, command)
	switch {
	case ruled != nil && ruled.Decision == policy.RuleForbid:
		return deny, policy.ForbiddenMessage(command, *ruled)
	case ruled != nil && ruled.Decision == policy.RuleAllow && mode != policy.Defender:
		return allow, ""
	case ruled != nil && ruled.Decision == policy.RuleAsk, input["dangerouslyDisableSandbox"] == true:
		return ask, ""
	case policy.IsReadOnlyCommand(command, runtime.GOOS):
		return allow, ""
	case mode == policy.Auto && !policy.AssessToolSafety(tool.Call{Name: "run_command", Args: tool.Args{"command": command}}, runCommand).Sensitive:
		return allow, ""
	}
	return ask, ""
}
