package tui

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// --- Invariants: what the gate accepts. ---

func TestAPhoneReplyIsAcceptedOnlyWithItsOwnTokenOnce(t *testing.T) {
	g := newPhoneGate()
	id, tokens := g.mint([]string{"allow", "deny"})
	if len(tokens) != 2 || tokens["allow"] == "" || tokens["allow"] == tokens["deny"] {
		t.Fatalf("tokens %v", tokens)
	}
	allow := phoneReplyBody(id, "allow", tokens["allow"])

	other := newPhoneGate() // another session: its own secret
	otherID, otherTokens := other.mint([]string{"allow", "deny"})

	refused := map[string]string{
		"empty":                             "",
		"not a reply":                       "hello from the topic",
		"missing token":                     "friday " + id + " allow",
		"bad token":                         phoneReplyBody(id, "allow", strings.Repeat("0", len(tokens["allow"]))),
		"a token cut short":                 phoneReplyBody(id, "allow", tokens["allow"][:10]),
		"allow's token used to deny":        phoneReplyBody(id, "deny", tokens["allow"]),
		"deny's token used to allow":        phoneReplyBody(id, "allow", tokens["deny"]),
		"a choice never offered":            phoneReplyBody(id, "allow_always", g.token(id, "allow_always")),
		"another session's prompt":          phoneReplyBody(otherID, "allow", otherTokens["allow"]),
		"another session's token, our id":   phoneReplyBody(id, "allow", otherTokens["allow"]),
		"an id nobody minted":               phoneReplyBody("feedface", "allow", g.token("feedface", "allow")),
		"extra words":                       allow + " please",
		"the right token in the wrong case": phoneReplyBody(id, "allow", strings.ToUpper(tokens["allow"])),
	}
	for name, body := range refused {
		if _, _, ok := g.accept(body); ok {
			t.Errorf("%s: accepted %q", name, body)
		}
	}
	gotID, choice, ok := g.accept(allow)
	if !ok || gotID != id || choice != "allow" {
		t.Fatalf("the real reply: %q %q %v", gotID, choice, ok)
	}
	if _, _, ok := g.accept(allow); ok {
		t.Fatal("a reply was accepted twice")
	}
	if _, _, ok := g.accept(phoneReplyBody(id, "deny", tokens["deny"])); ok {
		t.Fatal("the other button still answered a prompt already answered")
	}
}

func TestAPromptAnsweredHereLeavesThePhoneButtonsStale(t *testing.T) {
	g := newPhoneGate()
	id, tokens := g.mint([]string{"allow", "deny"})
	if g.waiting() != 1 {
		t.Fatalf("waiting %d", g.waiting())
	}
	g.forget(id)
	if g.waiting() != 0 {
		t.Fatalf("waiting %d after forget", g.waiting())
	}
	if _, _, ok := g.accept(phoneReplyBody(id, "allow", tokens["allow"])); ok {
		t.Fatal("a stale button answered")
	}
}

func TestTheReplyTopicIsBesideThePushTopic(t *testing.T) {
	for push, want := range map[string][2]string{
		"https://ntfy.sh/friday-abc":                  {"https://ntfy.sh/friday-abc-reply", "https://ntfy.sh/friday-abc-reply/json"},
		"https://ntfy.example.org/team/topic/":        {"https://ntfy.example.org/team/topic-reply", "https://ntfy.example.org/team/topic-reply/json"},
		"https://ntfy.example.org/topic?auth=QmFzaWM": {"https://ntfy.example.org/topic-reply?auth=QmFzaWM", "https://ntfy.example.org/topic-reply/json?auth=QmFzaWM"},
	} {
		reply, stream, ok := phoneTopics(push)
		if !ok || reply != want[0] || stream != want[1] {
			t.Errorf("%s: %q %q %v", push, reply, stream, ok)
		}
	}
	for _, push := range []string{"", "https://ntfy.sh", "https://ntfy.sh/", "ftp://x/y", "not a url"} {
		if _, _, ok := phoneTopics(push); ok {
			t.Errorf("%q gave a reply topic", push)
		}
	}
}

// --- Behaviour: what the model does with it. ---

// ntfy is a fake ntfy server: it records what was published to each topic and streams a topic's
// new messages as JSON lines, the way ntfy's /<topic>/json does.
type ntfy struct {
	mu        sync.Mutex
	published []published
	listeners map[string][]chan string
	streams   int // open subscriptions
	srv       *httptest.Server
}

type published struct {
	topic, body, title, actions, click string
}

func newNtfy(t *testing.T) *ntfy {
	n := &ntfy{listeners: map[string][]chan string{}}
	n.srv = httptest.NewServer(http.HandlerFunc(n.serve))
	t.Cleanup(n.srv.Close)
	return n
}

