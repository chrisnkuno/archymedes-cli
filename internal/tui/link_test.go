package tui

import (
	"encoding/json"
	"math/rand/v2"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/phone"
	"github.com/chrisnkuno/friday-cli/internal/phone/phonetest"
)

// Friday from the phone: the person pairs with /phone, walks away, and from the phone watches the
// session live, sends messages, answers approvals and questions, and stops, undoes, switches mode
// or restarts a stuck command. The link goes through a relay that only forwards (phonetest's,
// keeping the protocol's rules), sealed end to end.

// linked is a paired model, its relay and a phone in the room.
type linked struct {
	m     *Model
	agent *fakeAgent
	relay *phonetest.Relay
	phone *phonetest.Phone
	inbox chan tea.Msg
	dir   string
	awake *fakeAwake
}

type fakeAwake struct{ held, holds, releases int }

func (f *fakeAwake) Hold() {
	if f.held == 0 {
		f.holds++
	}
	f.held = 1
}
func (f *fakeAwake) Release() {
	if f.held == 1 {
		f.releases++
	}
	f.held = 0
}
func (f *fakeAwake) Close() { f.Release() }

func newLinked(t *testing.T) *linked {
	t.Helper()
	relay := phonetest.NewRelay(t)
	t.Setenv("ARCHYMEDES_PHONE_RELAY", relay.URL())
	t.Setenv("ARCHYMEDES_NOTIFY_URL", "")
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 36})
	l := &linked{m: m, agent: agent, relay: relay, inbox: make(chan tea.Msg, 512), dir: t.TempDir(), awake: &fakeAwake{}}
	m.opts.ConfigDir = l.dir
	m.SetSender(func(msg tea.Msg) {
		select {
		case l.inbox <- msg:
		default:
		}
	})
	m.linkAwake = l.awake
	t.Cleanup(func() { m.linkStop() })
	l.run("/phone")
	if _, open := windowOf[*pager](m); !open {
		t.Fatal("/phone did not show the code")
	}
	press(m, 'q', 0) // scanned: the window is closed, as a person would
	s := l.secret(t)
	waitFor(t, func() bool { return relay.Computer(s.Room()) }, "Friday never joined the relay room")
	l.phone = phonetest.NewPhone(t, relay.URL(), s)
	l.pump(t, func() bool { return m.link != nil && m.link.phones == 1 }, "Friday never heard the phone join")
	return l
}

func (l *linked) secret(t *testing.T) phone.Secret {
	t.Helper()
	s, ok, err := phone.LoadPairing(l.dir)
	if err != nil || !ok {
		t.Fatalf("no pairing kept: %v %v", ok, err)
	}
	return s
}

// run types a slash command and delivers what it does.
func (l *linked) run(command string) {
	cmd, _ := l.m.runCommand(command)
	deliver(l.m, cmd)
}

// pump delivers what the link sent the model until cond holds. Commands run as Bubble Tea runs
// them, each on its own goroutine with its message back through the inbox, so a clock that keeps
// ticking (a refused steer retried while the turn runs) never holds the test.
func (l *linked) pump(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.After(8 * time.Second)
	for !cond() {
		select {
		case msg := <-l.inbox:
			_, cmd := l.m.Update(msg)
			l.exec(cmd)
		case <-time.After(20 * time.Millisecond):
			l.exec(l.m.linkAfter())
		case <-deadline:
			t.Fatal(what)
		}
	}
}

// exec runs a command as Bubble Tea would: off the update loop, a batch's parts side by side, a
// sequence's in order, each message back into the inbox.
func (l *linked) exec(cmd tea.Cmd) {
	if cmd == nil {
		return
	}
	go func() { l.feed(cmd()) }()
}

func (l *linked) feed(msg tea.Msg) {
	switch msg := msg.(type) {
	case nil:
	case tea.BatchMsg:
		for _, c := range msg {
			l.exec(c)
		}
	default:
		if v := reflect.ValueOf(msg); v.Kind() == reflect.Slice && v.Type().Elem() == reflect.TypeOf(tea.Cmd(nil)) {
			for i := range v.Len() { // tea.Sequence: in order
				if c, _ := v.Index(i).Interface().(tea.Cmd); c != nil {
					l.feed(c())
				}
			}
			return
		}
		select {
		case l.inbox <- msg:
		default:
		}
	}
}

