package agents

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
)

func TestForegroundExploreReportsToTheCallThatStartedIt(t *testing.T) {
	var childModel, childBrief string
	var mu sync.Mutex
	h := newHarness(t, t.TempDir(), policy.Build, func(model string, call fantasy.Call) reply {
		if isChild(call) {
			mu.Lock()
			childModel, childBrief = model, userTexts(call)[0]
			mu.Unlock()
			if !strings.Contains(textOf(call.Prompt[0]), "your final message is the only thing") {
				return reply{text: "no report contract"}
			}
			return reply{text: "found it at a.go:3"}
		}
		role, text := lastOf(call)
		if role == fantasy.MessageRoleUser {
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"where is Foo defined?"}`}}}
		}
		return reply{text: "Foo is at a.go:3 (" + text + ")"}
	})
	s := h.create()
	res := h.prompt(s, "find Foo")
	if res.Status != loop.Completed || res.Text != "Foo is at a.go:3 (found it at a.go:3)" {
		t.Fatalf("result = %+v", res)
	}
	if childModel != "little" || childBrief != "where is Foo defined?" {
		t.Fatalf("explore ran on %q with %q; it should start from the brief alone, on the small model", childModel, childBrief)
	}
	sub := h.of("subagent")
	if len(sub) == 0 || sub[0].Agent != "explore" || sub[0].ParentToolCallID == "" {
		t.Fatalf("subagent notices = %+v", sub)
	}
	threads := s.Threads()
	if len(threads) != 1 || threads[0].Status != thread.Done || threads[0].Report != "found it at a.go:3" || threads[0].CallID != sub[0].ParentToolCallID {
		t.Fatalf("threads = %+v", threads)
	}
	var statuses []string
	for _, n := range h.of("thread") {
		statuses = append(statuses, n.Thread.Status)
	}
	if !slices.Equal(statuses, []string{"running", "done"}) {
		t.Fatalf("thread notices = %v", statuses)
	}
}

// gatedBrain is a root that starts one background explorer and collects it with wait_agents, and
// a child that waits for release before reporting.
func TestBackgroundChildIsCollectedByWaitAgentsAndNotDeliveredTwice(t *testing.T) {
	release := make(chan struct{})
	var secondTurn []string
	var mu sync.Mutex
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			<-release
			return reply{text: "background report"}
		}
		role, text := lastOf(call)
		switch {
		case role == fantasy.MessageRoleUser && text == "start":
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"look around","background":true}`}}}
		case role == fantasy.MessageRoleTool && strings.Contains(text, "in the background"):
			close(release)
			return reply{calls: [][2]string{{"wait_agents", `{}`}}}
		case role == fantasy.MessageRoleTool:
			return reply{text: "collected: " + text}
		default:
			mu.Lock()
			secondTurn = userTexts(call)
			mu.Unlock()
			return reply{text: "ok"}
		}
	})
	s := h.create()
	res := h.prompt(s, "start")
	if !strings.Contains(res.Text, "background report") || !strings.Contains(res.Text, "completed") {
		t.Fatalf("first turn = %q", res.Text)
	}
	h.prompt(s, "next")
	for _, text := range secondTurn {
		if strings.Contains(text, "finished") {
			t.Fatalf("a collected report was delivered again: %v", secondTurn)
		}
	}
}

