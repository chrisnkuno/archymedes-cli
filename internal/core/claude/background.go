package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

// Sub-agents Claude Code runs in the background (Agent with run_in_background). Their call returns
// at once with where the sub-agent writes its transcript (output_file), and none of its work comes
// on the stream Friday reads. So the file is followed as it grows: its tool calls and results go
// out as the sub-agent events of the Agent call's card, its start and end as thread events, and its
// last words are the card's report, exactly as a background sub-agent on Friday's own engine.

// launchedNote replaces the launch result's text, which is written for Claude, not the person.
const launchedNote = "Working in the background; its steps show on this card as it goes."

// followPoll is how often a followed transcript is checked for more; followIdle is how long it may
// stay unchanged before the sub-agent is taken as gone (stopped, or Claude Code exited).
var (
	followPoll = 300 * time.Millisecond
	followIdle = 30 * time.Minute
	// endGrace is how long a sub-agent's last words are waited for after Claude Code says it
	// completed: its transcript can be written a moment after.
	endGrace = 5 * time.Second
)

var (
	outputFileRe = regexp.MustCompile(`output_file:\s*(\S+)`)
	agentIDRe    = regexp.MustCompile(`agentId:\s*([A-Za-z0-9_-]+)`)
)

// launch is one background sub-agent Claude Code started.
type launch struct {
	call, id, role, brief, path string
}

// launchOf reads a background launch from an Agent call's result, if it was one.
func launchOf(callID string, input map[string]any, content string) (launch, bool) {
	file := outputFileRe.FindStringSubmatch(content)
	if file == nil || !filepath.IsAbs(file[1]) {
		return launch{}, false
	}
	l := launch{call: callID, path: file[1], id: callID}
	if id := agentIDRe.FindStringSubmatch(content); id != nil {
		l.id = id[1]
	}
	l.role, _ = input["subagent_type"].(string)
	if l.role == "" {
		l.role = "general"
	}
	l.brief, _ = input["description"].(string)
	if l.brief == "" {
		l.brief, _ = input["prompt"].(string)
	}
	return l, true
}

func (l launch) thread(status, report string) agents.Notice {
	return agents.Notice{Kind: "thread", Thread: &agents.ThreadInfo{
		ID: l.id, ParentToolCallID: l.call, Agent: l.role, Status: status,
		Background: true, Brief: l.brief, Report: report, Model: "claude",
	}}
}

// transcript turns a background sub-agent's transcript lines into its card's events. Pure.
type transcript struct {
	l    launch
	root string
	open map[string]string // tool call id → name as shown
	// Claude Code writes each block of a message as a line of its own, all with the message's
	// stop_reason: the words of one request are gathered, and the end is taken once no more follow.
	request  string
	requests int      // model requests so far: the iteration its words are said in
	last     []string // the latest request's words
	ending   bool     // a request ended its turn with no tool call
	done     bool
}

func newTranscript(l launch, root string) *transcript {
	return &transcript{l: l, root: root, open: map[string]string{}}
}

func (r *transcript) feed(raw []byte) []agents.Notice {
	var line struct {
		Type      string `json:"type"`
		RequestID string `json:"requestId"`
		Message   struct {
			Model      string          `json:"model"`
			Content    json.RawMessage `json:"content"`
			StopReason string          `json:"stop_reason"`
			Usage      *apiUsage       `json:"usage"`
		} `json:"message"`
	}
	if json.Unmarshal(raw, &line) != nil || r.done {
		return nil
	}
	var blocks []contentBlock
	if json.Unmarshal(line.Message.Content, &blocks) != nil {
		return nil // the brief itself, a string
	}
	var out []agents.Notice
	switch line.Type {
	case "assistant":
		if line.RequestID == "" || line.RequestID != r.request {
			// A new request: every line of it repeats its usage, so it is counted here, once.
			r.request, r.last = line.RequestID, nil
			r.requests++
			if u := line.Message.Usage; u != nil {
				counted := u.usage()
				out = append(out, r.event(loop.Event{Type: loop.EventModelTurn, Iteration: r.requests, Model: firstNonEmpty(line.Message.Model, "claude"), Usage: &counted}))
			}
		}
		calls := false
		for _, block := range blocks {
			switch {
			case block.Type == "text" && strings.TrimSpace(block.Text) != "":
				r.last = append(r.last, strings.TrimSpace(block.Text))
				out = append(out, r.event(loop.Event{Type: loop.EventDelta, Iteration: r.requests, Text: block.Text}))
			case block.Type == "tool_use" && block.ID != "":
				calls = true
				if _, seen := r.open[block.ID]; seen {
					continue
				}
				name, args := Describe(block.Name, object(block.Input), r.root)
				r.open[block.ID] = name
				out = append(out, r.event(loop.Event{Type: loop.EventToolCall, ToolCallID: block.ID, ToolName: name, Effect: effectOf(block.Name), Arguments: args}))
			}
		}
		r.ending = line.Message.StopReason == "end_turn" && !calls
	case "user":
		r.ending = false
		for _, block := range blocks {
			name, ok := r.open[block.ToolUseID]
			if block.Type != "tool_result" || !ok {
				continue
			}
			delete(r.open, block.ToolUseID)
			content := clip(resultText(block.Content), MaxResultChars)
			out = append(out, r.event(loop.Event{Type: loop.EventToolResult, ToolCallID: block.ToolUseID, ToolName: name, IsError: block.IsError, Effect: "none", Content: content}))
		}
	}
	return out
}

