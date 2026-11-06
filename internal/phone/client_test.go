package phone_test

import (
	"context"
	"encoding/json"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/phone"
	"github.com/chrisnkuno/friday-cli/internal/phone/phonetest"
)

// The computer's end of the link: it joins the relay room as the computer, opens what phones seal,
// seals what it sends, says who is there, and keeps the link up through drops, never acting on
// anything the relay says itself.

type heard struct {
	mu       sync.Mutex
	messages []string
	phones   []int
	replaced bool
}

func (h *heard) handler() phone.Handler {
	return phone.Handler{
		Message:  func(m json.RawMessage) { h.mu.Lock(); h.messages = append(h.messages, string(m)); h.mu.Unlock() },
		Phones:   func(n int) { h.mu.Lock(); h.phones = append(h.phones, n); h.mu.Unlock() },
		Replaced: func() { h.mu.Lock(); h.replaced = true; h.mu.Unlock() },
	}
}

func (h *heard) all() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.messages...)
}

func (h *heard) lastPhones() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.phones) == 0 {
		return -1
	}
	return h.phones[len(h.phones)-1]
}

func waitFor(t *testing.T, cond func() bool, what string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatal(what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func start(t *testing.T, relay *phonetest.Relay, s phone.Secret, h *heard) (*phone.Client, context.CancelFunc, chan struct{}) {
	t.Helper()
	c := phone.NewClient(s, relay.URL(), h.handler())
	c.BackoffMin, c.BackoffMax = 20*time.Millisecond, 200*time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { c.Run(ctx); close(done) }()
	waitFor(t, func() bool { return relay.Computer(s.Room()) }, "the computer never joined the room")
	t.Cleanup(func() { cancel(); <-done })
	return c, cancel, done
}

// FUNCTIONAL: a phone's sealed request reaches the computer opened; the computer's message
// reaches the phone, which opens it; the relay saw neither in the clear.
func TestAMessageCrossesTheRelayBothWaysSealed(t *testing.T) {
	relay := phonetest.NewRelay(t)
	s, _ := phone.NewSecret()
	var h heard
	c, _, _ := start(t, relay, s, &h)
	p := phonetest.NewPhone(t, relay.URL(), s)

	p.Send(map[string]any{"type": "hello", "device": "test phone with a secret-word"})
	waitFor(t, func() bool { return len(h.all()) == 1 }, "the computer never heard the phone")
	if !strings.Contains(h.all()[0], `"type":"hello"`) {
		t.Fatalf("heard %q", h.all()[0])
	}
	if err := c.Send([]byte(`{"type":"state","rev":1,"items":[{"text":"another-secret-word"}]}`)); err != nil {
		t.Fatal(err)
	}
	if m := p.Next("state", 5*time.Second); m == nil || m["rev"] != float64(1) {
		t.Fatalf("the phone got %v", m)
	}
	for _, raw := range relay.Seen() {
		if strings.Contains(string(raw), "secret-word") {
			t.Fatalf("the relay read a message: %s", raw)
		}
	}
}

// BEHAVIOUR: the computer hears how many phones are in the room as they come and go.
func TestTheComputerHearsPhonesComeAndGo(t *testing.T) {
	relay := phonetest.NewRelay(t)
	s, _ := phone.NewSecret()
	var h heard
	start(t, relay, s, &h)
	one := phonetest.NewPhone(t, relay.URL(), s)
	waitFor(t, func() bool { return h.lastPhones() == 1 }, "one phone not counted")
	two := phonetest.NewPhone(t, relay.URL(), s)
	waitFor(t, func() bool { return h.lastPhones() == 2 }, "two phones not counted")
	one.Close()
	two.Close()
	waitFor(t, func() bool { return h.lastPhones() == 0 }, "phones leaving not counted")
}

// INVARIANT: nothing the relay says itself is ever taken as a message: plain JSON that looks like
// a request, a frame sealed for the other direction, garbage, an oversized frame.
func TestTheComputerActsOnNothingTheRelaySays(t *testing.T) {
	relay := phonetest.NewRelay(t)
	s, _ := phone.NewSecret()
	var h heard
	c, _, _ := start(t, relay, s, &h)
	toPhone, _ := phone.NewSealer(s, phone.ToPhone)
	reflected, _ := toPhone.Seal([]byte(`{"type":"send","text":"reflected"}`))
	reflectedWire, _ := json.Marshal(reflected)
	for _, raw := range []string{
		`{"type":"send","id":"x","text":"rm -rf /"}`,
		`{"type":"answer","approval":"a1","choice":"allow"}`,
		string(reflectedWire),
		`{"v":1,"e":"AAAAAAAAAAA","n":1,"c":"AAAA"}`,
		`not json at all`,
		`{"relay":"phones","count":"lots"}`,
	} {
		relay.Inject(s.Room(), raw)
	}
	// A real one after them still arrives, so the link survived the junk.
	p := phonetest.NewPhone(t, relay.URL(), s)
	p.Send(map[string]any{"type": "resync"})
	waitFor(t, func() bool { return len(h.all()) == 1 }, "the real request did not arrive after the junk")
	if got := h.all(); !strings.Contains(got[0], "resync") {
		t.Fatalf("the computer took relay text as a message: %q", got)
	}
	_ = c
}

// BEHAVIOUR: when the relay drops the link, the computer joins again by itself, under a new epoch,
// and messages flow both ways again.
func TestTheLinkComesBackAfterTheRelayDropsIt(t *testing.T) {
	relay := phonetest.NewRelay(t)
	s, _ := phone.NewSecret()
	var h heard
	c, _, _ := start(t, relay, s, &h)
	relay.Drop(s.Room())
	waitFor(t, func() bool { return relay.Computer(s.Room()) }, "the computer did not join again")
	p := phonetest.NewPhone(t, relay.URL(), s)
	p.Send(map[string]any{"type": "hello"})
	waitFor(t, func() bool { return len(h.all()) == 1 }, "no message after coming back")
	waitFor(t, func() bool { return c.Send([]byte(`{"type":"notice","text":"back"}`)) == nil }, "could not send after coming back")
	if m := p.Next("notice", 5*time.Second); m == nil {
		t.Fatal("the phone did not hear the computer after it came back")
	}
}

// BEHAVIOUR: a computer replaced by a newer one in the same room stops, rather than fighting for
// the room in a loop.
func TestAReplacedComputerStopsInsteadOfFighting(t *testing.T) {
	relay := phonetest.NewRelay(t)
	s, _ := phone.NewSecret()
	var first, second heard
	_, _, done := start(t, relay, s, &first)
	start(t, relay, s, &second)
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("the replaced computer kept running")
	}
	first.mu.Lock()
	replaced := first.replaced
	first.mu.Unlock()
	if !replaced {
		t.Fatal("the replaced computer was not told why it stopped")
	}
	time.Sleep(300 * time.Millisecond) // longer than the backoff: a fight would show by now
	if !relay.Computer(s.Room()) {
		t.Fatal("the room lost its computer")
	}
}

// BEHAVIOUR: sending with no link is refused at once, never blocked.
func TestSendingWithoutALinkIsRefusedAtOnce(t *testing.T) {
	s, _ := phone.NewSecret()
	c := phone.NewClient(s, "ws://127.0.0.1:1", phone.Handler{})
	began := time.Now()
	if err := c.Send([]byte(`{}`)); err == nil {
		t.Fatal("sent with no link")
	}
	if time.Since(began) > 100*time.Millisecond {
		t.Fatal("sending without a link blocked")
	}
}

// INVARIANT: stopping leaves no goroutine behind, linked or still trying to link.
func TestStoppingLeavesNothingRunning(t *testing.T) {
	before := runtime.NumGoroutine()
	relay := phonetest.NewRelay(t)
	for range 5 {
		s, _ := phone.NewSecret()
		var h heard
		c := phone.NewClient(s, relay.URL(), h.handler())
		ctx, cancel := context.WithCancel(context.Background())
		done := make(chan struct{})
		go func() { c.Run(ctx); close(done) }()
		waitFor(t, func() bool { return relay.Computer(s.Room()) }, "did not join")
		cancel()
		<-done
		unreachable := phone.NewClient(s, "ws://127.0.0.1:1", h.handler())
		unreachable.BackoffMin = 5 * time.Millisecond
		ctx2, cancel2 := context.WithCancel(context.Background())
		done2 := make(chan struct{})
		go func() { unreachable.Run(ctx2); close(done2) }()
		time.Sleep(30 * time.Millisecond)
		cancel2()
		<-done2
	}
	waitFor(t, func() bool { return runtime.NumGoroutine() <= before+8 }, "goroutines left running after stop")
}

// INVARIANT: the wait between tries starts at the minimum, never falls, never passes the maximum.
func TestTheWaitBetweenTriesIsBounded(t *testing.T) {
	c := phone.NewClient(phone.Secret{}, "", phone.Handler{})
	c.BackoffMin, c.BackoffMax = time.Second, 30*time.Second
	prev := time.Duration(0)
	for i := range 50 {
		d := c.Backoff(i)
		if d < c.BackoffMin || d > c.BackoffMax || d < prev {
			t.Fatalf("try %d waits %v (after %v)", i, d, prev)
		}
		prev = d
	}
	if c.Backoff(0) != time.Second || c.Backoff(49) != 30*time.Second {
		t.Fatalf("first %v, last %v", c.Backoff(0), c.Backoff(49))
	}
}
