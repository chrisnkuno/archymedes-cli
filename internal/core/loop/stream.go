package loop

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// stepResult is one model call: what it said, the calls it made, why it stopped, what it cost.
type stepResult struct {
	text      string
	reasoning string
	calls     []tool.Call
	finish    fantasy.FinishReason
	usage     Usage
}

// message is the call as an assistant message for the conversation.
func (s stepResult) message() fantasy.Message {
	var parts []fantasy.MessagePart
	if s.text != "" {
		parts = append(parts, fantasy.TextPart{Text: s.text})
	}
	for _, c := range s.calls {
		parts = append(parts, fantasy.ToolCallPart{ToolCallID: c.ID, ToolName: c.Name, Input: c.Raw})
	}
	if len(parts) == 0 {
		// Some providers refuse an empty assistant message; an empty text part stands for silence.
		parts = append(parts, fantasy.TextPart{Text: ""})
	}
	return fantasy.Message{Role: fantasy.MessageRoleAssistant, Content: parts}
}

func (r *run) attempts(err error) int {
	if r.req.MaxAttempts > 0 {
		return r.req.MaxAttempts
	}
	// A rate limit says when it will pass; waiting it out is the whole fix, so it gets more tries.
	if retryReason(err) == "rate_limit" {
		return RateLimitAttempts
	}
	return RetryAttempts
}

// Retry measures, documented in the user guide and the architecture.
const (
	RetryAttempts     = 4                // attempts for an outage or a network failure
	RateLimitAttempts = 8                // attempts for a rate limit, which passes by waiting
	MaxBackoff        = 20 * time.Second // the longest exponential backoff
	MaxWait           = 90 * time.Second // the longest single wait a provider's hint is followed for
	IdleTimeout       = 3 * time.Minute  // how long a stream may stay silent before it is cut
)

func (r *run) delay(attempt int, err error) time.Duration {
	if r.req.RetryDelay != nil {
		return r.req.RetryDelay(attempt)
	}
	d := time.Second << (attempt - 1)
	if d > MaxBackoff {
		d = MaxBackoff
	}
	// The provider's own word on when to come back beats any backoff: a per-minute token limit
	// (Groq: "try again in 11.3s") is not lifted by asking again after one second.
	if hint := retryHint(err); hint > d {
		d = min(hint+250*time.Millisecond, MaxWait)
	}
	return d
}

var tryAgainIn = regexp.MustCompile(`(?i)try again in\s+(?:(\d+)m)?([\d.]+)(ms|s)\b`)

// retryHint is when the provider said to retry: retry-after-ms, retry-after, or its message.
func retryHint(err error) time.Duration {
	var pe *fantasy.ProviderError
	if !errors.As(err, &pe) {
		return 0
	}
	if ms, perr := strconv.ParseFloat(pe.ResponseHeaders["retry-after-ms"], 64); perr == nil && ms > 0 {
		return time.Duration(ms * float64(time.Millisecond))
	}
	if secs, perr := strconv.ParseFloat(pe.ResponseHeaders["retry-after"], 64); perr == nil && secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	if m := tryAgainIn.FindStringSubmatch(pe.Message); m != nil {
		value, _ := strconv.ParseFloat(m[2], 64)
		minutes, _ := strconv.Atoi(m[1])
		unit := time.Second
		if strings.EqualFold(m[3], "ms") {
			unit = time.Millisecond
		}
		return time.Duration(minutes)*time.Minute + time.Duration(value*float64(unit))
	}
	return 0
}

// callModel streams one call, retrying what is worth retrying. A retry is only made before
// anything was streamed: text already shown to the person must not be said twice.
func (r *run) callModel(ctx context.Context, tools []*tool.Tool) (stepResult, error) {
	shrunk := false
	for attempt := 1; ; attempt++ {
		step, streamed, err := r.streamOnce(ctx, tools)
		if err == nil || ctx.Err() != nil || streamed {
			if err == nil {
				r.usage.Add(step.usage)
				usage := step.usage
				r.emit(Event{Type: EventModelTurn, Iteration: r.steps, Model: r.req.Model.Model(), ToolCallCount: len(step.calls), Usage: &usage})
			}
			return step, err
		}
		var pe *fantasy.ProviderError
		if errors.As(err, &pe) && pe.ContextTooLargeErr && !shrunk && r.req.Compact != nil {
			shrunk = true
			if shorter, cerr := r.req.Compact(ctx, r.messages); cerr == nil && len(shorter) > 0 {
				r.messages = shorter
				r.emit(Event{Type: "context_shrunk", Iteration: r.steps, Step: 2})
				attempt--
				continue
			}
		}
		if attempt >= r.attempts(err) || !retryable(err) {
			return step, err
		}
		wait := r.delay(attempt, err)
		r.emit(Event{Type: EventRetry, Iteration: r.steps, NextAttempt: attempt + 1, MaxAttempts: r.attempts(err), DelayMs: int(wait / time.Millisecond), Reason: retryReason(err)})
		select {
		case <-ctx.Done():
			return step, ctx.Err()
		case <-time.After(wait):
		}
	}
}

func retryable(err error) bool {
	var pe *fantasy.ProviderError
	if errors.As(err, &pe) {
		return pe.IsRetryable()
	}
	return fantasy.IsTransportError(err)
}

// retryReason names the failure the way the TypeScript runtime does (ProviderFailureKind), since
// the interface forecasts rate limits from "rate_limit".
func retryReason(err error) string {
	var pe *fantasy.ProviderError
	if errors.As(err, &pe) {
		switch {
		case pe.StatusCode == http.StatusTooManyRequests:
			return "rate_limit"
		case pe.StatusCode >= 500:
			return "server_error"
		case pe.StatusCode == http.StatusRequestTimeout:
			return "timeout"
		}
	}
	return "network"
}

