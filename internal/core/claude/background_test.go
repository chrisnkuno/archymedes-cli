package claude

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

func launchResult(path string) string {
	return "Async agent launched successfully.\nagentId: a4d8e8a8f2fa34db8 (internal ID - do not mention to user.)\n" +
		"The agent is working in the background.\noutput_file: " + path + "\nDo NOT Read or tail this file"
}

func TestLaunchOfReadsTheTranscriptPath(t *testing.T) {
	l, ok := launchOf("call-1", map[string]any{"subagent_type": "Explore", "description": "audit"}, launchResult("/tmp/x/a.output"))
	if !ok || l.path != "/tmp/x/a.output" || l.id != "a4d8e8a8f2fa34db8" || l.role != "Explore" || l.brief != "audit" || l.call != "call-1" {
		t.Fatalf("launch = %+v, %v", l, ok)
	}
	if _, ok := launchOf("c", nil, "Done: found 3 files."); ok {
		t.Fatal("a plain result is not a launch")
	}
	if _, ok := launchOf("c", nil, "output_file: relative/path"); ok {
		t.Fatal("a relative path is not followed")
	}
}

func TestTranslatorStartsFollowingABackgroundAgent(t *testing.T) {
	tr := newTranslator("/repo")
	tr.begin()
	tr.feed(json.RawMessage(`{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"call-1","name":"Agent","input":{"description":"audit","prompt":"look","subagent_type":"Explore","run_in_background":true}}]}}`))
	result, _ := json.Marshal(launchResult("/tmp/x/a.output"))
	out := tr.feed(json.RawMessage(`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"call-1","content":` + string(result) + `}]}}`))
	if len(out) != 2 || out[0].Event.Content != launchedNote || strings.Contains(out[0].Event.Content, "agentId") {
		t.Fatalf("result = %+v", out)
	}
	if th := out[1].Thread; th == nil || th.Status != thread.Running || !th.Background || th.ParentToolCallID != "call-1" {
		t.Fatalf("thread = %+v", out[1])
	}
	if len(tr.launched) != 1 || tr.launched[0].path != "/tmp/x/a.output" {
		t.Fatalf("launched = %+v", tr.launched)
	}
}

// Lines as Claude Code writes them to a background sub-agent's transcript (fields trimmed).
var transcriptLines = []string{
	`{"isSidechain":true,"type":"user","message":{"role":"user","content":"look around"}}`,
	`{"type":"api-request","agentId":"a"}`,
	`{"isSidechain":true,"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hm"}],"stop_reason":"tool_use"}}`,
	`{"isSidechain":true,"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Grep","input":{"pattern":"x"}}],"stop_reason":"tool_use"}}`,
	`{"isSidechain":true,"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"a.go:3: x"}]}}`,
	`{"isSidechain":true,"type":"assistant","requestId":"r2","message":{"content":[{"type":"text","text":"Looking."}],"stop_reason":"tool_use"}}`,
	`{"isSidechain":true,"type":"assistant","requestId":"r3","message":{"model":"claude-haiku","content":[{"type":"thinking","thinking":""}],"stop_reason":"end_turn","usage":{"input_tokens":2,"cache_read_input_tokens":100,"output_tokens":40}}}`,
	`{"isSidechain":true,"type":"assistant","requestId":"r3","message":{"model":"claude-haiku","content":[{"type":"text","text":"Found x at a.go:3."}],"stop_reason":"end_turn","usage":{"input_tokens":2,"cache_read_input_tokens":100,"output_tokens":40}}}`,
}