func TestAnUncollectedBackgroundReportReachesTheNextTurn(t *testing.T) {
	release := make(chan struct{})
	var seen []string
	var mu sync.Mutex
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			<-release
			return reply{text: "late report"}
		}
		role, text := lastOf(call)
		if role == fantasy.MessageRoleUser && text == "start" {
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"slow search","background":true}`}}}
		}
		if role == fantasy.MessageRoleTool {
			return reply{text: "carrying on"}
		}
		mu.Lock()
		seen = userTexts(call)
		mu.Unlock()
		return reply{text: "thanks"}
	})
	s := h.create()
	if res := h.prompt(s, "start"); res.Text != "carrying on" {
		t.Fatalf("first turn = %+v", res)
	}
	close(release)
	waitUntil(t, func() bool { th := s.Threads(); return len(th) == 1 && th[0].Status == thread.Done })
	h.prompt(s, "and now?")
	joined := strings.Join(seen, "\n")
	if !strings.Contains(joined, "finished: done") || !strings.Contains(joined, "late report") {
		t.Fatalf("second turn's messages = %v", seen)
	}
}

func waitUntil(t *testing.T, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatal("timed out")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestAChildRunningAtACrashIsResumedOnLoad(t *testing.T) {
	root := t.TempDir()
	var resumedWith []string
	var mu sync.Mutex
	h := newHarness(t, root, policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			mu.Lock()
			resumedWith = userTexts(call)
			mu.Unlock()
			return reply{text: "resumed report"}
		}
		return reply{text: "root"}
	})
	s := h.create()
	id := s.ID()
	// What a crash leaves: the spawn recorded, one step checkpointed, no end.
	_ = s.store.Spawn(thread.Thread{ID: "t-crash1", Parent: thread.Root, Role: "explore", Brief: "find the bug", Background: true})
	_ = s.store.SaveMessages("t-crash1", []fantasy.Message{fantasy.NewUserMessage("find the bug"), {Role: fantasy.MessageRoleAssistant, Content: []fantasy.MessagePart{fantasy.TextPart{Text: "looking"}}}})
	s.Close()

	loaded, err := Load(context.Background(), h.cfg, id)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(loaded.Close)
	waitUntil(t, func() bool { th := loaded.Threads(); return len(th) == 1 && th[0].Status == thread.Done })
	if got := strings.Join(resumedWith, "|"); got != "find the bug|"+interruptedNote {
		t.Fatalf("resumed with %q", got)
	}
	// Its status is stored a moment before its report is queued; wait for the report itself.
	waitUntil(t, loaded.inbox.HasNotices)
}

func TestCancelCoversTheRunningTurnAndThoseAcceptedBeforeIt(t *testing.T) {
	started := make(chan struct{}, 4)
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		_, text := lastOf(call)
		if text == "slow" {
			started <- struct{}{}
			time.Sleep(200 * time.Millisecond)
			return reply{calls: [][2]string{{"read_file", `{"path":"missing"}`}}}
		}
		return reply{text: "ran: " + text}
	})
	s := h.create()
	first, queued := s.Accept(), s.Accept()
	results := make(chan loop.Result, 2)
	go func() { results <- s.Prompt(context.Background(), first, "slow") }()
	<-started
	go func() { results <- s.Prompt(context.Background(), queued, "queued") }()
	time.Sleep(20 * time.Millisecond)
	s.Cancel()
	for range 2 {
		if r := <-results; r.Status != loop.Cancelled {
			t.Fatalf("a turn accepted before the cancel ran: %+v", r)
		}
	}
	after := s.Accept()
	if r := s.Prompt(context.Background(), after, "after"); r.Status != loop.Completed || r.Text != "ran: after" {
		t.Fatalf("a turn accepted after the cancel did not run: %+v", r)
	}
}

func TestPromptsWaitTheirTurn(t *testing.T) {
	var order []string
	var mu sync.Mutex
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		_, text := lastOf(call)
		mu.Lock()
		order = append(order, text)
		mu.Unlock()
		time.Sleep(30 * time.Millisecond)
		return reply{text: text}
	})
	s := h.create()
	a, b := s.Accept(), s.Accept()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); s.Prompt(context.Background(), a, "one") }()
	time.Sleep(5 * time.Millisecond)
	go func() { defer wg.Done(); s.Prompt(context.Background(), b, "two") }()
	wg.Wait()
	if !slices.Equal(order, []string{"one", "two"}) {
		t.Fatalf("order = %v", order)
	}
	if s.Steer("x") {
		t.Fatal("steering accepted with no turn running")
	}
}

func TestPlanModeOffersNoWritableDelegation(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Plan, func(string, fantasy.Call) reply { return reply{text: "x"} })
	s := h.create()
	names := names(s.rootTools(policy.Plan))
	if slices.Contains(names, "delegate_task") || slices.Contains(names, "write_file") || !slices.Contains(names, "delegate_readonly_task") {
		t.Fatalf("plan tools = %v", names)
	}
	visible := s.rootTools(policy.Build).Visible()
	var sent []string
	for _, tl := range visible {
		sent = append(sent, tl.Name)
	}
	if slices.Contains(sent, "git_log") || !slices.Contains(sent, "tool_search") {
		t.Fatalf("rarely needed tools should be deferred behind tool_search: %v", sent)
	}
}

func TestDefenderModeHasItsPlaybooksAndSecretScan(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Defender, func(string, fantasy.Call) reply { return reply{text: "x"} })
	s := h.create()
	sent := func(mode policy.Mode) []string {
		var out []string
		for _, tl := range s.rootTools(mode).Visible() {
			out = append(out, tl.Name)
		}
		return out
	}
	if d := sent(policy.Defender); !slices.Contains(d, "read_playbook") || !slices.Contains(d, "scan_secrets") {
		t.Fatalf("defender tools = %v", d)
	}
	if b := sent(policy.Build); slices.Contains(b, "read_playbook") || slices.Contains(b, "scan_secrets") {
		t.Fatalf("build should have no playbooks and find the scan with tool_search: %v", b)
	}
	if p := s.rootSystemPrompt(policy.Defender, s.rootTools(policy.Defender)); !strings.Contains(p, "- access-control — Access control") {
		t.Fatal("defender's prompt lacks the playbook index")
	}
	if p := s.rootSystemPrompt(policy.Build, s.rootTools(policy.Build)); strings.Contains(p, "Security playbooks") {
		t.Fatal("build's prompt carries the playbook index")
	}
}

func TestForkFullGivesTheChildTheConversation(t *testing.T) {
	var childSaw []string
	var mu sync.Mutex
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			mu.Lock()
			childSaw = userTexts(call)
			mu.Unlock()
			return reply{text: "reviewed"}
		}
		role, text := lastOf(call)
		if role == fantasy.MessageRoleUser && text == "now review" {
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"review it","agent":"review","fork":"full"}`}}}
		}
		return reply{text: "ok"}
	})
	s := h.create()
	h.prompt(s, "we decided on plan B")
	h.prompt(s, "now review")
	if got := strings.Join(childSaw, "|"); got != "we decided on plan B|now review|review it" {
		t.Fatalf("child saw %q", got)
	}
}

