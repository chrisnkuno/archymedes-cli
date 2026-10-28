package loop

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Model is the one thing the loop needs of a language model; fantasy.LanguageModel has it.
type Model interface {
	Stream(ctx context.Context, call fantasy.Call) (fantasy.StreamResponse, error)
	Model() string
}

// Budgets bound one run. The defaults are the TypeScript agent's (DEFAULT_ARCHYMEDES_BUDGETS).
type Budgets struct {
	MaxSteps            int
	MaxToolCalls        int
	MaxToolCallsPerStep int
	MaxResultChars      int
	// MaxStepResultChars caps one step's tool results together, so a step never sends the model
	// more than compaction keeps verbatim. Zero derives it from the window (StepResultCharsFor).
	MaxStepResultChars int
	MaxOutputTokens    int64
	// ContextLimit is the model's window; past CompactAt of it, the conversation is compacted.
	ContextLimit int
	CompactAt    float64
}

// The flow measures that keep tool running smooth on every provider: sizes are kept in characters
// and compared to the window in tokens through CharsPerToken, a rough stand-in for a real
// tokenizer (never for billing). CompactionKeepDivisor is the fraction of the window compaction
// keeps word for word; a step's results are held to half of that, so the model always sees in
// full the results of the step it just caused.
const (
	CharsPerToken         = 4
	CompactionKeepDivisor = 4
)

// StepResultCharsFor is the most characters of tool results one step may send the model for a
// given window: half of what compaction keeps verbatim (ContextLimit/2 characters), so a step's
// fresh results fit with margin at any window. The flow invariant, held by TestConformFlowBudgets.
func StepResultCharsFor(contextLimit int) int {
	return contextLimit * CharsPerToken / (2 * CompactionKeepDivisor)
}

// DefaultBudgets are a top-level session's.
func DefaultBudgets() Budgets {
	return Budgets{MaxSteps: 100, MaxToolCalls: 500, MaxToolCallsPerStep: 16, MaxResultChars: 40_000, MaxStepResultChars: StepResultCharsFor(128_000), MaxOutputTokens: 16_384, ContextLimit: 128_000, CompactAt: 0.8}
}

// Approver decides whether an effectful call runs; err is for a decision that could not be made
// (the run was cancelled while the person was being asked).
type Approver func(ctx context.Context, call tool.Call, t *tool.Tool) (bool, error)

// Request is everything one run needs.
type Request struct {
	ThreadID string
	Root     string
	Model    Model
	System   string
	// History is the conversation so far; Prompt, when set, is appended as the person's message.
	History []fantasy.Message
	Prompt  string
	// Files are attached to the prompt (images the person sent with it).
	Files []fantasy.FilePart
	Tools *tool.Catalog
	// Approve is asked about every call that changes something. Nil approves only calls that change nothing.
	Approve Approver
	// Gate, when set, holds the run until workspace changes are verified.
	Gate  *gate.Gate
	Inbox *Inbox
	// Budgets; zero fields take the defaults.
	Budgets Budgets
	// Emit receives every event, in order, from the run's goroutine (and tool goroutines for none).
	Emit func(Event)
	// Checkpoint is called after every step, with the conversation structurally complete.
	Checkpoint func([]fantasy.Message)
	// Compact replaces the conversation with a shorter one when it nears the context limit.
	Compact func(ctx context.Context, messages []fantasy.Message) ([]fantasy.Message, error)
	// ResultStore, when set, persists a tool result too large to keep inline and returns a short
	// reference (a path under the project) the model can re-read with read_file. The model keeps a
	// preview plus the reference instead of losing the middle. Nil falls back to plain truncation.
	ResultStore func(callID, content string) string
	ProviderOptions fantasy.ProviderOptions
	// WrapUp, when set, is said to the model once the budget is spent, for one last call with no
	// tools: a sub-agent's report is worth more than its silence.
	WrapUp string
	// MaxAttempts per model call (default 4) and the delay before attempt n (default 1s, 2s, 4s…).
	MaxAttempts int
	RetryDelay  func(attempt int) time.Duration
	// IdleTimeout is how long a stream may send nothing before it is cut (default 3 minutes).
	IdleTimeout time.Duration
	// Hooks, when set, run the person's hooks around each call and before the run ends.
	Hooks Hooks
}