// errSilent is a provider that stopped sending anything mid-reply.
var errSilent = &fantasy.ProviderError{Message: "the provider sent nothing for too long", TransientError: true}

func (r *run) idleLimit() time.Duration {
	if r.req.IdleTimeout > 0 {
		return r.req.IdleTimeout
	}
	return IdleTimeout
}

// streamOnce makes the call. streamed reports whether any text or tool call reached the person.
// A stream that goes silent past the idle limit (keepalives count as life) is cut and reported as
// a transient failure, so a hung connection is retried instead of holding the turn forever.
func (r *run) streamOnce(parent context.Context, tools []*tool.Tool) (step stepResult, streamed bool, err error) {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	var silent atomic.Bool
	watchdog := time.AfterFunc(r.idleLimit(), func() { silent.Store(true); cancel() })
	defer watchdog.Stop()
	defer func() {
		if silent.Load() && parent.Err() == nil {
			err = errSilent
		}
	}()
	call := fantasy.Call{Prompt: r.prompt(), Tools: functionTools(tools), ProviderOptions: r.req.ProviderOptions}
	if r.budgets.MaxOutputTokens > 0 {
		max := r.budgets.MaxOutputTokens
		call.MaxOutputTokens = &max
	}
	if len(tools) > 0 {
		auto := fantasy.ToolChoiceAuto
		call.ToolChoice = &auto
	}
	stream, err := r.req.Model.Stream(ctx, call)
	if err != nil {
		return step, false, err
	}
	compose := newComposer(r)
	for part := range stream {
		watchdog.Reset(r.idleLimit())
		switch part.Type {
		case fantasy.StreamPartTypeTextDelta:
			if part.Delta != "" {
				streamed = true
				step.text += part.Delta
				r.emit(Event{Type: EventDelta, Iteration: r.steps, Text: part.Delta})
			}
		case fantasy.StreamPartTypeReasoningDelta:
			step.reasoning += part.Delta
		case fantasy.StreamPartTypeToolInputStart:
			compose.start(part.ID, part.ToolCallName)
		case fantasy.StreamPartTypeToolInputDelta:
			compose.delta(part.ID, part.Delta)
		case fantasy.StreamPartTypeToolCall:
			streamed = true
			args, perr := tool.ParseArgs(part.ToolCallInput)
			c := tool.Call{ID: part.ID, Name: part.ToolCallName, Args: args, Raw: part.ToolCallInput}
			if perr != nil {
				c.Args = nil // decoded again in runTools, where the model is told what was wrong
			}
			if c.Raw == "" {
				c.Raw = "{}"
			}
			step.calls = append(step.calls, c)
		case fantasy.StreamPartTypeFinish:
			step.finish = part.FinishReason
			step.usage = Usage{
				InputTokens:       int(part.Usage.InputTokens),
				OutputTokens:      int(part.Usage.OutputTokens),
				CachedInputTokens: int(part.Usage.CacheReadTokens),
				ReasoningTokens:   int(part.Usage.ReasoningTokens),
			}
		case fantasy.StreamPartTypeError:
			if part.Error != nil {
				return step, streamed, part.Error
			}
		}
	}
	if ctx.Err() != nil {
		return step, streamed, ctx.Err()
	}
	return step, streamed, nil
}

// prompt is the system message and the conversation.
func (r *run) prompt() fantasy.Prompt {
	prompt := make(fantasy.Prompt, 0, len(r.messages)+1)
	if r.req.System != "" {
		prompt = append(prompt, fantasy.NewSystemMessage(r.req.System))
	}
	return append(prompt, r.messages...)
}

func functionTools(tools []*tool.Tool) []fantasy.Tool {
	out := make([]fantasy.Tool, 0, len(tools))
	for _, t := range tools {
		schema := t.Schema
		if schema == nil {
			schema = tool.ObjectSchema(map[string]any{})
		}
		out = append(out, fantasy.FunctionTool{Name: t.Name, Description: t.Description, InputSchema: schema})
	}
	return out
}

// composer says which call the model is writing, throttled, so the interface can show
// "writing src/app.ts…" instead of "thinking…" while a long edit streams in.
type composer struct {
	r     *run
	calls map[string]*composing
	order int
}

type composing struct {
	index   int
	name    string
	input   string
	subject string
	sent    time.Time
}

const composeEvery = 400 * time.Millisecond

var subjectField = regexp.MustCompile(`"(?:path|command|file_path|pattern)"\s*:\s*"((?:[^"\\]|\\.)*)"`)

func newComposer(r *run) *composer { return &composer{r: r, calls: map[string]*composing{}} }

func (c *composer) start(id, name string) {
	c.calls[id] = &composing{index: c.order, name: name}
	c.order++
	c.send(c.calls[id], true)
}

func (c *composer) delta(id, text string) {
	call := c.calls[id]
	if call == nil {
		return
	}
	call.input += text
	changed := false
	if call.subject == "" {
		if m := subjectField.FindStringSubmatch(call.input); m != nil {
			call.subject, changed = m[1], true
		}
	}
	c.send(call, changed)
}

func (c *composer) send(call *composing, force bool) {
	now := time.Now()
	if !force && now.Sub(call.sent) < composeEvery {
		return
	}
	call.sent = now
	c.r.emit(Event{Type: EventCompose, Iteration: c.r.steps, Index: call.index, ToolName: call.name, Subject: call.subject, Chars: len(call.input)})
}