func TestAWrongRoleIsRefusedNamingTheRoles(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		role, text := lastOf(call)
		if role == fantasy.MessageRoleUser {
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"x","agent":"general"}`}}}
		}
		return reply{text: text}
	})
	res := h.prompt(h.create(), "go")
	if !strings.Contains(res.Text, `No read-only role "general"`) || !strings.Contains(res.Text, "explore") {
		t.Fatalf("result = %q", res.Text)
	}
}

func TestSendAgentReopensAFinishedChild(t *testing.T) {
	var second []string
	var mu sync.Mutex
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			texts := userTexts(call)
			if len(texts) > 1 {
				mu.Lock()
				second = texts
				mu.Unlock()
				return reply{text: "follow-up answer"}
			}
			return reply{text: "first answer"}
		}
		role, text := lastOf(call)
		switch {
		case role == fantasy.MessageRoleUser:
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"q1"}`}}}
		case strings.Contains(text, "first answer"):
			id := ""
			for _, th := range threadsOf(call) {
				id = th
			}
			return reply{calls: [][2]string{{"send_agent", `{"id":"` + id + `","message":"and q2?"}`}}}
		default:
			return reply{text: text}
		}
	})
	s := h.create()
	threadIDs = func() []string {
		var out []string
		for _, th := range s.Threads() {
			out = append(out, th.ID)
		}
		return out
	}
	res := h.prompt(s, "ask")
	if res.Text != "follow-up answer" || strings.Join(second, "|") != "q1|and q2?" {
		t.Fatalf("result %q, child saw %v", res.Text, second)
	}
}

// threadIDs lets a brain name a thread the session made (set by the test that needs it).
var threadIDs func() []string

func threadsOf(fantasy.Call) []string {
	if threadIDs == nil {
		return nil
	}
	return threadIDs()
}