// Hooks are the person's commands at a run's moments (internal/core/hooks implements them).
type Hooks interface {
	// BeforeTool is asked before a call (and before its approval); a reason stops it.
	BeforeTool(ctx context.Context, call tool.Call, t *tool.Tool) string
	// AfterTool is told the result; what it answers is added to the result for the model.
	AfterTool(ctx context.Context, call tool.Call, t *tool.Tool, result tool.Result) string
	// BeforeStop is asked when the model is done; a reason keeps the run going with it. again is
	// true when the run already went on because of an earlier answer.
	BeforeStop(ctx context.Context, again bool) string
}

// maxHookStops is how many times a Stop hook may keep one run going.
const maxHookStops = 3

// Result is how a run ended and what it left behind.
type Result struct {
	Status Status
	// Text is the model's last words: the answer, or a sub-agent's report.
	Text     string
	Messages []fantasy.Message
	Usage    Usage
	Steps    int
	Calls    int
	// Unread is steering the run accepted and ended before reading.
	Unread []string
	Err    error
}

type run struct {
	req      Request
	budgets  Budgets
	messages []fantasy.Message
	// hookStops is how many times a Stop hook kept this run going.
	hookStops int
	usage     Usage
	steps     int
	calls     int
	detector  *Detector
	text      string
	stuck     string
	emitMu    sync.Mutex
}

// Run performs one run to its end.
func Run(ctx context.Context, req Request) Result {
	r := &run{req: req, budgets: withDefaults(req.Budgets), detector: NewDetector()}
	r.messages = append([]fantasy.Message(nil), req.History...)
	if strings.TrimSpace(req.Prompt) != "" {
		r.messages = append(r.messages, fantasy.NewUserMessage(req.Prompt, req.Files...))
		// Saved before the first call: a request is never lost to a crash, and a sub-agent forked
		// during this turn's first step sees what it was asked.
		r.checkpoint()
	}
	if req.Inbox != nil {
		req.Inbox.Open()
	}
	status, err := r.loop(ctx)
	if status == BudgetExhausted && req.WrapUp != "" && ctx.Err() == nil {
		r.wrapUp(ctx)
	}
	result := Result{Status: status, Text: r.text, Messages: r.messages, Usage: r.usage, Steps: r.steps, Calls: r.calls, Err: err}
	if req.Inbox != nil {
		result.Unread = req.Inbox.Close()
	}
	summary := r.text
	switch {
	case status == Stuck:
		summary = r.stuck
	case err != nil:
		summary = err.Error()
	case status == BudgetExhausted && summary == "":
		summary = fmt.Sprintf("Stopped after %d steps and %d tool calls: the run's budget is spent.", r.steps, r.calls)
	}
	r.emit(Event{Type: EventStop, Status: string(status), Summary: summary})
	return result
}

func withDefaults(b Budgets) Budgets {
	d := DefaultBudgets()
	if b.MaxSteps > 0 {
		d.MaxSteps = b.MaxSteps
	}
	if b.MaxToolCalls > 0 {
		d.MaxToolCalls = b.MaxToolCalls
	}
	if b.MaxToolCallsPerStep > 0 {
		d.MaxToolCallsPerStep = b.MaxToolCallsPerStep
	}
	if b.MaxResultChars > 0 {
		d.MaxResultChars = b.MaxResultChars
	}
	if b.MaxOutputTokens > 0 {
		d.MaxOutputTokens = b.MaxOutputTokens
	}
	if b.ContextLimit > 0 {
		d.ContextLimit = b.ContextLimit
	}
	if b.CompactAt > 0 {
		d.CompactAt = b.CompactAt
	}
	// The per-step result budget tracks the resolved window unless it was set by hand, so the flow
	// invariant holds even when ARCHYMEDES_CONTEXT_LIMIT makes the window small or large.
	if b.MaxStepResultChars > 0 {
		d.MaxStepResultChars = b.MaxStepResultChars
	} else {
		d.MaxStepResultChars = StepResultCharsFor(d.ContextLimit)
	}
	// Reserve output headroom: a reply begun with the prompt at the compaction trip point must
	// still fit under the window, so the model is never cut off by its own context. On the default
	// window this leaves 16,384 unchanged (25,600 reserved); on a small window it scales the reply
	// down to what fits. The flow invariant, held by TestConformFlowBudgetsFitTheWindow.
	if reserve := OutputHeadroom(d.ContextLimit, d.CompactAt); d.MaxOutputTokens > reserve {
		d.MaxOutputTokens = reserve
	}
	return d
}