// ask sends a request from the phone and pumps until its ack comes back.
func (l *linked) ask(t *testing.T, request map[string]any) map[string]any {
	t.Helper()
	id := l.phone.Send(request)
	var ack map[string]any
	l.pump(t, func() bool {
		for {
			m := l.phone.Next("", 0)
			if m == nil {
				return false
			}
			l.seen(m)
			if m["type"] == "ack" && m["of"] == id {
				ack = m
				return true
			}
		}
	}, "no ack for "+normal(request))
	return ack
}

// view is the phone's picture of the session: the last state, with every patch applied since.
type view struct {
	state map[string]any
	all   []map[string]any // every message the phone opened
}

var phoneViews = map[*phonetest.Phone]*view{}

func (l *linked) seen(m map[string]any) {
	v := phoneViews[l.phone]
	if v == nil {
		v = &view{}
		phoneViews[l.phone] = v
	}
	v.all = append(v.all, m)
	switch m["type"] {
	case "state":
		v.state = m
	case "patch":
		if v.state != nil {
			v.state = applyPatch(v.state, m)
		}
	}
}

// drain takes everything the phone has been sent so far into its view.
func (l *linked) drain(t *testing.T) *view {
	t.Helper()
	l.pump(t, func() bool { return true }, "")
	time.Sleep(linkEvery + 50*time.Millisecond)
	deliver(l.m, l.m.linkAfter())
	for {
		m := l.phone.Next("", 300*time.Millisecond)
		if m == nil {
			break
		}
		l.seen(m)
	}
	return phoneViews[l.phone]
}

// applyPatch is the phone's rule: top-level parts replaced, items upserted by id in order,
// removed ids dropped, rev taken.
func applyPatch(state, patch map[string]any) map[string]any {
	next := map[string]any{}
	for k, v := range state {
		next[k] = v
	}
	for k, v := range patch {
		if k == "items" || k == "removed" || k == "type" {
			continue
		}
		next[k] = v
	}
	items, _ := state["items"].([]any)
	byID := map[string]int{}
	merged := append([]any(nil), items...)
	for i, it := range merged {
		byID[it.(map[string]any)["id"].(string)] = i
	}
	if up, ok := patch["items"].([]any); ok {
		for _, it := range up {
			id := it.(map[string]any)["id"].(string)
			if i, ok := byID[id]; ok {
				merged[i] = it
			} else {
				byID[id] = len(merged)
				merged = append(merged, it)
			}
		}
	}
	if gone, ok := patch["removed"].([]any); ok {
		for _, id := range gone {
			merged = slices.DeleteFunc(merged, func(it any) bool { return it.(map[string]any)["id"] == id })
		}
	}
	next["items"] = merged
	next["type"] = "state"
	return next
}

func (l *linked) hello(t *testing.T) map[string]any {
	t.Helper()
	ack := l.ask(t, map[string]any{"type": "hello", "device": "test phone"})
	if ack["ok"] != true {
		t.Fatalf("hello refused: %v", ack)
	}
	v := l.drain(t)
	if v == nil || v.state == nil {
		t.Fatal("no state after hello")
	}
	return v.state
}

func itemsOf(state map[string]any) []map[string]any {
	var out []map[string]any
	for _, it := range state["items"].([]any) {
		out = append(out, it.(map[string]any))
	}
	return out
}

func lastItem(state map[string]any, kind string) map[string]any {
	items := itemsOf(state)
	for i := len(items) - 1; i >= 0; i-- {
		if items[i]["kind"] == kind {
			return items[i]
		}
	}
	return nil
}

// --- functional ------------------------------------------------------------------------------