func TestAWritableBackgroundChildWorksOnItsOwnBranch(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	root := t.TempDir()
	for _, args := range [][]string{{"init", "-q"}, {"-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "start"}} {
		cmd := exec.Command("git", args...)
		cmd.Dir = root
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	t.Setenv("XDG_CACHE_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	h := newHarness(t, root, policy.Auto, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			role, _ := lastOf(call)
			if role == fantasy.MessageRoleUser {
				return reply{calls: [][2]string{{"write_file", `{"path":"NOTES.md","content":"from the child"}`}}}
			}
			return reply{text: "wrote NOTES.md"}
		}
		role, text := lastOf(call)
		switch {
		case role == fantasy.MessageRoleUser:
			return reply{calls: [][2]string{{"delegate_task", `{"task":"write notes","background":true}`}}}
		case strings.Contains(text, "in the background"):
			return reply{calls: [][2]string{{"wait_agents", `{}`}}}
		default:
			return reply{text: text}
		}
	})
	s := h.create()
	res := h.prompt(s, "go")
	if !strings.Contains(res.Text, "committed on branch friday/t-") {
		t.Fatalf("report = %q", res.Text)
	}
	if _, err := os.Stat(filepath.Join(root, "NOTES.md")); err == nil {
		t.Fatal("the child wrote into the main checkout")
	}
	th := s.Threads()[0]
	out, err := exec.Command("git", "-C", root, "show", th.Branch+":NOTES.md").CombinedOutput()
	if err != nil || string(out) != "from the child" {
		t.Fatalf("branch content = %q, %v", out, err)
	}
	_ = exec.Command("git", "-C", root, "worktree", "remove", "--force", th.Worktree).Run()
}

func TestTheSmallModelNamesTheSession(t *testing.T) {
	var titledBy string
	var mu sync.Mutex
	h := newHarness(t, t.TempDir(), policy.Build, func(model string, call fantasy.Call) reply {
		_, text := lastOf(call)
		if strings.HasPrefix(text, "Write a title") {
			mu.Lock()
			titledBy = model
			mu.Unlock()
			return reply{text: "\"Fix the login bug.\""}
		}
		return reply{text: "on it"}
	})
	h.cfg.Env = nil
	s := h.create()
	h.prompt(s, "the login page throws when the password is empty, please fix")
	waitUntil(t, func() bool { return s.Meta().Title == "Fix the login bug" })
	mu.Lock()
	defer mu.Unlock()
	if titledBy != "little" {
		t.Fatalf("titled by %q", titledBy)
	}
}

func TestCompactBetweenTurns(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		_, text := lastOf(call)
		if strings.HasPrefix(text, "Summarize the conversation") {
			if !strings.Contains(text, "Keep everything about this in full detail: the decision about b") {
				return reply{text: "the focus was lost"}
			}
			return reply{text: "we talked about a and b"}
		}
		return reply{text: "ok " + text}
	})
	s := h.create()
	h.prompt(s, "a")
	h.prompt(s, "b")
	before, after, err := s.Summarize(context.Background(), "the decision about b")
	if err != nil || before != 4 || after != 2 {
		t.Fatalf("summarize = %d → %d, %v", before, after, err)
	}
	if first := textOf(s.Messages()[0]); !strings.Contains(first, "we talked about a and b") || !strings.HasSuffix(first, "b") {
		t.Fatalf("first message = %q", first)
	}
}

func TestQueuedPromptsRunInTheOrderTheyWereAccepted(t *testing.T) {
	for range 10 {
		var order []string
		var mu sync.Mutex
		h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
			_, text := lastOf(call)
			mu.Lock()
			order = append(order, text)
			mu.Unlock()
			if text == "first" {
				time.Sleep(30 * time.Millisecond)
			}
			return reply{text: text}
		})
		s := h.create()
		a, b, c := s.Accept(), s.Accept(), s.Accept()
		var wg sync.WaitGroup
		wg.Add(3)
		go func() { defer wg.Done(); s.Prompt(context.Background(), a, "first") }()
		time.Sleep(5 * time.Millisecond)
		go func() { defer wg.Done(); s.Prompt(context.Background(), c, "third") }() // arrives first
		time.Sleep(2 * time.Millisecond)
		go func() { defer wg.Done(); s.Prompt(context.Background(), b, "second") }()
		wg.Wait()
		if got := strings.Join(order, ","); got != "first,second,third" {
			t.Fatalf("order = %s", got)
		}
	}
}

