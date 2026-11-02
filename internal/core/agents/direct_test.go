package agents

import (
	"strings"
	"sync"
	"testing"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

func TestHelpersThePersonStartsRunAtOnceAndReportToTheNextTurn(t *testing.T) {
	release := make(chan struct{})
	var seen []string
	var mu sync.Mutex
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			<-release
			_, brief := lastOf(call)
			return reply{text: "report on " + brief}
		}
		mu.Lock()
		seen = userTexts(call)
		mu.Unlock()
		return reply{text: "ok"}
	})
	s := h.create()
	a, profile, err := s.StartAgent("explore map the API")
	if err != nil || profile.Name != "explore" || a.Brief != "map the API" {
		t.Fatalf("a first word naming a role picks it: %+v %s %v", a, profile.Name, err)
	}
	b, profile, err := s.StartAgent("read the parser")
	if err != nil || profile.Name != "explore" {
		t.Fatalf("outside a git repository the default is read-only: %s %v", profile.Name, err)
	}
	if !a.Background || !strings.HasPrefix(a.CallID, UserCallPrefix) || a.CallID == b.CallID {
		t.Fatalf("each runs in the background under its own user call id: %+v %+v", a, b)
	}
	waitUntil(t, func() bool { return len(h.of("thread")) >= 2 })
	for _, n := range h.of("thread") {
		if !strings.HasPrefix(n.Thread.ParentToolCallID, UserCallPrefix) || n.Thread.Status != thread.Running {
			t.Fatalf("both are announced running, for their cards: %+v", n.Thread)
		}
	}
	close(release)
	waitUntil(t, func() bool {
		done := 0
		for _, th := range s.Threads() {
			if th.Status == thread.Done {
				done++
			}
		}
		return done == 2
	})
	h.prompt(s, "what did they find?")
	joined := strings.Join(seen, "\n")
	if !strings.Contains(joined, "report on map the API") || !strings.Contains(joined, "report on read the parser") {
		t.Fatalf("both reports reach the next turn: %v", seen)
	}
}

func TestAHelperThatCannotStartSaysWhy(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Plan, func(string, fantasy.Call) reply { return reply{text: "ok"} })
	s := h.create()
	for text, want := range map[string]string{
		"":               "say what the helper should do",
		"explore":        "say what the helper should do",
		"general fix it": "plan mode changes nothing",
	} {
		if _, _, err := s.StartAgent(text); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%q: %v, want %q", text, err, want)
		}
	}
	h.cfg.Mode = policy.Build
	s2 := h.create()
	if _, _, err := s2.StartAgent("general fix it"); err == nil || !strings.Contains(err.Error(), "not a git repository") {
		t.Errorf("a writable helper outside git: %v", err)
	}
	if len(s.Threads())+len(s2.Threads()) != 0 {
		t.Fatal("nothing started")
	}
}

func TestThePersonCanStopAHelperAndFollowItUp(t *testing.T) {
	release := make(chan struct{})
	var mu sync.Mutex
	var heard []string
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			_, last := lastOf(call)
			mu.Lock()
			heard = append(heard, last)
			mu.Unlock()
			if strings.Contains(last, "map the API") {
				<-release // at work until stopped (or released)
			}
			return reply{text: "report on " + last}
		}
		return reply{text: "ok"}
	})
	s := h.create()
	a, _, err := s.StartAgent("explore map the API")
	if err != nil {
		t.Fatal(err)
	}
	waitUntil(t, func() bool { mu.Lock(); defer mu.Unlock(); return len(heard) == 1 })

	if _, err := s.StopAgent("nobody"); err == nil {
		t.Fatal("an unknown sub-agent is an error")
	}
	if text, err := s.StopAgent(a.CallID); err != nil || !strings.Contains(text, "Stopping "+a.ID) {
		t.Fatalf("stopped by its card's call id: %q %v", text, err)
	}
	close(release) // the fake model call returns; the helper's run sees it was stopped
	waitUntil(t, func() bool {
		th, _ := s.store.Thread(a.ID)
		return thread.Terminal(th.Status)
	})
	if th, _ := s.store.Thread(a.ID); th.Status != thread.Cancelled {
		t.Fatalf("a stopped helper ends cancelled, not %s", th.Status)
	}
	if text, _ := s.StopAgent(a.ID); !strings.Contains(text, "already finished") {
		t.Fatalf("stopping it again: %q", text)
	}

	if _, err := s.SendAgent(a.ID, "  "); err == nil {
		t.Fatal("an empty message is an error")
	}
	text, err := s.SendAgent(a.ID, "now list the endpoints")
	if err != nil || !strings.Contains(text, "Re-opened "+a.ID) {
		t.Fatalf("a finished helper starts again with the message: %q %v", text, err)
	}
	waitUntil(t, func() bool {
		mu.Lock()
		defer mu.Unlock()
		return len(heard) == 2 && heard[1] == "now list the endpoints"
	})
	var reopened *ThreadInfo
	waitUntil(t, func() bool {
		for _, n := range h.of("thread") {
			if n.Thread.ID == a.ID && n.Thread.Status == thread.Running && n.Thread.ParentToolCallID != a.CallID {
				reopened = n.Thread
			}
		}
		return reopened != nil
	})
	if !strings.HasPrefix(reopened.ParentToolCallID, UserCallPrefix) || !reopened.Background {
		t.Fatalf("it runs under a card of its own, in the background: %+v", reopened)
	}
}