// FUNCTIONAL: the phone joins, sees the session, sends a message that becomes a turn, and watches
// the turn's words and tool call arrive; what it pieced together from patches is what a fresh
// resync shows.
func TestFromThePhoneAPersonWatchesAndDrivesATurn(t *testing.T) {
	l := newLinked(t)
	state := l.hello(t)
	if state["phase"] != "ready" || state["session"].(map[string]any)["model"] != "m1" {
		t.Fatalf("state %v", state)
	}
	ack := l.ask(t, map[string]any{"type": "send", "text": "port the parser"})
	if ack["ok"] != true {
		t.Fatalf("send refused: %v", ack)
	}
	l.agent.mu.Lock()
	prompts := slices.Clone(l.agent.prompts)
	l.agent.mu.Unlock()
	if len(prompts) != 1 || !strings.Contains(prompts[0], "port the parser") {
		t.Fatalf("the agent heard %q", prompts)
	}
	l.m.Update(agentMsg{acp.TextChunk{Text: "Reading the parser first."}})
	l.m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "run_command", Arguments: map[string]any{"command": "go test ./parser"}}))
	l.m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "c1", ToolName: "run_command", Content: "exit 0\nok  parser 0.4s"}))
	v := l.drain(t)
	if v.state["phase"] != "busy" {
		t.Fatalf("phase %v", v.state["phase"])
	}
	if u := lastItem(v.state, "user"); u == nil || u["text"] != "port the parser" {
		t.Fatalf("the phone lacks the message: %v", itemsOf(v.state))
	}
	if a := lastItem(v.state, "assistant"); a == nil || !strings.Contains(a["text"].(string), "Reading the parser") {
		t.Fatalf("the phone lacks the reply: %v", itemsOf(v.state))
	}
	tool := lastItem(v.state, "tool")
	if tool == nil || !strings.Contains(tool["title"].(string), "go test ./parser") || tool["status"] != "done" || !strings.Contains(tool["text"].(string), "ok  parser") {
		t.Fatalf("the phone's tool card: %v", tool)
	}
	pieced := v.state
	l.ask(t, map[string]any{"type": "resync"})
	fresh := l.drain(t).state
	delete(pieced, "rev")
	delete(fresh, "rev")
	if !reflect.DeepEqual(normal(pieced), normal(fresh)) {
		t.Fatalf("patches and a resync disagree:\npatched %v\nfresh   %v", diffJSON(pieced, fresh), diffJSON(fresh, pieced))
	}
}

func normal(v any) string { b, _ := json.Marshal(v); return string(b) }

// FUNCTIONAL: an approval shows on the phone with its whole command and its risk; the phone's
// Allow reaches the agent, the card says so, and the phone sees it answered.
func TestARiskyApprovalIsAnsweredFromThePhone(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "ship it"})
	var heard []string
	req := acp.NewPermissionRequestForTest(acp.ToolCallRef{ToolCallID: "c9", Title: "run_command: git push --force origin main"},
		[]acp.PermissionOption{{OptionID: "allow", Name: "Allow"}, {OptionID: "deny", Name: "Deny"}},
		func(id string) { heard = append(heard, id) })
	req.Risk = []string{"force push"}
	l.m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c9", ToolName: "run_command", Arguments: map[string]any{"command": "git push --force origin main"}}))
	l.m.Update(agentMsg{req})
	v := l.drain(t)
	a, _ := v.state["approval"].(map[string]any)
	if a == nil || a["command"] != "git push --force origin main" || !strings.Contains(normal(a["risk"]), "force push") {
		t.Fatalf("the phone's approval: %v", v.state["approval"])
	}
	ack := l.ask(t, map[string]any{"type": "answer", "approval": a["id"], "choice": "allow"})
	if ack["ok"] != true || len(heard) != 1 || heard[0] != "allow" {
		t.Fatalf("ack %v, agent heard %v", ack, heard)
	}
	if !strings.Contains(screen(l.m), "answered from your phone") {
		t.Fatalf("the card does not say the phone answered:\n%s", screen(l.m))
	}
	if v := l.drain(t); v.state["approval"] != nil {
		t.Fatalf("the phone still shows the answered approval: %v", v.state["approval"])
	}
}