func TestAReportReadAsAMessageIsNotGivenAgainByWaitAgents(t *testing.T) {
	release := make(chan struct{})
	var waited string
	var mu sync.Mutex
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			<-release
			return reply{text: "REPORT-XYZ"}
		}
		role, text := lastOf(call)
		switch {
		case role == fantasy.MessageRoleUser && text == "start":
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"look","background":true}`}}}
		case role == fantasy.MessageRoleTool && strings.Contains(text, "in the background"):
			return reply{text: "carrying on"}
		case role == fantasy.MessageRoleUser:
			return reply{calls: [][2]string{{"wait_agents", `{}`}}}
		default:
			mu.Lock()
			waited = text
			mu.Unlock()
			return reply{text: "done"}
		}
	})
	s := h.create()
	h.prompt(s, "start")
	close(release)
	waitUntil(t, func() bool { th := s.Threads(); return len(th) == 1 && th[0].Status == thread.Done })
	h.prompt(s, "collect")
	count := 0
	for _, m := range s.Messages() {
		count += strings.Count(textOf(m), "REPORT-XYZ")
		for _, p := range m.Content {
			if r, ok := p.(fantasy.ToolResultPart); ok {
				if o, ok := r.Output.(fantasy.ToolResultOutputContentText); ok {
					count += strings.Count(o.Text, "REPORT-XYZ")
				}
			}
		}
	}
	if count != 1 || !strings.Contains(waited, "already above") {
		t.Fatalf("the report appears %d times; wait_agents said %q", count, waited)
	}
}

func TestATurnSentDuringCompactionRunsAfterItAndIsKept(t *testing.T) {
	slow := make(chan struct{})
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		_, text := lastOf(call)
		if strings.HasPrefix(text, "Summarize the conversation") {
			<-slow
			return reply{text: "SUMMARY"}
		}
		return reply{text: "answer to " + text}
	})
	s := h.create()
	h.prompt(s, "one")
	h.prompt(s, "two")
	done := make(chan error, 1)
	go func() { _, _, err := s.Summarize(context.Background(), ""); done <- err }()
	waitUntil(t, s.Busy)
	turn := make(chan loop.Result, 1)
	go func() { turn <- h.prompt(s, "three") }()
	time.Sleep(20 * time.Millisecond)
	close(slow)
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if res := <-turn; res.Text != "answer to three" {
		t.Fatalf("turn = %+v", res)
	}
	all := ""
	for _, m := range s.Messages() {
		all += textOf(m) + "|"
	}
	if !strings.Contains(all, "SUMMARY") || !strings.Contains(all, "answer to three") {
		t.Fatalf("messages = %s", all)
	}
}

func TestABackgroundChildStoppedByQuittingResumesNextTime(t *testing.T) {
	root := t.TempDir()
	started := make(chan struct{}, 1)
	var resumedWith []string
	var mu sync.Mutex
	h := newHarness(t, root, policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			texts := userTexts(call)
			if len(texts) > 1 {
				mu.Lock()
				resumedWith = texts
				mu.Unlock()
				return reply{text: "finished after resuming"}
			}
			select {
			case started <- struct{}{}:
			default:
			}
			time.Sleep(200 * time.Millisecond)
			return reply{calls: [][2]string{{"read_file", `{"path":"x"}`}}}
		}
		role, text := lastOf(call)
		if role == fantasy.MessageRoleUser && text == "start" {
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"slow","background":true}`}}}
		}
		return reply{text: "carrying on"}
	})
	s, err := Create(context.Background(), h.cfg, "")
	if err != nil {
		t.Fatal(err)
	}
	h.prompt(s, "start")
	<-started
	s.Close()
	if th := s.Threads(); th[0].Status != thread.Paused {
		t.Fatalf("after quitting, status = %s", th[0].Status)
	}
	if s.inbox.HasNotices() {
		t.Fatal("a paused child reported as if it had finished")
	}
	loaded, err := Load(context.Background(), h.cfg, s.ID())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(loaded.Close)
	waitUntil(t, func() bool { th := loaded.Threads(); return len(th) == 1 && th[0].Status == thread.Done })
	mu.Lock()
	defer mu.Unlock()
	if len(resumedWith) < 2 || resumedWith[len(resumedWith)-1] != interruptedNote {
		t.Fatalf("resumed with %v", resumedWith)
	}
}