// OutputHeadroom is the room left under the window once the prompt is at the compaction trip
// point: the most a reply may be so it cannot overrun the window. (1 - CompactAt) of the window.
func OutputHeadroom(contextLimit int, compactAt float64) int64 {
	return int64(float64(contextLimit) * (1 - compactAt))
}

// continueAfterLength is what the model is told when its reply was cut off by the output limit.
const continueAfterLength = "Your reply was cut off by the output limit. Continue exactly where you stopped; do not repeat what you already wrote."

func (r *run) loop(ctx context.Context) (Status, error) {
	lengthContinues := 0
	for {
		if ctx.Err() != nil {
			return Cancelled, nil
		}
		r.foldInbox()
		if r.steps >= r.budgets.MaxSteps || r.calls >= r.budgets.MaxToolCalls {
			return BudgetExhausted, nil
		}
		r.maybeCompactBeforeCall(ctx)
		r.steps++
		step, err := r.callModel(ctx, r.req.Tools.Visible())
		if err != nil {
			if ctx.Err() != nil {
				r.keepPartial(step)
				return Cancelled, nil
			}
			return Failed, err
		}
		r.messages = append(r.messages, step.message())
		if step.text != "" {
			r.text = step.text
		}
		if len(step.calls) == 0 {
			if step.finish == fantasy.FinishReasonLength && lengthContinues < 2 {
				lengthContinues++
				r.messages = append(r.messages, fantasy.NewUserMessage(continueAfterLength))
				continue
			}
			lengthContinues = 0
			if r.req.Inbox != nil && r.req.Inbox.Pending() {
				continue // the person said more while the model was finishing: answer that too
			}
			if r.req.Gate != nil {
				if nudge := r.req.Gate.BeforeFinish(); nudge != "" {
					r.messages = append(r.messages, fantasy.NewUserMessage(nudge))
					continue
				}
			}
			if r.req.Hooks != nil && r.hookStops < maxHookStops {
				if why := r.req.Hooks.BeforeStop(ctx, r.hookStops > 0); why != "" {
					r.hookStops++
					r.messages = append(r.messages, fantasy.NewUserMessage("A hook asks you to continue before finishing: "+why))
					continue
				}
			}
			r.checkpoint()
			return Completed, nil
		}
		lengthContinues = 0
		r.messages = append(r.messages, r.runTools(ctx, step.calls))
		r.checkpoint()
		if r.req.Gate != nil {
			if state := r.req.Gate.TakeState(); state != nil {
				r.emit(Event{Type: EventTestFirst, State: state})
			}
		}
		if r.stuck != "" {
			return Stuck, nil
		}
		if ctx.Err() != nil {
			return Cancelled, nil
		}
		r.maybeCompact(ctx, step.usage)
	}
}

// foldInbox turns what arrived since the last step into the person's messages.
func (r *run) foldInbox() {
	if r.req.Inbox == nil {
		return
	}
	waiting := r.req.Inbox.Drain()
	if len(waiting) == 0 {
		return
	}
	for _, text := range waiting {
		r.messages = append(r.messages, fantasy.NewUserMessage(text))
	}
	r.emit(Event{Type: EventSteered, Iteration: r.steps + 1, Count: len(waiting)})
}

func (r *run) checkpoint() {
	if r.req.Checkpoint != nil {
		r.req.Checkpoint(append([]fantasy.Message(nil), r.messages...))
	}
}

// keepPartial keeps what a cancelled call had already said, so the transcript shows it.
func (r *run) keepPartial(step stepResult) {
	if step.text != "" {
		r.text = step.text
		r.messages = append(r.messages, fantasy.Message{Role: fantasy.MessageRoleAssistant, Content: []fantasy.MessagePart{fantasy.TextPart{Text: step.text}}})
	}
}