// --- behavioural: one rule each ----------------------------------------------------------------

func TestAMessageFromThePhoneWhileFridayWorksIsQueued(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "first"})
	ack := l.ask(t, map[string]any{"type": "send", "text": "then the lexer"})
	// As at the terminal (WS-66): it waits in the queue, and steers into the turn after a while.
	l.agent.mu.Lock()
	steered := slices.Contains(l.agent.steered, "then the lexer")
	l.agent.mu.Unlock()
	queued := len(l.m.queue) == 1 && l.m.queue[0].text == "then the lexer"
	if ack["ok"] != true || !strings.HasPrefix(ack["text"].(string), "Queued") || (!queued && !steered) {
		t.Fatalf("ack %v, queue %+v, steered %v", ack, l.m.queue, steered)
	}
	if queued {
		if q, _ := l.drain(t).state["queue"].([]any); len(q) != 1 {
			t.Fatalf("the phone does not see the queue: %v", q)
		}
	}
}

func TestAnAnswerCountsOnlyForTheApprovalWaitingNow(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "go"})
	var heard []string
	l.m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{ToolCallID: "c1", Title: "edit"},
		[]acp.PermissionOption{{OptionID: "allow", Name: "Allow"}, {OptionID: "deny", Name: "Deny"}}, func(id string) { heard = append(heard, id) })})
	if ack := l.ask(t, map[string]any{"type": "answer", "approval": "not-this-one", "choice": "allow"}); ack["ok"] != false {
		t.Fatalf("a stale approval id was taken: %v", ack)
	}
	if len(heard) != 0 || l.m.approval == nil {
		t.Fatal("a stale answer reached the agent")
	}
}

func TestTheFirstAnswerWinsTerminalThenPhone(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "go"})
	var heard []string
	l.m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{ToolCallID: "c1", Title: "edit"},
		[]acp.PermissionOption{{OptionID: "allow", Name: "Allow"}, {OptionID: "deny", Name: "Deny"}}, func(id string) { heard = append(heard, id) })})
	id := l.drain(t).state["approval"].(map[string]any)["id"]
	typeText(l.m, "n") // denied at the terminal
	if ack := l.ask(t, map[string]any{"type": "answer", "approval": id, "choice": "allow"}); ack["ok"] != false {
		t.Fatalf("the phone's late answer was taken: %v", ack)
	}
	if !reflect.DeepEqual(heard, []string{"deny"}) {
		t.Fatalf("the agent heard %v", heard)
	}
}

func TestTheFirstAnswerWinsPhoneThenTerminal(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "go"})
	var heard []string
	l.m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{ToolCallID: "c1", Title: "edit"},
		[]acp.PermissionOption{{OptionID: "allow", Name: "Allow"}, {OptionID: "deny", Name: "Deny"}}, func(id string) { heard = append(heard, id) })})
	id := l.drain(t).state["approval"].(map[string]any)["id"]
	l.ask(t, map[string]any{"type": "answer", "approval": id, "choice": "allow"})
	typeText(l.m, "n") // too late here: nothing waits
	if !reflect.DeepEqual(heard, []string{"allow"}) {
		t.Fatalf("the agent heard %v", heard)
	}
}

func TestAQuestionIsAnsweredFromThePhoneByOptionOrInWords(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "go"})
	var said []string
	ask := func() string {
		l.m.Update(agentMsg{acp.NewQuestionRequestForTest("Which database?", []string{"Postgres", "SQLite"}, false, func(s string) { said = append(said, s) })})
		q := l.drain(t).state["approval"].(map[string]any)
		if q["kind"] != "question" || q["text"] != "Which database?" || q["free"] != true {
			t.Fatalf("the phone's question: %v", q)
		}
		return q["id"].(string)
	}
	l.ask(t, map[string]any{"type": "answer", "approval": ask(), "choice": "2"})
	l.ask(t, map[string]any{"type": "answer", "approval": ask(), "text": "DuckDB, it is analytics"})
	if !reflect.DeepEqual(said, []string{"SQLite", "DuckDB, it is analytics"}) {
		t.Fatalf("the agent heard %v", said)
	}
}