// TestASubagentsTokensAreCountedStoredAndReported: each sub-agent's model calls are added up as
// they happen, kept with its thread, and sent with its status, so its spend is known after it ends.
func TestASubagentsTokensAreCountedStoredAndReported(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Build, func(_ string, call fantasy.Call) reply {
		if isChild(call) {
			return reply{text: "found it"}
		}
		role, _ := lastOf(call)
		if role == fantasy.MessageRoleUser {
			return reply{calls: [][2]string{{"delegate_readonly_task", `{"task":"find Add"}`}}}
		}
		return reply{text: "done"}
	})
	s := h.create()
	h.prompt(s, "go")
	var last *ThreadInfo
	for _, n := range h.of("thread") {
		last = n.Thread
	}
	want := loop.Usage{InputTokens: 10, OutputTokens: 5}
	if last == nil || last.Status != thread.Done || last.Usage == nil || *last.Usage != want || last.Model != "little" {
		t.Fatalf("last thread notice = %+v", last)
	}
	var child thread.Thread
	for _, th := range s.Threads() {
		if th.ID != thread.Root {
			child = th
		}
	}
	if child.Usage == nil || loop.Usage(*child.Usage) != want {
		t.Fatalf("stored thread = %+v", child)
	}
}

func TestAThreadsTokensSurviveARestart(t *testing.T) {
	root := t.TempDir()
	store, err := thread.Create(root, thread.Meta{ID: thread.NewID(time.Now()), Cwd: root})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Spawn(thread.Thread{ID: "c1", Parent: thread.Root, Status: thread.Running}); err != nil {
		t.Fatal(err)
	}
	_ = store.SetUsage("c1", thread.Usage{InputTokens: 100, OutputTokens: 7})
	_ = store.SetUsage("c1", thread.Usage{InputTokens: 250, OutputTokens: 20, CachedInputTokens: 90})
	got, ok := store.Thread("c1")
	if !ok || got.Usage == nil || *got.Usage != (thread.Usage{InputTokens: 250, OutputTokens: 20, CachedInputTokens: 90}) {
		t.Fatalf("replayed %+v", got)
	}
}

func TestTheMainConversationsTokensAreKeptWithTheSession(t *testing.T) {
	h := newHarness(t, t.TempDir(), policy.Build, func(string, fantasy.Call) reply { return reply{text: "hi"} })
	s := h.create()
	h.prompt(s, "one")
	h.prompt(s, "two")
	meta := s.Meta()
	if meta.ModelCalls != 2 || meta.Usage == nil || *meta.Usage != (thread.Usage{InputTokens: 20, OutputTokens: 10}) {
		t.Fatalf("meta = %d calls, %+v", meta.ModelCalls, meta.Usage)
	}
}

// TestASkillIsListedThenLoadedWhenTheModelAsks: the prompt names the project's skill in one line,
// and load_skill hands the model its instructions.
func TestASkillIsListedThenLoadedWhenTheModelAsks(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, ".agents", "skills", "release")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(dir, "SKILL.md"), []byte("---\nname: release\ndescription: Cut a release of this project\n---\nBump the version, tag it, write the notes.\n"), 0o644)
	var system, loaded string
	var mu sync.Mutex
	h := newHarness(t, root, policy.Build, func(_ string, call fantasy.Call) reply {
		role, text := lastOf(call)
		mu.Lock()
		defer mu.Unlock()
		if role == fantasy.MessageRoleUser {
			system = textOf(call.Prompt[0])
			return reply{calls: [][2]string{{"load_skill", `{"name":"release"}`}}}
		}
		loaded = text
		return reply{text: "released"}
	})
	s := h.create()
	h.prompt(s, "cut a release")
	mu.Lock()
	defer mu.Unlock()
	if !strings.Contains(system, "- release: Cut a release of this project") {
		t.Fatalf("the prompt does not list the skill:\n%s", system)
	}
	if !strings.Contains(loaded, "Bump the version, tag it, write the notes.") {
		t.Fatalf("load_skill returned %q", loaded)
	}
}