// wrapUp asks for a report with no tools after the budget ran out.
func (r *run) wrapUp(ctx context.Context) {
	r.messages = append(r.messages, fantasy.NewUserMessage(r.req.WrapUp))
	step, err := r.callModel(ctx, nil)
	if err == nil {
		r.messages = append(r.messages, step.message())
		if step.text != "" {
			r.text = step.text
		}
		r.checkpoint()
	}
}

// compactThreshold is the token count past which the conversation is compacted; zero when
// compaction is off or no window is known.
func (r *run) compactThreshold() float64 {
	if r.req.Compact == nil || r.budgets.ContextLimit <= 0 {
		return 0
	}
	return r.budgets.CompactAt * float64(r.budgets.ContextLimit)
}

// maybeCompactBeforeCall compacts when the conversation is estimated to be over the threshold
// before a call goes out, so the first oversized turn is trimmed rather than sent whole and slow.
// The estimate is character-based and runs every iteration, so it is cheap; the real usage after
// a call is the backstop below.
func (r *run) maybeCompactBeforeCall(ctx context.Context) {
	limit := r.compactThreshold()
	if limit <= 0 {
		return
	}
	est := estimatePromptTokens(r.messages)
	if float64(est) < limit {
		return
	}
	r.compactNow(ctx, est)
}

// maybeCompact compacts after a call when the provider's own token count crossed the threshold.
func (r *run) maybeCompact(ctx context.Context, last Usage) {
	limit := r.compactThreshold()
	if limit <= 0 {
		return
	}
	if float64(last.InputTokens+last.OutputTokens) < limit {
		return
	}
	r.compactNow(ctx, last.InputTokens+last.OutputTokens)
}

func (r *run) compactNow(ctx context.Context, tokensBefore int) {
	before := len(r.messages)
	shorter, err := r.req.Compact(ctx, r.messages)
	if err != nil || len(shorter) == 0 || len(shorter) >= before {
		return // a compaction that failed leaves the conversation as it was; the provider will say if it is too long
	}
	r.messages = shorter
	r.emit(Event{Type: EventCompaction, TokensBefore: tokensBefore, MessagesBefore: before, MessagesAfter: len(shorter)})
	r.checkpoint()
}

// estimatePromptTokens is a rough character-based size of the whole conversation, enough to
// decide whether to compact before a call rather than only after one.
func estimatePromptTokens(messages []fantasy.Message) int {
	total := 0
	for _, m := range messages {
		total += EstimateTokens(m)
	}
	return total
}

// EstimateTokens is a rough character-based token count for one message (~4 characters a token,
// plus a little for the message's own framing). It is a cheap stand-in for a real tokenizer, used
// to decide how much conversation to keep and when to compact, never for billing.
func EstimateTokens(m fantasy.Message) int {
	chars := 0
	for _, part := range m.Content {
		switch p := part.(type) {
		case fantasy.TextPart:
			chars += len(p.Text)
		case fantasy.ReasoningPart:
			chars += len(p.Text)
		case fantasy.ToolCallPart:
			chars += len(p.ToolName) + len(p.Input)
		case fantasy.ToolResultPart:
			switch o := p.Output.(type) {
			case fantasy.ToolResultOutputContentText:
				chars += len(o.Text)
			case fantasy.ToolResultOutputContentError:
				if o.Error != nil {
					chars += len(o.Error.Error())
				}
			case fantasy.ToolResultOutputContentMedia:
				chars += len(o.Text) + len(o.Data)
			}
		}
	}
	return chars/4 + 4
}

func (r *run) emit(ev Event) {
	if r.req.Emit == nil {
		return
	}
	r.emitMu.Lock()
	defer r.emitMu.Unlock()
	r.req.Emit(ev)
}

// errorText is a tool failure as the model reads it.
func errorText(err error) string {
	var pe *fantasy.ProviderError
	if errors.As(err, &pe) && pe.Message != "" {
		return pe.Message
	}
	return err.Error()
}