func TestThePhoneStopsUndoesSwitchesModeAndRestartsACommand(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "go"})
	if ack := l.ask(t, map[string]any{"type": "stop"}); ack["ok"] != true {
		t.Fatalf("stop: %v", ack)
	}
	l.agent.mu.Lock()
	cancelled := l.agent.cancelled
	l.agent.mu.Unlock()
	if cancelled != 1 {
		t.Fatalf("stop did not stop the turn: %d", cancelled)
	}
	l.m.Update(agentMsg{acp.TurnEnded{StopReason: "cancelled"}})
	l.ask(t, map[string]any{"type": "undo"})
	l.ask(t, map[string]any{"type": "mode", "mode": "auto"})
	l.ask(t, map[string]any{"type": "command", "command": "cmd1", "action": "restart"})
	l.ask(t, map[string]any{"type": "command", "command": "cmd2", "action": "stop"})
	got := sentCommands(l.agent)
	for _, want := range []string{"undo:", "command-restart:cmd1", "command-stop:cmd2"} {
		if !slices.Contains(got, want) {
			t.Errorf("the engine was not asked %q: %v", want, got)
		}
	}
	l.agent.mu.Lock()
	modes := slices.Clone(l.agent.modes)
	l.agent.mu.Unlock()
	if !slices.Contains(modes, "auto") {
		t.Errorf("mode not switched: %v", modes)
	}
}

func TestAnUnknownOrMalformedRequestIsRefusedNotActedOn(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	for _, req := range []map[string]any{
		{"type": "format-disk"}, {"type": "send"}, {"type": "send", "text": 42}, {"type": "answer"},
		{"type": "mode", "mode": "root"}, {"type": "command", "command": "cmd1", "action": "explode"}, {},
	} {
		if ack := l.ask(t, req); ack["ok"] != false {
			t.Fatalf("%v accepted: %v", req, ack)
		}
	}
	l.agent.mu.Lock()
	defer l.agent.mu.Unlock()
	if len(l.agent.prompts) != 0 || len(l.agent.modes) != 0 {
		t.Fatalf("a refused request acted: %v %v", l.agent.prompts, l.agent.modes)
	}
}

func TestANewPairingShutsTheOldPhoneOutAndOffForgetsIt(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	old := l.secret(t)
	l.run("/phone new")
	fresh := l.secret(t)
	if fresh == old {
		t.Fatal("/phone new kept the same pairing")
	}
	waitFor(t, func() bool { return l.relay.Computer(fresh.Room()) && !l.relay.Computer(old.Room()) }, "Friday did not move to the new room")
	// The old phone, still in the old room, is heard by nobody.
	l.phone.Send(map[string]any{"type": "send", "text": "from the old pairing"})
	time.Sleep(300 * time.Millisecond)
	l.pump(t, func() bool { return true }, "")
	if len(l.agent.prompts) != 0 {
		t.Fatalf("the old phone still drives Friday: %v", l.agent.prompts)
	}
	l.run("/phone off")
	if _, err := os.Stat(filepath.Join(l.dir, "phone.json")); !os.IsNotExist(err) {
		t.Fatal("/phone off left the pairing on disk")
	}
	waitFor(t, func() bool { return !l.relay.Computer(fresh.Room()) }, "/phone off left Friday in the room")
}

func TestTheComputerStaysAwakeWhilePairedAndAPhoneOrTheWorkNeedsIt(t *testing.T) {
	l := newLinked(t) // a phone is connected
	if l.awake.held != 1 {
		t.Fatal("not held with a phone connected")
	}
	l.phone.Close()
	l.pump(t, func() bool { return l.m.link.phones == 0 }, "the phone leaving was not heard")
	deliver(l.m, l.m.linkAfter())
	if l.awake.held != 0 {
		t.Fatal("still held with no phone and nothing running")
	}
	typeText(l.m, "work")
	press(l.m, tea.KeyEnter, 0)
	deliver(l.m, l.m.linkAfter())
	if l.awake.held != 1 {
		t.Fatal("not held while a turn runs, paired")
	}
	l.run("/phone off")
	if l.awake.held != 0 {
		t.Fatal("still held after /phone off")
	}
}

