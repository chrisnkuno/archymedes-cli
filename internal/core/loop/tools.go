package loop

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"unicode/utf8"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// outcome is one call's result as the conversation records it.
type outcome struct {
	call   tool.Call
	result tool.Result
}

// prepared is a call whose tool and arguments are known, or which already failed.
type prepared struct {
	call   tool.Call
	tool   *tool.Tool
	effect tool.Effect
	failed *tool.Result
}

// runTools runs one step's calls and returns them as a tool message, in the order they were made.
//
// Calls that change nothing and are safe to run together are batched: consecutive such calls run
// at once (several reads, several searches, several read-only sub-agents), and the step waits for
// the batch. Anything else runs on its own, in order, after the person approved it. One bad call
// never voids the batch: it gets an error result the model can act on, and the others still run.
func (r *run) runTools(ctx context.Context, calls []tool.Call) fantasy.Message {
	prepared := make([]prepared, len(calls))
	for i, c := range calls {
		prepared[i] = r.prepare(c, i)
	}
	outcomes := make([]outcome, len(calls))
	for i := 0; i < len(prepared); {
		j := i
		for j < len(prepared) && batchable(prepared[j]) {
			j++
		}
		if j > i+1 {
			r.runBatch(ctx, prepared[i:j], outcomes[i:j])
			i = j
			continue
		}
		outcomes[i] = r.runOne(ctx, prepared[i])
		i++
	}
	parts := make([]fantasy.MessagePart, len(outcomes))
	for i, o := range outcomes {
		parts[i] = resultPart(o)
	}
	return fantasy.Message{Role: fantasy.MessageRoleTool, Content: parts}
}

func batchable(p prepared) bool {
	return p.failed == nil && p.tool.ParallelSafe && p.effect == tool.EffectNone
}

func (r *run) prepare(c tool.Call, index int) prepared {
	p := prepared{call: c}
	fail := func(text string) prepared {
		res := tool.Error(text)
		p.failed = &res
		return p
	}
	if index >= r.budgets.MaxToolCallsPerStep {
		return fail(fmt.Sprintf("Not run: at most %d tool calls run in one step. Make this call again in your next step if you still need it.", r.budgets.MaxToolCallsPerStep))
	}
	if c.Args == nil {
		args, err := tool.ParseArgs(c.Raw)
		if err != nil {
			return fail(fmt.Sprintf("The arguments to %s are not a JSON object (%v). Call it again with valid JSON arguments.", c.Name, err))
		}
		p.call.Args = args
	}
	t, ok := r.req.Tools.Lookup(c.Name)
	if !ok {
		// A name that is ours under another spelling or namespace (repo_browser.run_command) is run
		// as ours rather than refused: the model meant it, and a refusal costs a step.
		if ours, found := tool.Resolve(r.req.Tools, c.Name); found {
			p.call.Name = ours
			t, ok = r.req.Tools.Lookup(ours)
		}
	}
	if !ok {
		return fail(fmt.Sprintf("There is no tool named %q. Available: %s.", c.Name, strings.Join(visibleNames(r.req.Tools), ", ")))
	}
	// A deferred tool called by its exact name is as good as found.
	r.req.Tools.Load(p.call.Name)
	p.tool = t
	p.effect = t.CallEffect(p.call.Args)
	return p
}

func visibleNames(c *tool.Catalog) []string {
	var names []string
	for _, t := range c.Visible() {
		names = append(names, t.Name)
	}
	sort.Strings(names)
	return names
}

func (r *run) runBatch(ctx context.Context, batch []prepared, out []outcome) {
	for _, p := range batch {
		r.announce(p)
	}
	var wg sync.WaitGroup
	results := make([]tool.Result, len(batch))
	for i, p := range batch {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results[i] = r.execute(ctx, p)
		}()
	}
	wg.Wait()
	for i, p := range batch {
		out[i] = r.finish(p, results[i])
	}
}

