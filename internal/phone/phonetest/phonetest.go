// Package phonetest is a relay and a phone for tests: the relay keeps the rules of
// docs/engine/PHONE_PROTOCOL.md (one computer, four phones, forwarding only, presence notes, the
// size and rate limits), and the phone seals and opens as the real page does.
package phonetest

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"github.com/chrisnkuno/friday-cli/internal/phone"
)

// Relay is an in-process relay. Every frame it forwards is kept in Seen, so tests can check what
// the relay could read.
type Relay struct {
	srv *httptest.Server
	mu  sync.Mutex
	// rooms: each room's computer and phones.
	rooms map[string]*room
	seen  [][]byte
	// MaxMessage and PerSecond are the limits; zero keeps the protocol's.
	MaxMessage, PerSecond int
}

type room struct {
	computer *websocket.Conn
	phones   map[*websocket.Conn]bool
}

// NewRelay starts a relay, closed when the test ends.
func NewRelay(t testing.TB) *Relay {
	r := &Relay{rooms: map[string]*room{}}
	r.srv = httptest.NewServer(http.HandlerFunc(r.serve))
	t.Cleanup(r.srv.Close)
	return r
}

// URL is the relay's base, as ARCHYMEDES_PHONE_RELAY takes it.
func (r *Relay) URL() string { return "ws" + strings.TrimPrefix(r.srv.URL, "http") }

// Seen is every message the relay forwarded, as the relay saw it.
func (r *Relay) Seen() [][]byte {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([][]byte(nil), r.seen...)
}

// Phones is how many phones are in a room.
func (r *Relay) Phones(roomID string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	if rm := r.rooms[roomID]; rm != nil {
		return len(rm.phones)
	}
	return 0
}

// Computer is whether a computer is in a room.
func (r *Relay) Computer(roomID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	rm := r.rooms[roomID]
	return rm != nil && rm.computer != nil
}

// Drop closes every socket in a room, as a relay restart would.
func (r *Relay) Drop(roomID string) {
	r.mu.Lock()
	rm := r.rooms[roomID]
	var all []*websocket.Conn
	if rm != nil {
		if rm.computer != nil {
			all = append(all, rm.computer)
		}
		for p := range rm.phones {
			all = append(all, p)
		}
	}
	r.mu.Unlock()
	for _, c := range all {
		_ = c.Close(websocket.StatusGoingAway, "relay restarting")
	}
}

// Inject sends a raw text message to a room's computer, as a hostile relay could.
func (r *Relay) Inject(roomID string, raw string) {
	r.mu.Lock()
	rm := r.rooms[roomID]
	var c *websocket.Conn
	if rm != nil {
		c = rm.computer
	}
	r.mu.Unlock()
	if c != nil {
		_ = c.Write(context.Background(), websocket.MessageText, []byte(raw))
	}
}

func (r *Relay) serve(w http.ResponseWriter, req *http.Request) {
	roomID, ok := strings.CutPrefix(req.URL.Path, "/phone/relay/")
	role := req.URL.Query().Get("role")
	if !ok || len(roomID) != 22 || (role != "computer" && role != "phone") {
		http.Error(w, "no such room", http.StatusNotFound)
		return
	}
	c, err := websocket.Accept(w, req, nil)
	if err != nil {
		return
	}
	limit := r.MaxMessage
	if limit == 0 {
		limit = 400_000
	}
	c.SetReadLimit(int64(limit) + 1)
	ctx := context.Background()

	r.mu.Lock()
	rm := r.rooms[roomID]
	if rm == nil {
		rm = &room{phones: map[*websocket.Conn]bool{}}
		r.rooms[roomID] = rm
	}
	var replaced *websocket.Conn
	if role == "computer" {
		replaced, rm.computer = rm.computer, c
	} else {
		if len(rm.phones) >= 4 {
			r.mu.Unlock()
			_ = c.Close(4002, "room full")
			return
		}
		rm.phones[c] = true
	}
	phones := len(rm.phones)
	computer := rm.computer
	r.mu.Unlock()
	if replaced != nil {
		_ = replaced.Close(4001, "replaced by a newer computer")
	}
	r.presence(roomID, phones, computer)

	perSecond := r.PerSecond
	if perSecond == 0 {
		perSecond = 60
	}
	window, count := time.Now(), 0
	for {
		_, data, err := c.Read(ctx)
		if err != nil {
			break
		}
		if time.Since(window) > time.Second {
			window, count = time.Now(), 0
		}
		count++
		if len(data) > limit || count > perSecond {
			_ = c.Close(4003, "too much")
			break
		}
		r.mu.Lock()
		r.seen = append(r.seen, data)
		var to []*websocket.Conn
		if role == "computer" {
			for p := range rm.phones {
				to = append(to, p)
			}
		} else if rm.computer != nil {
			to = append(to, rm.computer)
		}
		r.mu.Unlock()
		for _, dst := range to {
			_ = dst.Write(ctx, websocket.MessageText, data)
		}
	}
	r.mu.Lock()
	if role == "computer" && rm.computer == c {
		rm.computer = nil
	}
	delete(rm.phones, c)
	phones, computer = len(rm.phones), rm.computer
	r.mu.Unlock()
	r.presence(roomID, phones, computer)
}