// When paired, a push only wakes the person and opens the phone page: no buttons, no secret.
func TestAPushWhilePairedOpensThePhonePageAndCarriesNoSecret(t *testing.T) {
	n := newNtfy(t)
	l := newLinked(t)
	t.Setenv("ARCHYMEDES_NOTIFY_URL", n.srv.URL+"/friday-topic")
	t.Setenv("ARCHYMEDES_NOTIFY_REPLIES", "on")
	l.phone.Close()
	l.pump(t, func() bool { return l.m.link.phones == 0 }, "the phone leaving was not heard")
	l.m.Update(tea.BlurMsg{})
	l.ask2(t)
	p := n.last(t, "friday-topic")
	if p.actions != "" || p.click != "https://archymedes.xyz/phone" {
		t.Fatalf("push %+v: want no buttons and a click to the phone page", p)
	}
	secret := l.secret(t).Encode()
	if strings.Contains(p.body+p.title+p.click, secret) {
		t.Fatal("the push carries the pairing secret")
	}
}

// ask2 puts an approval up without a phone to answer it.
func (l *linked) ask2(t *testing.T) {
	t.Helper()
	l.m.phase = busy
	_, cmd := l.m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{ToolCallID: "c1", Title: "edit"},
		[]acp.PermissionOption{{OptionID: "allow", Name: "Allow"}, {OptionID: "deny", Name: "Deny"}}, func(string) {})})
	deliver(l.m, cmd)
}

// --- invariants ----------------------------------------------------------------------------------

// INVARIANT: whatever the session does, the phone's picture built from patches equals a fresh
// resync, revs rise by exactly one, and no message is over the limit.
func TestPatchesAlwaysAddUpToTheState(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	r := rand.New(rand.NewPCG(21, 22))
	tools := 0
	for step := range 120 {
		switch r.IntN(7) {
		case 0:
			l.m.tr.add(&userItem{text: "message " + strings.Repeat("é", r.IntN(40))})
		case 1:
			l.m.Update(agentMsg{acp.TextChunk{Text: strings.Repeat("word ", 1+r.IntN(30))}})
		case 2:
			tools++
			id := "t" + itoa(tools)
			l.m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: id, ToolName: "run_command", Arguments: map[string]any{"command": "echo " + id}}))
		case 3:
			if tools > 0 {
				id := "t" + itoa(1+r.IntN(tools))
				l.m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_result", ToolCallID: id, ToolName: "run_command", Content: strings.Repeat("line\n", r.IntN(3000))}))
			}
		case 4:
			l.m.notice(noticeWarn, "notice "+itoa(step))
		case 5:
			l.m.queue = append(l.m.queue, queuedMsg{id: step, text: "queued " + itoa(step)})
		case 6:
			if len(l.m.queue) > 0 {
				l.m.queue = l.m.queue[1:]
			}
		}
		if r.IntN(4) == 0 {
			l.drain(t)
		}
	}
	v := l.drain(t)
	pieced := v.state
	l.ask(t, map[string]any{"type": "resync"})
	fresh := l.drain(t).state
	delete(pieced, "rev")
	delete(fresh, "rev")
	if normal(pieced) != normal(fresh) {
		t.Fatalf("patches drifted from the state:\npatched %.600s\nfresh   %.600s", normal(pieced), normal(fresh))
	}
	last := -1.0
	for _, m := range v.all {
		if rev, ok := m["rev"].(float64); ok {
			if m["type"] == "patch" && last >= 0 && rev != last+1 {
				t.Fatalf("rev went %v → %v", last, rev)
			}
			last = rev
		}
		if raw, _ := json.Marshal(m); len(raw) > phone.MaxMessage {
			t.Fatalf("a %d-byte message", len(raw))
		}
	}
	for _, it := range itemsOf(fresh) {
		if s, _ := it["text"].(string); len([]rune(s)) > linkItemText {
			t.Fatalf("an item of %d characters", len([]rune(s)))
		}
	}
}

