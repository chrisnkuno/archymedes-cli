package thread

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"charm.land/fantasy"
)

func user(text string) fantasy.Message { return fantasy.NewUserMessage(text) }

func assistantCalls(text string, ids ...string) fantasy.Message {
	parts := []fantasy.MessagePart{fantasy.TextPart{Text: text}}
	for _, id := range ids {
		parts = append(parts, fantasy.ToolCallPart{ToolCallID: id, ToolName: "read_file", Input: `{"path":"a"}`})
	}
	return fantasy.Message{Role: fantasy.MessageRoleAssistant, Content: parts}
}

func results(ids ...string) fantasy.Message {
	var parts []fantasy.MessagePart
	for _, id := range ids {
		parts = append(parts, fantasy.ToolResultPart{ToolCallID: id, Output: fantasy.ToolResultOutputContentText{Text: "ok"}})
	}
	return fantasy.Message{Role: fantasy.MessageRoleTool, Content: parts}
}

func newStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	s, err := Create(root, Meta{ID: NewID(time.Now()), Cwd: root, Title: "x"})
	if err != nil {
		t.Fatal(err)
	}
	return s, root
}

func TestMessagesRoundTripWithToolParts(t *testing.T) {
	s, _ := newStore(t)
	conversation := []fantasy.Message{user("hi"), assistantCalls("", "c1"), results("c1"), {Role: fantasy.MessageRoleTool, Content: []fantasy.MessagePart{fantasy.ToolResultPart{ToolCallID: "c2", Output: fantasy.ToolResultOutputContentError{Error: errors.New("boom")}}}}}
	if err := s.SaveMessages(Root, conversation); err != nil {
		t.Fatal(err)
	}
	back, err := s.Messages(Root)
	if err != nil || len(back) != 4 {
		t.Fatalf("back = %d messages, %v", len(back), err)
	}
	call, ok := back[1].Content[1].(fantasy.ToolCallPart)
	if !ok || call.ToolCallID != "c1" || call.Input != `{"path":"a"}` {
		t.Fatalf("call = %#v", back[1].Content[1])
	}
	if _, ok := back[3].Content[0].(fantasy.ToolResultPart).Output.(fantasy.ToolResultOutputContentError); !ok {
		t.Fatal("an error result came back as something else")
	}
	none, err := s.Messages("t-unknown")
	if err != nil || none != nil {
		t.Fatal("a thread with no messages yet is an empty conversation")
	}
}

func TestTheLogReplaysSpawnsAndLatestStatus(t *testing.T) {
	s, _ := newStore(t)
	_ = s.Spawn(Thread{ID: "t-a", Parent: Root, Role: "explore", Brief: "find x", CallID: "call-1", Background: true})
	_ = s.Spawn(Thread{ID: "t-b", Parent: Root, Role: "review"})
	_ = s.SetStatus("t-a", Done, "found x at a.go:3")
	threads, err := s.Threads()
	if err != nil || len(threads) != 2 {
		t.Fatalf("threads = %+v, %v", threads, err)
	}
	if threads[0].Status != Done || threads[0].Report != "found x at a.go:3" || !threads[0].Background || threads[1].Status != Running {
		t.Fatalf("threads = %+v", threads)
	}
}

func TestATornLastLineIsSkipped(t *testing.T) {
	s, _ := newStore(t)
	_ = s.Spawn(Thread{ID: "t-a", Parent: Root})
	f, _ := os.OpenFile(filepath.Join(s.Dir(), "threads.jsonl"), os.O_APPEND|os.O_WRONLY, 0)
	_, _ = f.WriteString(`{"t":"status","id":"t-a","sta`)
	f.Close()
	threads, err := s.Threads()
	if err != nil || len(threads) != 1 || threads[0].Status != Running {
		t.Fatalf("threads = %+v, %v", threads, err)
	}
}