// report is its latest words.
func (r *transcript) report() string { return strings.Join(r.last, "\n\n") }

// finish ends it, if its last request ended its turn: called when no more lines follow.
func (r *transcript) finish() []agents.Notice {
	if !r.ending || r.done {
		return nil
	}
	r.done = true
	return []agents.Notice{r.l.thread(thread.Done, firstNonEmpty(r.report(), "(The sub-agent ended without a report.)"))}
}

func (r *transcript) event(ev loop.Event) agents.Notice {
	return agents.Notice{Kind: "subagent", ParentToolCallID: r.l.call, Agent: r.l.role, Event: &ev}
}

// taskEnd is Claude Code's own word that a task ended (task_notification on its stream).
type taskEnd struct {
	call, task, status, summary string
}

// endStatus is a task_notification status as a thread's.
func endStatus(status string) string {
	switch status {
	case "failed":
		return thread.Failed
	case "stopped", "killed", "cancelled":
		return thread.Cancelled
	}
	return thread.Done
}

// follower is one background sub-agent followed: what it is, what stops the following, and where
// Claude Code's word that it ended is handed over.
type follower struct {
	l      launch
	cancel context.CancelFunc
	end    chan taskEnd
}

// follow reads a background sub-agent's transcript until it ends (its transcript's last words, or
// Claude Code saying so), the session closes, or it goes quiet for followIdle.
func (s *Session) follow(ctx context.Context, fl *follower) {
	l := fl.l
	r := newTranscript(l, s.opts.Root)
	var (
		f       *os.File
		reader  *bufio.Reader
		partial []byte
		quiet   = time.Now()
	)
	defer func() {
		if f != nil {
			f.Close()
		}
	}()
	read := func() {
		if f == nil {
			if opened, err := os.Open(l.path); err == nil {
				f, reader = opened, bufio.NewReader(opened)
			}
		}
		for reader != nil {
			chunk, err := reader.ReadBytes('\n')
			if len(chunk) > 0 {
				quiet = time.Now()
			}
			partial = append(partial, chunk...)
			if err != nil {
				break // io.EOF: the rest of the line is not written yet
			}
			s.emit(r.feed(partial))
			partial = partial[:0]
		}
	}
	// ended is Claude Code's word that it ended, once given; by is how long its last words are
	// waited for after it.
	var (
		ended *taskEnd
		by    time.Time
	)
	endNow := func(e *taskEnd) bool {
		if endStatus(e.status) == thread.Done && !r.ending && !time.Now().After(by) {
			return false // its final words are not written yet
		}
		// Claude Code's summary on its stream is mostly the task's own title: its words come first.
		status, said, summary := endStatus(e.status), r.report(), strings.TrimSpace(e.summary)
		var report string
		switch {
		case status == thread.Cancelled && said != "":
			report = "Stopped before it finished. Its last words:\n\n" + said
		case status == thread.Cancelled:
			report = "Stopped before it finished."
		default:
			report = firstNonEmpty(said, summary)
		}
		r.done = true
		s.emit([]agents.Notice{l.thread(status, firstNonEmpty(report, "(The sub-agent ended without a report.)"))})
		return true
	}
	tick := time.NewTicker(followPoll)
	defer tick.Stop()
	for {
		read()
		if len(partial) == 0 {
			if end := r.finish(); end != nil {
				s.emit(end)
				return
			}
		}
		if ended != nil && endNow(ended) {
			return
		}
		if time.Since(quiet) > followIdle {
			s.emit([]agents.Notice{l.thread(thread.Failed, firstNonEmpty(r.report(), "The sub-agent stopped reporting before it finished."))})
			return
		}
		select {
		case <-ctx.Done():
			return
		case e := <-fl.end:
			// Claude Code says it ended. Its transcript can lag that word by a moment, so its last
			// words are waited for (endGrace) before the card ends on what is there.
			ended, by = &e, time.Now().Add(endGrace)
			continue // read again now, not at the next tick
		case <-tick.C:
		}
	}
}

// startFollowing follows each background sub-agent the stream just launched.
func (s *Session) startFollowing(launched []launch) {
	if len(launched) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return
	}
	if s.followers == nil {
		s.followers = map[string]*follower{}
	}
	for _, l := range launched {
		if _, on := s.followers[l.call]; on {
			continue
		}
		ctx, cancel := context.WithCancel(context.Background())
		fl := &follower{l: l, cancel: cancel, end: make(chan taskEnd, 1)}
		s.followers[l.call] = fl
		go func() {
			defer func() {
				cancel()
				s.mu.Lock()
				delete(s.followers, l.call)
				s.mu.Unlock()
			}()
			s.follow(ctx, fl)
		}()
	}
}

// taskEnded hands Claude Code's word that tasks ended to their followers.
func (s *Session) taskEnded(ends []taskEnd) {
	if len(ends) == 0 {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, e := range ends {
		if fl, ok := s.followers[e.call]; ok {
			select {
			case fl.end <- e:
			default: // already told
			}
		}
	}
}

// followed is the background sub-agent known by id: its thread id, its task id, or its call id.
// Called with s.mu held.
func (s *Session) followed(id string) *follower {
	for _, fl := range s.followers {
		if task := s.tr.tasks[fl.l.call]; id == fl.l.call || id == fl.l.id || (task != "" && id == task) {
			return fl
		}
	}
	return nil
}