func (n *ntfy) serve(w http.ResponseWriter, r *http.Request) {
	path := strings.TrimPrefix(r.URL.Path, "/")
	if topic, ok := strings.CutSuffix(path, "/json"); ok && r.Method == http.MethodGet {
		ch := make(chan string, 8)
		n.mu.Lock()
		n.listeners[topic] = append(n.listeners[topic], ch)
		n.streams++
		n.mu.Unlock()
		defer func() {
			n.mu.Lock()
			n.streams--
			n.mu.Unlock()
		}()
		w.Header().Set("Content-Type", "application/x-ndjson")
		fmt.Fprintln(w, `{"event":"open","topic":"`+topic+`"}`)
		w.(http.Flusher).Flush()
		for {
			select {
			case body := <-ch:
				line, _ := json.Marshal(map[string]string{"event": "message", "topic": topic, "message": body})
				fmt.Fprintln(w, string(line))
				w.(http.Flusher).Flush()
			case <-r.Context().Done():
				return
			}
		}
	}
	body, _ := io.ReadAll(r.Body)
	n.mu.Lock()
	n.published = append(n.published, published{topic: path, body: string(body), title: r.Header.Get("Title"), actions: r.Header.Get("Actions"), click: r.Header.Get("Click")})
	listeners := n.listeners[path]
	n.mu.Unlock()
	for _, ch := range listeners {
		select {
		case ch <- string(body):
		default:
		}
	}
}

func (n *ntfy) last(t *testing.T, topic string) published {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		n.mu.Lock()
		for i := len(n.published) - 1; i >= 0; i-- {
			if n.published[i].topic == topic {
				p := n.published[i]
				n.mu.Unlock()
				return p
			}
		}
		n.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("nothing published to %s", topic)
	return published{}
}

func (n *ntfy) open() int {
	n.mu.Lock()
	defer n.mu.Unlock()
	return n.streams
}

// phoneButton is one ntfy action as the notification carried it.
type phoneAction struct {
	Action, Label, URL, Method, Body string
	Clear                            bool
}

func actionsOf(t *testing.T, header string) []phoneAction {
	t.Helper()
	if header == "" {
		return nil
	}
	for _, r := range header {
		if r > 0x7e {
			t.Fatalf("the Actions header is not plain ASCII: %q", header)
		}
	}
	var actions []phoneAction
	if err := json.Unmarshal([]byte(header), &actions); err != nil {
		t.Fatalf("Actions %q: %v", header, err)
	}
	return actions
}

// phoneModel is a model whose terminal is not looked at, pushing to the fake ntfy, with a sender
// that collects what the phone listener delivers.
func phoneModel(t *testing.T, n *ntfy) (*Model, chan tea.Msg) {
	t.Helper()
	t.Setenv("ARCHYMEDES_NOTIFY_URL", n.srv.URL+"/friday-topic")
	t.Setenv("ARCHYMEDES_NOTIFY", "")
	t.Setenv("ARCHYMEDES_NOTIFY_REPLIES", "on")
	m, _ := newTestModel(t)
	got := make(chan tea.Msg, 16)
	m.SetSender(func(msg tea.Msg) {
		select {
		case got <- msg:
		default:
		}
	})
	m.Update(tea.BlurMsg{})
	t.Cleanup(m.stopPhone)
	return m, got
}

var approvalOptions = []acp.PermissionOption{
	{OptionID: "allow", Name: "Allow"}, {OptionID: "allow_always", Name: "Allow this action from now on"},
	{OptionID: "deny", Name: "Deny"}, {OptionID: "deny_always", Name: "Deny this action from now on"},
}

// answers records what the agent was told.
type answers struct {
	mu  sync.Mutex
	got []string
}

func (a *answers) answer(s string) { a.mu.Lock(); a.got = append(a.got, s); a.mu.Unlock() }
func (a *answers) all() string     { a.mu.Lock(); defer a.mu.Unlock(); return strings.Join(a.got, "|") }

func ask(m *Model, id string, risk []string, to *answers) tea.Cmd {
	req := acp.NewPermissionRequestForTest(acp.ToolCallRef{ToolCallID: id, Title: "run rm -rf build"}, approvalOptions, to.answer)
	req.Risk = risk
	_, cmd := m.Update(agentMsg{msg: req})
	return cmd
}