// presence tells the computer how many phones there are, and the phones whether it is there.
func (r *Relay) presence(roomID string, phones int, computer *websocket.Conn) {
	ctx := context.Background()
	if computer != nil {
		note, _ := json.Marshal(map[string]any{"relay": "phones", "count": phones})
		_ = computer.Write(ctx, websocket.MessageText, note)
	}
	r.mu.Lock()
	rm := r.rooms[roomID]
	var ps []*websocket.Conn
	for p := range rm.phones {
		ps = append(ps, p)
	}
	r.mu.Unlock()
	note, _ := json.Marshal(map[string]any{"relay": "computer", "online": computer != nil})
	for _, p := range ps {
		_ = p.Write(ctx, websocket.MessageText, note)
	}
}

// Phone is a phone as the page is: it seals to the computer and opens what comes back.
type Phone struct {
	t      testing.TB
	conn   *websocket.Conn
	sealer *phone.Sealer
	opener *phone.Opener
	in     chan map[string]any
	notes  chan map[string]any
	seq    int
}

// NewPhone joins the relay's room for secret.
func NewPhone(t testing.TB, relay string, s phone.Secret) *Phone {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, relay+"/phone/relay/"+s.Room()+"?role=phone", nil)
	if err != nil {
		t.Fatalf("phone could not join: %v", err)
	}
	conn.SetReadLimit(1 << 20)
	sealer, _ := phone.NewSealer(s, phone.ToComputer)
	opener, _ := phone.NewOpener(s, phone.ToPhone)
	p := &Phone{t: t, conn: conn, sealer: sealer, opener: opener, in: make(chan map[string]any, 256), notes: make(chan map[string]any, 64)}
	go p.read()
	t.Cleanup(func() { _ = conn.CloseNow() })
	return p
}

func (p *Phone) read() {
	for {
		_, data, err := p.conn.Read(context.Background())
		if err != nil {
			close(p.in)
			return
		}
		var plain map[string]any
		if json.Unmarshal(data, &plain) == nil && plain["relay"] != nil {
			p.notes <- plain
			continue
		}
		var f phone.Frame
		if json.Unmarshal(data, &f) != nil {
			continue
		}
		msg, err := p.opener.Open(f)
		if err != nil {
			continue
		}
		var m map[string]any
		if json.Unmarshal(msg, &m) == nil {
			p.in <- m
		}
	}
}

// Send seals a request (an id is added when it has none) and returns its id.
func (p *Phone) Send(request map[string]any) string {
	p.t.Helper()
	if request["id"] == nil {
		p.seq++
		request["id"] = "r" + itoa(p.seq)
	}
	raw, _ := json.Marshal(request)
	f, err := p.sealer.Seal(raw)
	if err != nil {
		p.t.Fatal(err)
	}
	wire, _ := json.Marshal(f)
	if err := p.conn.Write(context.Background(), websocket.MessageText, wire); err != nil {
		p.t.Fatalf("phone send: %v", err)
	}
	return request["id"].(string)
}

// Next is the next message from the computer of a type, within d; nil when none came.
func (p *Phone) Next(kind string, d time.Duration) map[string]any {
	deadline := time.After(d)
	for {
		select {
		case m, ok := <-p.in:
			if !ok {
				return nil
			}
			if kind == "" || m["type"] == kind {
				return m
			}
		case <-deadline:
			return nil
		}
	}
}

// Note is the next plain note from the relay, within d.
func (p *Phone) Note(d time.Duration) map[string]any {
	select {
	case n := <-p.notes:
		return n
	case <-time.After(d):
		return nil
	}
}

// Close leaves the room.
func (p *Phone) Close() { _ = p.conn.Close(websocket.StatusNormalClosure, "bye") }

func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}
