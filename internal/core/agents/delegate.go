package agents

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/roles"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// How long wait_agents waits for reports, unless told, and at most.
const (
	WaitDefault = 10 * time.Minute
	WaitCeiling = 30 * time.Minute
)

// delegationTools are the root's tools for sub-agents. None of them is ever given to a child:
// depth is one.
func (s *Session) delegationTools(mode policy.Mode) []*tool.Tool {
	var out []*tool.Tool
	if t := s.delegateTool(true); t != nil {
		out = append(out, t)
	}
	if mode != policy.Plan {
		if t := s.delegateTool(false); t != nil {
			out = append(out, t)
		}
	}
	return append(out, s.waitTool(), s.sendTool(), s.closeTool())
}

func (s *Session) rolesFor(readOnly bool) []roles.Profile {
	var out []roles.Profile
	for _, p := range s.profiles {
		if p.ReadOnly == readOnly {
			out = append(out, p)
		}
	}
	return out
}

func (s *Session) delegateTool(readOnly bool) *tool.Tool {
	profiles := s.rolesFor(readOnly)
	if len(profiles) == 0 {
		return nil
	}
	var names, described []string
	for _, p := range profiles {
		names = append(names, p.Name)
		if p.Source == "built-in" {
			described = append(described, p.Name)
		} else {
			described = append(described, fmt.Sprintf("%s (%s)", p.Name, p.Description))
		}
	}
	name, fallback := "delegate_task", roles.DefaultWritableRole
	description := "Sub-agent with your tools and mode; returns its report, or runs in the background. Roles: " + strings.Join(described, ", ") + "."
	if readOnly {
		name, fallback = "delegate_readonly_task", roles.DefaultReadOnlyRole
		description = "Read-only sub-agent; several in one turn run at once. Roles: " + strings.Join(described, ", ") + "."
	}
	return &tool.Tool{
		Name: name, Description: description,
		Schema: tool.ObjectSchema(map[string]any{
			"task":       map[string]any{"type": "string", "description": "Self-contained brief"},
			"agent":      map[string]any{"type": "string", "enum": names, "description": "Role (default " + fallback + ")"},
			"background": map[string]any{"type": "boolean", "description": "Return at once and keep working; collect the report with wait_agents."},
			"fork":       map[string]any{"type": "string", "description": "What it starts from: none (default, the brief only), full (this conversation), last:N (the last N turns)."},
		}, "task"),
		Capability: tool.CapPlanning, Effect: tool.EffectNone,
		// A read-only sub-agent cannot write or ask, so several run at once; a writable one may ask.
		ParallelSafe: readOnly,
		Run: func(ctx context.Context, tc tool.Context, args tool.Args) tool.Result {
			return s.delegate(ctx, tc, args, readOnly, fallback)
		},
	}
}

func (s *Session) delegate(ctx context.Context, tc tool.Context, args tool.Args, readOnly bool, fallback string) tool.Result {
	brief := strings.TrimSpace(tool.StringArg(args, "task"))
	if brief == "" {
		return tool.Error("`task` is required: a self-contained brief (goal, area, what you know, what to report)")
	}
	roleName := strings.TrimSpace(tool.StringArg(args, "agent"))
	if roleName == "" {
		roleName = fallback
	}
	profile, ok := s.profile(roleName)
	if !ok || profile.ReadOnly != readOnly {
		var names []string
		for _, p := range s.rolesFor(readOnly) {
			names = append(names, p.Name)
		}
		return tool.Error(fmt.Sprintf("No %s role %q. Roles here: %s.", map[bool]string{true: "read-only", false: "writable"}[readOnly], roleName, strings.Join(names, ", ")))
	}
	fork, err := thread.ParseFork(tool.StringArg(args, "fork"))
	if err != nil {
		return tool.Error(err.Error())
	}
	background := profile.Background
	if v, ok := args["background"].(bool); ok {
		background = v
	}
	if background && !readOnly && !s.inGitRepo() {
		background = false // a writable background sub-agent needs a worktree of its own
	}
	c, err := s.startChild(ctx, spawnSpec{profile: profile, brief: brief, fork: fork, background: background, callID: tc.CallID})
	if err != nil {
		return tool.Error("The sub-agent could not start: " + err.Error())
	}
	if background {
		where := ""
		if c.t.Branch != "" {
			where = fmt.Sprintf(" It works on branch %s in its own worktree, so your edits and its edits cannot collide.", c.t.Branch)
		}
		return tool.Result{
			Content: fmt.Sprintf("Started %s sub-agent %s in the background.%s Carry on; its report arrives as a message when it finishes, or collect it with wait_agents.", profile.Name, c.t.ID, where),
			Data:    map[string]any{"thread": c.t.ID, "background": true},
		}
	}
	select {
	case <-c.done:
	case <-ctx.Done():
		c.stop()
		<-c.done
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.collected = true
	return tool.Result{Content: c.report, Data: map[string]any{"thread": c.t.ID, "status": string(c.result.Status)}}
}

func (s *Session) waitTool() *tool.Tool {
	return &tool.Tool{
		Name:        "wait_agents",
		Description: "Wait for background sub-agents and collect their reports. Without ids: every background sub-agent whose report you have not read.",
		Schema: tool.ObjectSchema(map[string]any{
			"ids":            map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"timeoutSeconds": map[string]any{"type": "integer", "description": "Default 600, max 1800."},
		}),
		Capability: tool.CapPlanning, Effect: tool.EffectNone,
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			targets, err := s.waitTargets(args)
			if err != nil {
				return tool.Error(err.Error())
			}
			if len(targets) == 0 {
				return tool.Text("No background sub-agent has a report you have not read.")
			}
			timeout := WaitDefault
			if n, ok := tool.IntArg(args, "timeoutSeconds"); ok && n > 0 {
				timeout = min(time.Duration(n)*time.Second, WaitCeiling)
			}
			still := waitFor(ctx, targets, timeout)
			var parts []string
			for _, c := range targets {
				if slices.Contains(still, c) {
					parts = append(parts, fmt.Sprintf("## %s (%s): still running", c.t.ID, c.profile.Name))
					continue
				}
				// A background report waits in the inbox until read. Withdrawn here, it is given
				// now; already gone, it reached this conversation as a message, so not twice.
				delivered := c.t.Background && !s.inbox.Retract(c.t.ID)
				c.mu.Lock()
				c.collected = true
				if delivered {
					parts = append(parts, fmt.Sprintf("## %s (%s): %s; its report is already above, in the message that said it finished.", c.t.ID, c.profile.Name, c.result.Status))
				} else {
					parts = append(parts, fmt.Sprintf("## %s (%s): %s\n%s", c.t.ID, c.profile.Name, c.result.Status, c.report))
				}
				c.mu.Unlock()
			}
			return tool.Result{Content: strings.Join(parts, "\n\n"), Data: map[string]any{"running": len(still)}}
		},
	}
}