func TestAnApprovalOnThePhoneHasAllowAndDeny(t *testing.T) {
	n := newNtfy(t)
	m, _ := phoneModel(t, n)
	var to answers
	runAll(ask(m, "c1", nil, &to))
	p := n.last(t, "friday-topic")
	if p.body != "Friday needs your approval in project" {
		t.Fatalf("body %q", p.body)
	}
	actions := actionsOf(t, p.actions)
	if len(actions) != 2 || actions[0].Label != "Allow" || actions[1].Label != "Deny" {
		t.Fatalf("actions %+v", actions)
	}
	for _, a := range actions {
		if a.Action != "http" || a.Method != "POST" || a.URL != n.srv.URL+"/friday-topic-reply" || !a.Clear {
			t.Errorf("action %+v", a)
		}
		if strings.Contains(a.Body, "rm -rf") {
			t.Errorf("a button named the command: %q", a.Body)
		}
	}
	if _, choice, ok := m.notifier.phone.gate.accept(actions[0].Body); !ok || choice != "allow" {
		t.Fatalf("the Allow button's body does not allow: %q", actions[0].Body)
	}
}

func TestARiskyApprovalSaysItsRiskOnThePhone(t *testing.T) {
	n := newNtfy(t)
	m, _ := phoneModel(t, n)
	var to answers
	runAll(ask(m, "c1", []string{"deployment or package publication command"}, &to))
	p := n.last(t, "friday-topic")
	if p.body != "Risky: deployment or package publication command. Friday needs your approval in project" {
		t.Fatalf("body %q", p.body)
	}
	// A risky approval can be refused from the phone but only allowed at the terminal, where the
	// command can be read.
	if got := actionsOf(t, p.actions); len(got) != 1 || got[0].Label != "Deny" {
		t.Fatalf("a risky approval's buttons = %+v, want Deny alone", got)
	}
}

// Answers from the phone are a choice the person makes: a push URL set for one-way notices does
// not start taking answers after an upgrade.
func TestPhoneRepliesAreOffUntilTurnedOn(t *testing.T) {
	n := newNtfy(t)
	m, _ := phoneModel(t, n)
	t.Setenv("ARCHYMEDES_NOTIFY_REPLIES", "")
	var to answers
	runAll(ask(m, "c1", nil, &to))
	if p := n.last(t, "friday-topic"); p.body == "" || p.actions != "" {
		t.Fatalf("push %+v: buttons without ARCHYMEDES_NOTIFY_REPLIES=on", p)
	}
}

func TestAQuestionOnThePhoneHasAButtonPerOptionUpToThree(t *testing.T) {
	cases := []struct {
		name    string
		options []string
		multi   bool
		want    int
	}{
		{"two", []string{"Postgres", "SQLite"}, false, 2},
		{"three, one not ASCII", []string{"Postgres", "SQLite", "Café"}, false, 3},
		{"four is too many", []string{"a", "b", "c", "d"}, false, 0},
		{"several at once", []string{"a", "b"}, true, 0},
		{"no options", nil, false, 0},
	}
	for _, c := range cases {
		n := newNtfy(t)
		m, _ := phoneModel(t, n)
		_, cmd := m.Update(agentMsg{msg: acp.NewQuestionRequestForTest("Which database?", c.options, c.multi, func(string) {})})
		runAll(cmd)
		p := n.last(t, "friday-topic")
		actions := actionsOf(t, p.actions)
		if len(actions) != c.want {
			t.Errorf("%s: %d buttons, want %d", c.name, len(actions), c.want)
		}
		for i, a := range actions {
			if a.Label != c.options[i] {
				t.Errorf("%s: button %d is %q", c.name, i, a.Label)
			}
		}
	}
}

func TestPhoneRepliesCanBeTurnedOffKeepingThePush(t *testing.T) {
	n := newNtfy(t)
	m, _ := phoneModel(t, n)
	t.Setenv("ARCHYMEDES_NOTIFY_REPLIES", "off")
	var to answers
	runAll(ask(m, "c1", nil, &to))
	p := n.last(t, "friday-topic")
	if p.body == "" || p.actions != "" {
		t.Fatalf("push %+v", p)
	}
	if m.notifier.phone.gate != nil && m.notifier.phone.gate.waiting() != 0 {
		t.Fatal("a prompt waits for a phone that may not answer")
	}
}

func TestAnAnswerHereMakesThePhoneButtonsStale(t *testing.T) {
	n := newNtfy(t)
	m, _ := phoneModel(t, n)
	var to answers
	runAll(ask(m, "c1", nil, &to))
	allow := actionsOf(t, n.last(t, "friday-topic").actions)[0].Body
	m.Update(tea.KeyPressMsg{Code: 'n', Text: "n"})
	m.Update(phoneReplyMsg{body: allow})
	if to.all() != "deny" {
		t.Fatalf("the agent heard %q", to.all())
	}
	if m.notifier.phone.gate.waiting() != 0 || m.notifier.phone.cancel != nil {
		t.Fatal("still listening for the phone after the answer")
	}
}