func TestTranscriptBecomesTheCardsEvents(t *testing.T) {
	r := newTranscript(launch{call: "call-1", id: "a", role: "Explore"}, "/repo")
	var out []agents.Notice
	for _, line := range transcriptLines {
		out = append(out, r.feed([]byte(line))...)
	}
	out = append(out, r.finish()...)
	var kinds []string
	for _, n := range out {
		if n.Event != nil {
			kinds = append(kinds, n.Event.Type)
		} else {
			kinds = append(kinds, n.Kind)
		}
	}
	// One model_turn for r3 though both its lines carry its usage.
	if strings.Join(kinds, " ") != "tool_call tool_result assistant_delta model_turn assistant_delta thread" {
		t.Fatalf("notices = %v", kinds)
	}
	if out[0].Kind != "subagent" || out[0].ParentToolCallID != "call-1" || out[0].Event.ToolCallID != "t1" || out[1].Event.Content != "a.go:3: x" {
		t.Fatalf("steps = %+v %+v", out[0], out[1])
	}
	if out[2].Event.Text != "Looking." || out[4].Event.Text != "Found x at a.go:3." || out[2].Event.Iteration == out[4].Event.Iteration {
		t.Fatalf("words = %+v / %+v", out[2].Event, out[4].Event)
	}
	if u := out[3].Event.Usage; u == nil || u.InputTokens != 102 || u.OutputTokens != 40 || out[3].Event.Model != "claude-haiku" {
		t.Fatalf("usage = %+v", out[3].Event)
	}
	if th := out[5].Thread; th == nil || th.Status != thread.Done || th.Report != "Found x at a.go:3." {
		t.Fatalf("end = %+v", out[5])
	}
}

func TestFollowReadsTheTranscriptAsItGrows(t *testing.T) {
	old := followPoll
	followPoll = 5 * time.Millisecond
	defer func() { followPoll = old }()

	path := filepath.Join(t.TempDir(), "agent.jsonl")
	var mu sync.Mutex
	var got []agents.Notice
	s := &Session{opts: Options{Root: "/repo", Notify: func(n agents.Notice) { mu.Lock(); got = append(got, n); mu.Unlock() }}}
	s.startFollowing([]launch{{call: "call-1", id: "a", role: "Explore", path: path}})

	f, err := os.Create(path) // written after the follower started, half a line at a time
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	for _, line := range transcriptLines {
		half := len(line) / 2
		f.WriteString(line[:half])
		time.Sleep(10 * time.Millisecond)
		f.WriteString(line[half:] + "\n")
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(got)
		mu.Unlock()
		s.mu.Lock()
		following := len(s.followers)
		s.mu.Unlock()
		if n == 6 && following == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("got %d notices, %d still following", n, following)
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got[5].Thread == nil || got[5].Thread.Status != thread.Done {
		t.Fatalf("last = %+v", got[5])
	}
}

func TestClaudesTaskNewsIsTakenBetweenTurnsToo(t *testing.T) {
	tr := newTranslator("/repo") // no turn running: ended
	tr.feed(json.RawMessage(`{"type":"system","subtype":"task_started","task_id":"task-9","tool_use_id":"call-1","description":"audit","is_backgrounded":true}`))
	tr.feed(json.RawMessage(`{"type":"system","subtype":"task_notification","task_id":"task-9","tool_use_id":"call-1","status":"stopped","summary":"Read two files."}`))
	if tr.tasks["call-1"] != "task-9" {
		t.Fatalf("tasks = %v", tr.tasks)
	}
	if len(tr.taskEnds) != 1 || tr.taskEnds[0] != (taskEnd{call: "call-1", task: "task-9", status: "stopped", summary: "Read two files."}) {
		t.Fatalf("ends = %+v", tr.taskEnds)
	}
}

// waitUntil polls until ok, or fails after two seconds.
func waitUntil(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out waiting: " + what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestClaudeSayingATaskStoppedEndsItsCardAsCancelled(t *testing.T) {
	old := followPoll
	followPoll = 5 * time.Millisecond
	defer func() { followPoll = old }()
	path := filepath.Join(t.TempDir(), "agent.jsonl")
	os.WriteFile(path, []byte(strings.Join(transcriptLines[:5], "\n")+"\n"), 0o644) // mid-work: no final words
	var mu sync.Mutex
	var got []agents.Notice
	s := &Session{tr: newTranslator("/repo"), opts: Options{Root: "/repo", Notify: func(n agents.Notice) { mu.Lock(); got = append(got, n); mu.Unlock() }}}
	s.startFollowing([]launch{{call: "call-1", id: "a", role: "Explore", path: path}})
	waitUntil(t, "its two steps", func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == 2 })
	s.taskEnded([]taskEnd{{call: "call-1", task: "a", status: "stopped", summary: "Read one file."}})
	waitUntil(t, "its end", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.followers) == 0 })
	mu.Lock()
	defer mu.Unlock()
	end := got[len(got)-1].Thread
	if end == nil || end.Status != thread.Cancelled || end.Report != "Stopped before it finished." {
		t.Fatalf("end = %+v", end)
	}
}