func (s *Session) waitTargets(args tool.Args) ([]*child, error) {
	if list, ok := args["ids"].([]any); ok && len(list) > 0 {
		var out []*child
		for _, v := range list {
			id, _ := v.(string)
			c, ok := s.lookupChild(id)
			if !ok {
				return nil, fmt.Errorf("no sub-agent %q in this session", id)
			}
			out = append(out, c)
		}
		return out, nil
	}
	s.childMu.Lock()
	defer s.childMu.Unlock()
	var out []*child
	for _, c := range s.children {
		c.mu.Lock()
		if c.t.Background && !c.collected {
			out = append(out, c)
		}
		c.mu.Unlock()
	}
	slices.SortFunc(out, func(a, b *child) int { return a.t.CreatedAt.Compare(b.t.CreatedAt) })
	return out, nil
}

func (s *Session) sendTool() *tool.Tool {
	return &tool.Tool{
		Name:        "send_agent",
		Description: "Send a sub-agent a message: steers it while it runs, or re-opens a finished one with a follow-up (it keeps its conversation).",
		Schema: tool.ObjectSchema(map[string]any{
			"id":      map[string]any{"type": "string"},
			"message": map[string]any{"type": "string"},
		}, "id", "message"),
		Capability: tool.CapPlanning, Effect: tool.EffectNone,
		Run: func(ctx context.Context, tc tool.Context, args tool.Args) tool.Result {
			id, message := tool.StringArg(args, "id"), strings.TrimSpace(tool.StringArg(args, "message"))
			if message == "" {
				return tool.Error("`message` is required")
			}
			c, ok := s.lookupChild(id)
			if !ok {
				t, stored := s.store.Thread(id)
				if !stored || t.ID == thread.Root {
					return tool.Error(fmt.Sprintf("No sub-agent %q in this session", id))
				}
				profile, ok := s.profile(t.Role)
				if !ok {
					return tool.Error("Its role " + t.Role + " no longer exists")
				}
				c = &child{t: t, profile: profile, done: closedChan()}
			}
			if !c.finished() {
				if c.inbox.Steer(message) {
					return tool.Text(fmt.Sprintf("Sent to %s; it reads it at its next step.", id))
				}
				return tool.Error(fmt.Sprintf("%s is between steps; send again in a moment.", id))
			}
			return s.reopen(ctx, tc, c, message)
		},
	}
}

func closedChan() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}

// reopen continues a finished child with a follow-up, in the same mode it ran in before.
func (s *Session) reopen(ctx context.Context, tc tool.Context, old *child, message string) tool.Result {
	history, err := s.store.Messages(old.t.ID)
	if err != nil {
		return tool.Error("Its conversation could not be read: " + err.Error())
	}
	t := old.t
	t.CallID = tc.CallID
	_ = s.store.SetStatus(t.ID, thread.Running, "")
	ws := s.ws
	if t.Worktree != "" {
		ws = s.ws.At(t.Worktree)
	}
	c := s.launch(ctx, t, old.profile, ws, thread.Complete(history), message)
	if t.Background {
		return tool.Result{Content: fmt.Sprintf("Re-opened %s in the background with your message.", t.ID), Data: map[string]any{"thread": t.ID}}
	}
	<-c.done
	c.mu.Lock()
	defer c.mu.Unlock()
	c.collected = true
	return tool.Result{Content: c.report, Data: map[string]any{"thread": t.ID}}
}

func (s *Session) closeTool() *tool.Tool {
	return &tool.Tool{
		Name:        "close_agent",
		Description: "Stop a running sub-agent; what it found so far is kept as its report.",
		Schema:      tool.ObjectSchema(map[string]any{"id": map[string]any{"type": "string"}}, "id"),
		Capability:  tool.CapPlanning, Effect: tool.EffectNone,
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			c, ok := s.lookupChild(tool.StringArg(args, "id"))
			if !ok {
				return tool.Error("No such sub-agent")
			}
			if c.finished() {
				return tool.Text(c.t.ID + " had already finished.")
			}
			c.stop()
			<-c.done
			return tool.Text("Stopped " + c.t.ID + ".")
		},
	}
}