func (r *run) runOne(ctx context.Context, p prepared) outcome {
	if p.failed != nil {
		r.calls++
		r.emit(Event{Type: EventToolCall, ToolCallID: p.call.ID, ToolName: p.call.Name, Effect: string(tool.EffectNone), Arguments: p.call.Args})
		return r.finish(p, *p.failed)
	}
	r.announce(p)
	if p.effect != tool.EffectNone {
		approved, err := r.approve(ctx, p)
		if err != nil || !approved {
			text := "The person declined this call. Do not retry it as it is; ask, or do something else."
			if err != nil {
				text = "Not run: " + err.Error()
			}
			return r.finish(p, tool.Result{Content: text, IsError: true, Data: map[string]any{"declined": true}})
		}
	}
	return r.finish(p, r.execute(ctx, p))
}

// announce tells the interface a call is about to run (before any approval, so the card the
// approval belongs to is already on screen).
func (r *run) announce(p prepared) {
	r.calls++
	r.emit(Event{Type: EventToolCall, ToolCallID: p.call.ID, ToolName: p.call.Name, Effect: string(p.effect), Arguments: p.call.Args})
}

func (r *run) approve(ctx context.Context, p prepared) (bool, error) {
	if r.req.Approve == nil {
		return false, errors.New("this run cannot ask for approval, and the call changes something")
	}
	return r.req.Approve(ctx, p.call, p.tool)
}

func (r *run) execute(ctx context.Context, p prepared) (result tool.Result) {
	defer func() {
		if v := recover(); v != nil {
			result = tool.Error(fmt.Sprintf("%s failed inside Friday: %v", p.call.Name, v))
		}
	}()
	if ctx.Err() != nil {
		return tool.Error("Not run: the turn was stopped.")
	}
	return p.tool.Run(ctx, tool.Context{CallID: p.call.ID, ThreadID: r.req.ThreadID, Root: r.req.Root}, p.call.Args)
}

// finish records a result with the gate and the detector, bounds it, and tells the interface.
func (r *run) finish(p prepared, result tool.Result) outcome {
	var notes []string
	if r.req.Gate != nil && p.tool != nil {
		if note := r.req.Gate.Record(gate.Record{ToolName: p.call.Name, Args: p.call.Args, Effect: p.effect, IsError: result.IsError, Evidence: result.Evidence, Data: result.Data}); note != "" {
			notes = append(notes, note)
		}
	}
	if !result.IsError && p.effect == tool.EffectWorkspace {
		r.detector.Changed()
	}
	if p.failed == nil {
		verdict := r.detector.Observe(p.call.Name, p.call.Args)
		if verdict.Stop {
			r.stuck = verdict.Note
		} else if verdict.Note != "" {
			notes = append(notes, verdict.Note)
		}
	}
	result.Content = truncate(result.Content, r.budgets.MaxResultChars)
	if len(notes) > 0 {
		result.Content += "\n\n" + strings.Join(notes, "\n")
	}
	r.emit(Event{Type: EventToolResult, ToolCallID: p.call.ID, ToolName: p.call.Name, Effect: string(p.effect), IsError: result.IsError, Content: result.Content, Data: result.Data})
	return outcome{call: p.call, result: result}
}

// truncate keeps the head and the tail of a long result: an error is usually at the end of a
// build log, and what was being built at its start.
func truncate(text string, max int) string {
	if max <= 0 || len(text) <= max {
		return text
	}
	head := max * 2 / 3
	start := len(text) - (max - head)
	// Cut on character boundaries: half a multi-byte character is invalid UTF-8 in every
	// event and request that carries it.
	for head > 0 && !utf8.RuneStart(text[head]) {
		head--
	}
	for start < len(text) && !utf8.RuneStart(text[start]) {
		start++
	}
	left := utf8.RuneCountInString(text[head:start])
	return text[:head] + fmt.Sprintf("\n\n[… %d characters left out …]\n\n", left) + text[start:]
}

func resultPart(o outcome) fantasy.MessagePart {
	var output fantasy.ToolResultOutputContent = fantasy.ToolResultOutputContentText{Text: o.result.Content}
	if o.result.IsError {
		output = fantasy.ToolResultOutputContentError{Error: errors.New(o.result.Content)}
	}
	return fantasy.ToolResultPart{ToolCallID: o.call.ID, Output: output}
}
