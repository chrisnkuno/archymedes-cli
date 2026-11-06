package phone

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// DefaultRelay is the relay Friday joins unless ARCHYMEDES_PHONE_RELAY names another.
const DefaultRelay = "wss://archymedes.xyz"

// Close codes the relay uses (docs/engine/PHONE_PROTOCOL.md).
const (
	closeReplaced = 4001
	closeTooMuch  = 4003
)

// Handler is what the computer's end does with what arrives. Each is called from the client's
// goroutine; nil ones are skipped.
type Handler struct {
	// Message is a request from a phone, opened.
	Message func(json.RawMessage)
	// Phones is how many phones are in the room, as the relay says.
	Phones func(int)
	// Online is whether the link to the relay is up.
	Online func(bool)
	// Replaced is a newer computer taking the room; Run returns after it.
	Replaced func()
}

// Client is the computer's end of the link.
type Client struct {
	secret Secret
	relay  string
	h      Handler
	// BackoffMin and BackoffMax bound the wait between tries to join.
	BackoffMin, BackoffMax time.Duration

	mu     sync.Mutex
	conn   *websocket.Conn
	sealer *Sealer
}

// NewClient is the computer's end for a pairing, joining the relay at base.
func NewClient(s Secret, base string, h Handler) *Client {
	return &Client{secret: s, relay: base, h: h, BackoffMin: time.Second, BackoffMax: 30 * time.Second}
}

// ErrOffline is a send with no link.
var ErrOffline = errors.New("the phone link is not up")

// Backoff is the wait before try n (from 0): it doubles from BackoffMin up to BackoffMax.
func (c *Client) Backoff(n int) time.Duration {
	d := c.BackoffMin
	for range n {
		if d >= c.BackoffMax/2 {
			return c.BackoffMax
		}
		d *= 2
	}
	return min(d, c.BackoffMax)
}

// Run keeps the link up until ctx ends or a newer computer takes the room.
func (c *Client) Run(ctx context.Context) {
	opener, err := NewOpener(c.secret, ToComputer)
	if err != nil {
		return
	}
	tries := 0
	for ctx.Err() == nil {
		began := time.Now()
		replaced := c.once(ctx, opener)
		if replaced {
			if c.h.Replaced != nil {
				c.h.Replaced()
			}
			return
		}
		if time.Since(began) > 10*c.BackoffMin {
			tries = 0 // it was up a while: start the waits over
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(c.Backoff(tries)):
		}
		tries++
	}
}

// once is one link, from joining until it drops; true when a newer computer replaced this one.
func (c *Client) once(ctx context.Context, opener *Opener) (replaced bool) {
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	conn, _, err := websocket.Dial(dialCtx, c.relay+"/phone/relay/"+c.secret.Room()+"?role=computer", nil)
	cancel()
	if err != nil {
		return false
	}
	conn.SetReadLimit(int64(MaxFrame) + 1024)
	sealer, err := NewSealer(c.secret, ToPhone) // a new epoch for every link
	if err != nil {
		_ = conn.CloseNow()
		return false
	}
	c.mu.Lock()
	c.conn, c.sealer = conn, sealer
	c.mu.Unlock()
	if c.h.Online != nil {
		c.h.Online(true)
	}
	defer func() {
		c.mu.Lock()
		if c.conn == conn {
			c.conn, c.sealer = nil, nil
		}
		c.mu.Unlock()
		_ = conn.CloseNow()
		if c.h.Online != nil {
			c.h.Online(false)
		}
	}()
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return websocket.CloseStatus(err) == closeReplaced
		}
		c.take(data, opener)
	}
}

// take is one message from the relay: a presence note, or a frame that must open.
func (c *Client) take(data []byte, opener *Opener) {
	var note struct {
		Relay string `json:"relay"`
		Count *int   `json:"count"`
	}
	if json.Unmarshal(data, &note) == nil && note.Relay != "" {
		if note.Relay == "phones" && note.Count != nil && *note.Count >= 0 && c.h.Phones != nil {
			c.h.Phones(*note.Count)
		}
		return
	}
	var f Frame
	if json.Unmarshal(data, &f) != nil {
		return
	}
	msg, err := opener.Open(f)
	if err != nil || c.h.Message == nil {
		return
	}
	c.h.Message(msg)
}

// Send seals a message to every phone. It never waits for a link: ErrOffline when there is none.
func (c *Client) Send(message []byte) error {
	c.mu.Lock()
	conn, sealer := c.conn, c.sealer
	c.mu.Unlock()
	if conn == nil {
		return ErrOffline
	}
	f, err := sealer.Seal(message)
	if err != nil {
		return err
	}
	wire, err := json.Marshal(f)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, wire); err != nil {
		if websocket.CloseStatus(err) == closeTooMuch {
			return errors.New("the relay refused a message as too large or too fast")
		}
		return err
	}
	return nil
}