func TestAnApprovalAnsweredFromThePhone(t *testing.T) {
	n := newNtfy(t)
	m, _ := phoneModel(t, n)
	card := &toolItem{id: "c1", name: "run_command", args: map[string]any{"command": "rm -rf build"}}
	m.tools["c1"] = card
	m.tr.add(card)
	var first, second answers
	runAll(ask(m, "c1", nil, &first))
	allowFirst := actionsOf(t, n.last(t, "friday-topic").actions)[0].Body
	runAll(ask(m, "c2", nil, &second))
	denySecond := actionsOf(t, n.last(t, "friday-topic").actions)[1].Body

	// The one waiting behind the dialog can be answered too; the one on screen stays.
	m.Update(phoneReplyMsg{body: denySecond})
	if second.all() != "deny" || m.approval == nil || len(m.approvals) != 0 {
		t.Fatalf("second %q, on screen %v, queued %d", second.all(), m.approval != nil, len(m.approvals))
	}
	m.Update(phoneReplyMsg{body: allowFirst})
	m.Update(phoneReplyMsg{body: allowFirst})
	if first.all() != "allow" || m.approval != nil {
		t.Fatalf("first %q, on screen %v", first.all(), m.approval != nil)
	}
	if !strings.Contains(screen(m), "answered from your phone: Allow") {
		t.Fatalf("the card does not say so:\n%s", screen(m))
	}
}

func TestAQuestionAnsweredFromThePhone(t *testing.T) {
	n := newNtfy(t)
	m, _ := phoneModel(t, n)
	var to answers
	_, cmd := m.Update(agentMsg{msg: acp.NewQuestionRequestForTest("Which database?", []string{"Postgres", "SQLite"}, false, to.answer)})
	runAll(cmd)
	sqlite := actionsOf(t, n.last(t, "friday-topic").actions)[1].Body
	m.Update(phoneReplyMsg{body: sqlite})
	if to.all() != "SQLite" || m.approval != nil {
		t.Fatalf("answer %q", to.all())
	}
}

// --- Function: an approval answered from the phone, through a fake ntfy server. ---

func TestAnApprovalTravelsToThePhoneAndBack(t *testing.T) {
	n := newNtfy(t)
	m, delivered := phoneModel(t, n)
	var to answers
	runAll(ask(m, "c1", nil, &to))
	p := n.last(t, "friday-topic")
	allow := actionsOf(t, p.actions)[0]

	// Someone else on the topic posts a forged reply first; it changes nothing.
	waitFor(t, func() bool { return n.open() == 1 }, "Friday never subscribed to the reply topic")
	post(t, allow.URL, phoneReplyBody("feedface", "allow", strings.Repeat("ab", 32)))
	// The phone's Allow button.
	post(t, allow.URL, allow.Body)

	for done := false; !done; {
		select {
		case msg := <-delivered:
			m.Update(msg)
			done = to.all() != ""
		case <-time.After(5 * time.Second):
			t.Fatal("the phone's answer never arrived")
		}
	}
	if to.all() != "allow" || m.approval != nil {
		t.Fatalf("the agent heard %q", to.all())
	}
	waitFor(t, func() bool { return n.open() == 0 }, "still subscribed with nothing waiting")
}

func TestThePhoneListenerReconnects(t *testing.T) {
	old := phoneBackoff
	phoneBackoff = 10 * time.Millisecond
	t.Cleanup(func() { phoneBackoff = old })
	var mu sync.Mutex
	connects := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		connects++
		c := connects
		mu.Unlock()
		if !strings.Contains(r.URL.RawQuery, "since=") {
			t.Errorf("no since= in %q: a reply sent while away would be lost", r.URL.RawQuery)
		}
		if c < 3 {
			if c == 1 {
				w.WriteHeader(http.StatusBadGateway)
			}
			return // the connection drops
		}
		fmt.Fprintln(w, `{"event":"keepalive"}`)
		fmt.Fprintln(w, `{"event":"message","message":"hello"}`)
	}))
	t.Cleanup(srv.Close)
	got := make(chan tea.Msg, 4)
	stop := listenPhone(srv.URL+"/t-reply/json", func(msg tea.Msg) {
		select {
		case got <- msg:
		default:
		}
	})
	defer stop()
	select {
	case msg := <-got:
		if r, ok := msg.(phoneReplyMsg); !ok || r.body != "hello" {
			t.Fatalf("%#v", msg)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("never reconnected")
	}
}

func post(t *testing.T, url, body string) {
	t.Helper()
	resp, err := http.Post(url, "text/plain", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
}

func waitFor(t *testing.T, cond func() bool, why string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal(why)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
