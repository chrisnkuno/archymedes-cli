package claude

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/agents"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

func TestAHelperRunsOnAClaudeCodeOfItsOwnAndReportsToTheNextTurn(t *testing.T) {
	f := newFake(t)
	s, err := Open(context.Background(), f.options(policy.Build))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	h, err := s.StartHelper(Role{Name: "explore", ReadOnly: true, Instructions: "Map, do not fix."}, "run the build and say what breaks")
	if err != nil || !strings.HasPrefix(h.CallID, agents.UserCallPrefix) {
		t.Fatalf("helper %+v, %v", h, err)
	}
	var ended *agents.ThreadInfo
	deadline := time.Now().Add(10 * time.Second)
	for ended == nil && time.Now().Before(deadline) {
		f.mu.Lock()
		for _, n := range f.notices {
			if n.Kind == "thread" && n.Thread.Status != thread.Running {
				ended = n.Thread
			}
		}
		f.mu.Unlock()
		time.Sleep(20 * time.Millisecond)
	}
	if ended == nil || ended.Status != thread.Done || ended.Report != "Done." || ended.ParentToolCallID != h.CallID || ended.Brief != "run the build and say what breaks" {
		t.Fatalf("its end: %+v", ended)
	}
	f.mu.Lock()
	var kinds []string
	for _, n := range f.notices {
		if n.Kind == "subagent" && n.ParentToolCallID == h.CallID && n.Agent == "explore" {
			kinds = append(kinds, n.Event.Type)
		}
		if n.Kind == "runtime" {
			t.Errorf("a helper's events go under its card, not into the conversation: %s", n.Event.Type)
		}
	}
	f.mu.Unlock()
	if strings.Join(kinds, " ") != "tool_call model_turn tool_result model_turn" {
		t.Fatalf("its card's events: %v", kinds)
	}
	log := f.logged()
	for _, want := range []string{"--permission-mode plan", "You are Friday's explore helper", "Map, do not fix.", "Your task:\\nrun the build and say what breaks"} {
		if !strings.Contains(log, want) {
			t.Errorf("log lacks %q:\n%s", want, log)
		}
	}
	if turn := s.Turn(context.Background(), "and now?"); !strings.Contains(f.logged(), "[Background helper "+h.ID+" (explore) finished: done]\\nDone.\\n\\nand now?") {
		t.Fatalf("the next prompt carries its report: %+v\n%s", turn, f.logged())
	}
}

func TestHelpersAreBoundedAndStopWithTheSession(t *testing.T) {
	f := newFake(t)
	s, err := Open(context.Background(), f.options(policy.Build))
	if err != nil {
		t.Fatal(err)
	}
	for range MaxHelpers {
		if _, err := s.StartHelper(Role{Name: "explore", ReadOnly: true}, "wait for it"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.StartHelper(Role{Name: "explore", ReadOnly: true}, "one more"); err == nil || !strings.Contains(err.Error(), "already at work") {
		t.Fatalf("a fifth at once: %v", err)
	}
	s.Close()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		left := len(s.helpers)
		s.mu.Unlock()
		if left == 0 {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("closing the session stops its helpers")
}