func TestStopAgentStopsClaudesTaskAsItsPanelDoes(t *testing.T) {
	f := newFake(t)
	s, err := Open(context.Background(), f.options(policy.Build))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	path := filepath.Join(t.TempDir(), "agent.jsonl")
	s.mu.Lock()
	s.tr.tasks = map[string]string{"call-1": "task-9"}
	s.mu.Unlock()
	s.startFollowing([]launch{{call: "call-1", id: "a4d8", role: "Explore", path: path}})

	for _, id := range []string{"call-1", "a4d8", "task-9"} { // any name it is known by
		if text, err := s.StopAgent(id); err != nil || !strings.Contains(text, "Stopping a4d8") {
			t.Fatalf("StopAgent(%s) = %q, %v", id, text, err)
		}
	}
	if log := f.logged(); strings.Count(log, `control stop_task`) != 3 || !strings.Contains(log, `"task_id":"task-9"`) {
		t.Fatalf("Claude Code was not asked to stop task-9:\n%s", log)
	}
	if _, err := s.StopAgent("nobody"); err == nil {
		t.Fatal("an unknown sub-agent is an error")
	}
	if _, err := s.SendAgent("call-1", "also check mul.go"); err == nil || !strings.Contains(err.Error(), "SendMessage") {
		t.Fatalf("a message for Claude's own sub-agent says why not: %v", err)
	}
}

func TestAFinishedTaskWaitsForItsLastWordsBeforeItsCardEnds(t *testing.T) {
	old := followPoll
	followPoll = 5 * time.Millisecond
	defer func() { followPoll = old }()
	path := filepath.Join(t.TempDir(), "agent.jsonl")
	os.WriteFile(path, []byte(strings.Join(transcriptLines[:6], "\n")+"\n"), 0o644) // up to "Looking." (a tool_use request)
	var mu sync.Mutex
	var got []agents.Notice
	s := &Session{tr: newTranslator("/repo"), opts: Options{Root: "/repo", Notify: func(n agents.Notice) { mu.Lock(); got = append(got, n); mu.Unlock() }}}
	s.startFollowing([]launch{{call: "call-1", id: "a", role: "Explore", path: path}})
	waitUntil(t, "what is written", func() bool { mu.Lock(); defer mu.Unlock(); return len(got) == 3 })

	// Claude Code says it completed a moment before its final answer reaches the transcript.
	s.taskEnded([]taskEnd{{call: "call-1", task: "a", status: "completed", summary: `Agent "audit" finished`}})
	time.Sleep(30 * time.Millisecond)
	f, _ := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	f.WriteString(strings.Join(transcriptLines[6:], "\n") + "\n")
	f.Close()
	waitUntil(t, "its end", func() bool { s.mu.Lock(); defer s.mu.Unlock(); return len(s.followers) == 0 })
	mu.Lock()
	defer mu.Unlock()
	var ends []*agents.ThreadInfo
	for _, n := range got {
		if n.Thread != nil {
			ends = append(ends, n.Thread)
		}
	}
	if len(ends) != 1 || ends[0].Status != thread.Done || ends[0].Report != "Found x at a.go:3." {
		t.Fatalf("one end, with its final answer as the report: %+v", ends)
	}
}