func TestChildrenRunningAtACrashAreFoundOnceOnLoad(t *testing.T) {
	s, root := newStore(t)
	_ = s.Spawn(Thread{ID: Root})
	_ = s.Spawn(Thread{ID: "t-a", Parent: Root})
	_ = s.Spawn(Thread{ID: "t-b", Parent: Root})
	_ = s.SetStatus("t-b", Done, "r")
	meta, _ := s.Meta()
	reopened, err := Open(root, meta.ID)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := reopened.Interrupted()
	if len(first) != 1 || first[0].ID != "t-a" || first[0].Status != Interrupted {
		t.Fatalf("interrupted = %+v", first)
	}
	if again, _ := reopened.Interrupted(); len(again) != 0 {
		t.Fatalf("found twice: %+v", again)
	}
}

func TestListAndLatest(t *testing.T) {
	root := t.TempDir()
	old, _ := Create(root, Meta{ID: "20260101T000000Z-aaaaaa", Title: "old"})
	time.Sleep(5 * time.Millisecond)
	_, _ = Create(root, Meta{ID: "20260102T000000Z-bbbbbb", Title: "new"})
	list := List(root, 0)
	if len(list) != 2 || list[0].Title != "new" {
		t.Fatalf("list = %+v", list)
	}
	time.Sleep(5 * time.Millisecond)
	meta, _ := old.Meta()
	_ = old.SaveMeta(meta) // touched: now the newest
	latest, err := Open(root, "latest")
	if err != nil || filepath.Base(latest.Dir()) != "20260101T000000Z-aaaaaa" {
		t.Fatalf("latest = %v, %v", latest, err)
	}
	if _, err := Open(root, "../../etc"); err == nil {
		t.Fatal("a path was accepted as a session id")
	}
}

func TestForkModes(t *testing.T) {
	parent := []fantasy.Message{
		user("first"), assistantCalls("looking", "c1"), results("c1"),
		user("second"), assistantCalls("answer two"),
		user("third"), assistantCalls("spawning", "c-spawn"), // mid-step: the spawn has no result yet
	}
	if Fork(parent, "none") != nil || Fork(parent, "") != nil {
		t.Fatal("none forks nothing")
	}
	full := Fork(parent, "full")
	for _, m := range full {
		for _, p := range m.Content {
			if c, ok := p.(fantasy.ToolCallPart); ok && c.ToolCallID == "c-spawn" {
				t.Fatal("the in-flight spawn call was forked without its result")
			}
		}
	}
	if len(full) != 7 { // the spawning message keeps its text
		t.Fatalf("full = %d messages", len(full))
	}
	last := Fork(parent, "last:2")
	if last[0].Content[0].(fantasy.TextPart).Text != "second" {
		t.Fatalf("last:2 starts at %+v", last[0])
	}
	if got := Fork(parent, "last:99"); len(got) != len(full) {
		t.Fatal("last:N past the start is the whole conversation")
	}
	for _, bad := range []string{"last:0", "last:x", "half"} {
		if _, err := ParseFork(bad); err == nil {
			t.Fatalf("ParseFork(%q) accepted", bad)
		}
	}
}

func TestTitle(t *testing.T) {
	if Title("  fix the login bug\nand more") != "fix the login bug" {
		t.Fatal("first line")
	}
	long := Title(string(make([]rune, 0)) + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if len([]rune(long)) != 60 {
		t.Fatalf("title = %q", long)
	}
}

func TestPausedChildrenAreResumedLikeInterruptedOnes(t *testing.T) {
	s, _ := newStore(t)
	_ = s.Spawn(Thread{ID: "t-p", Parent: Root})
	_ = s.SetStatus("t-p", Paused, "")
	_ = s.Spawn(Thread{ID: "t-c", Parent: Root})
	_ = s.SetStatus("t-c", Cancelled, "stopped by the person")
	got, _ := s.Interrupted()
	if len(got) != 1 || got[0].ID != "t-p" {
		t.Fatalf("interrupted = %+v", got)
	}
}
