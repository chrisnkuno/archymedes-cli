package tui

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/phone"
)

// The phone link (docs/engine/PHONE_PROTOCOL.md): once paired (/phone), Friday keeps a sealed link
// to the person's phone through the relay. The phone is shown the session (link_view.go) and may
// ask what the terminal may (link_requests.go). This file is the link's life: starting it from the
// pairing kept on disk, hearing the relay, sending in order, and keeping the computer awake while
// someone works from afar.

const (
	// linkEvery is the least time between two messages to the phone: bursts of streaming text
	// become one patch.
	linkEvery = 250 * time.Millisecond
	// linkItemText is the most of one item's text the phone is sent: its end.
	linkItemText = 4000
)

// linkPage is the phone page, without the secret: what a push opens.
const linkPage = "https://archymedes.xyz/phone"

// linkAwaker keeps the computer awake (phone.Awake; a fake in tests).
type linkAwaker interface {
	Hold()
	Release()
	Close()
}

// linkState is a running link.
type linkState struct {
	gen    int // which start this is: messages from a link stopped since are ignored
	secret phone.Secret
	client *phone.Client
	cancel context.CancelFunc
	out    chan []byte // to the phone, in order (sent by one goroutine)
	phones int
	online bool

	rev       int
	full      bool // the next message is a whole state (a phone said hello, resync, or an item went)
	lastFlush time.Time
	ticking   bool
	ids       map[item]string
	versions  map[string]uint64 // each item's hash as last sent
	sent      []string          // item ids the phone has, in order
	parts     map[string]string // each top-level part as last sent, as JSON
	nextID    int
	approvals map[*approval]string
	secrets   []string // values never sent: keys and tokens from the environment and settings
}

// Messages from the link's goroutines; each carries its start's gen, so an old link's are ignored.
type (
	linkRequestMsg struct {
		gen int
		raw json.RawMessage
	}
	linkPhonesMsg struct {
		gen, n int
	}
	linkOnlineMsg struct {
		gen int
		up  bool
	}
	linkReplacedMsg struct{ gen int }
	linkTickMsg     struct{}
)

// linkGen numbers link starts.
var linkGen int

// linkRelay is the relay's base: ARCHYMEDES_PHONE_RELAY (a relay of your own, or a test's), else
// Friday's own.
func (m *Model) linkRelay() string {
	if r := strings.TrimSpace(os.Getenv("ARCHYMEDES_PHONE_RELAY")); r != "" {
		return strings.TrimRight(r, "/")
	}
	return phone.DefaultRelay
}

// linkStart joins the relay for a pairing.
func (m *Model) linkStart(s phone.Secret) {
	m.linkStop()
	m.linkTried = true // a pairing in hand: the one on disk is not started again
	linkGen++
	gen := linkGen
	l := &linkState{gen: gen, secret: s, out: make(chan []byte, 256), ids: map[item]string{}, versions: map[string]uint64{},
		parts: map[string]string{}, approvals: map[*approval]string{}, full: true, secrets: knownSecrets(m.opts.ConfigDir)}
	send := m.sender
	if send == nil {
		send = func(tea.Msg) {}
	}
	l.client = phone.NewClient(s, m.linkRelay(), phone.Handler{
		Message:  func(raw json.RawMessage) { send(linkRequestMsg{gen, raw}) },
		Phones:   func(n int) { send(linkPhonesMsg{gen, n}) },
		Online:   func(up bool) { send(linkOnlineMsg{gen, up}) },
		Replaced: func() { send(linkReplacedMsg{gen}) },
	})
	ctx, cancel := context.WithCancel(context.Background())
	l.cancel = cancel
	go l.client.Run(ctx)
	go func() { // one sender, so the phone gets messages in the order they were made
		for {
			select {
			case <-ctx.Done():
				return
			case raw := <-l.out:
				_ = l.client.Send(raw) // offline: dropped; a phone that comes back asks for the state
			}
		}
	}()
	m.link = l
}

// linkStop leaves the relay; the pairing stays on disk.
func (m *Model) linkStop() {
	if m.link != nil {
		m.link.cancel()
		m.link = nil
	}
	if m.linkAwake != nil {
		m.linkAwake.Release()
	}
}

// linkMsg handles the link's messages.
func (m *Model) linkMsg(msg tea.Msg) (tea.Cmd, bool) {
	l := m.link
	switch msg := msg.(type) {
	case linkRequestMsg:
		if l == nil || msg.gen != l.gen {
			return nil, true
		}
		return m.linkRequest(msg.raw), true
	case linkPhonesMsg:
		if l != nil && msg.gen == l.gen {
			l.phones = msg.n
			if msg.n == 0 {
				l.full = true
			}
		}
		return nil, true
	case linkOnlineMsg:
		if l != nil && msg.gen == l.gen {
			l.online, l.full = msg.up, true // back after a drop: the phones may have missed patches
			if !msg.up {
				l.phones = 0
			}
		}
		return nil, true
	case linkReplacedMsg:
		if l != nil && msg.gen == l.gen {
			m.linkStop()
			return m.toast(toastWarn, "Another Friday took the phone link; /phone here takes it back"), true
		}
		return nil, true
	case linkTickMsg:
		if l != nil {
			l.ticking = false
		}
		return nil, true
	}
	return nil, false
}

// linkAfter runs after every message: it starts the link from a pairing kept on disk once the
// session is open, holds the computer awake while it is needed, and sends the phone what changed.
func (m *Model) linkAfter() tea.Cmd {
	if !m.linkTried && m.opts.ConfigDir != "" && m.session.ID != "" {
		m.linkTried = true
		if s, ok, err := phone.LoadPairing(m.opts.ConfigDir); ok && err == nil {
			m.linkStart(s)
		}
	}
	l := m.link
	m.linkKeepAwake()
	if l == nil || l.phones == 0 {
		return nil
	}
	if wait := linkEvery - time.Since(l.lastFlush); wait > 0 && !l.full {
		if l.ticking {
			return nil
		}
		l.ticking = true
		return tea.Tick(wait, func(time.Time) tea.Msg { return linkTickMsg{} })
	}
	if raw := m.linkMessage(); raw != nil {
		l.lastFlush = time.Now()
		m.linkSend(raw)
	}
	return nil
}

// linkSend queues a message for the phone; a full queue is dropped and the phone is sent the
// whole state next.
func (m *Model) linkSend(raw []byte) {
	select {
	case m.link.out <- raw:
	default:
		m.link.full = true
	}
}

// linkKeepAwake holds the computer awake while paired and someone may be working from afar: a
// phone is there, a turn runs, or an approval waits.
func (m *Model) linkKeepAwake() {
	if m.link == nil {
		if m.linkAwake != nil {
			m.linkAwake.Release()
		}
		return
	}
	if m.linkAwake == nil {
		a := phone.NewAwake()
		m.linkAwake = a
	}
	if m.link.phones > 0 || m.phase == busy || m.approval != nil {
		m.linkAwake.Hold()
	} else {
		m.linkAwake.Release()
	}
}

// linkAck answers a phone's request.
func (m *Model) linkAck(id string, ok bool, text string) {
	if m.link == nil {
		return
	}
	raw, _ := json.Marshal(map[string]any{"type": "ack", "of": id, "ok": ok, "text": text})
	m.linkSend(raw)
}