// INVARIANT: nothing the phone is sent carries the pairing secret, an API key or a setting value.
func TestNothingSentCarriesASecret(t *testing.T) {
	t.Setenv("OPENROUTER_API_KEY", "sk-or-v1-NEVER-ON-THE-PHONE")
	l := newLinked(t)
	// A token kept in Friday's settings is hidden too: the link reads them when it starts.
	_ = os.WriteFile(filepath.Join(l.dir, "settings.json"), []byte(`{"GITHUB_TOKEN":"ghp_ALSO-NEVER-ON-THE-PHONE"}`), 0o600)
	l.run("/phone new")
	waitFor(t, func() bool { return l.relay.Computer(l.secret(t).Room()) }, "did not rejoin")
	l.phone = phonetest.NewPhone(t, l.relay.URL(), l.secret(t))
	l.pump(t, func() bool { return l.m.link != nil && l.m.link.phones == 1 }, "the phone did not rejoin")
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "go"})
	l.m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_call", ToolCallID: "c1", ToolName: "run_command", Arguments: map[string]any{"command": "env"}}))
	// The command printed the key, as `env` would: the terminal shows it; the phone must not get it.
	l.m.Update(runtimeMsg(acp.RuntimeEvent{Type: "tool_result", ToolCallID: "c1", ToolName: "run_command", Content: "exit 0\nOPENROUTER_API_KEY=sk-or-v1-NEVER-ON-THE-PHONE\nGITHUB_TOKEN=ghp_ALSO-NEVER-ON-THE-PHONE\nHOME=/home/x"}))
	v := l.drain(t)
	if tool := lastItem(v.state, "tool"); tool == nil || !strings.Contains(tool["text"].(string), "HOME=/home/x") {
		t.Fatalf("the rest of the output should still be there: %v", tool)
	}
	secret := l.secret(t).Encode()
	for _, m := range v.all {
		raw := normal(m)
		if strings.Contains(raw, secret) || strings.Contains(raw, "NEVER-ON-THE-PHONE") || strings.Contains(raw, "ALSO-NEVER") {
			t.Fatalf("a message carries a secret: %.300s", raw)
		}
	}
	for _, raw := range l.relay.Seen() {
		if strings.Contains(string(raw), secret) {
			t.Fatal("the relay saw the pairing secret")
		}
	}
}

func itoa(n int) string { b, _ := json.Marshal(n); return string(b) }

// diffJSON is what a has that b lacks, part by part.
func diffJSON(a, b map[string]any) string {
	var out []string
	for k, v := range a {
		if normal(v) != normal(b[k]) {
			out = append(out, k+"="+normal(v))
		}
	}
	slices.Sort(out)
	return strings.Join(out, " ; ")
}

// BEHAVIOUR: a message sent from the phone while Friday works goes into the running turn after the
// steer delay, as one typed at the terminal does, and the phone sees it leave the queue and join the
// conversation.
func TestAMessageFromThePhoneDuringATurnReachesTheTurn(t *testing.T) {
	l := newLinked(t)
	l.hello(t)
	l.ask(t, map[string]any{"type": "send", "text": "first"})
	l.ask(t, map[string]any{"type": "send", "text": "use tabs, not spaces"})
	l.pump(t, func() bool {
		l.agent.mu.Lock()
		defer l.agent.mu.Unlock()
		return slices.Contains(l.agent.steered, "use tabs, not spaces")
	}, "the phone's message never reached the running turn")
	v := l.drain(t)
	if q, _ := v.state["queue"].([]any); len(q) != 0 {
		t.Fatalf("the phone still shows it queued: %v", q)
	}
	if u := lastItem(v.state, "user"); u == nil || u["text"] != "use tabs, not spaces" {
		t.Fatalf("the phone does not show it in the conversation: %v", itemsOf(v.state))
	}
}
