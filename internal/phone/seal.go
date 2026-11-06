// Package phone is Friday's link to the person's phone through a relay that only forwards: the
// pairing secret, the room it derives, and the sealing of every message between the two ends.
//
// A pairing is a 32-byte secret. The phone gets it in a link's fragment (after '#', which browsers
// never send to a server). From it both ends derive the relay room (so the relay can pair the two
// sockets) and one AES-256-GCM key per direction. Each frame carries its sender's epoch (random,
// per connection) and a count that only rises; the sealed message carries the time it was sealed.
// So the relay, which sees every frame, cannot read one, forge one, send one back the other way,
// or play one again: an opener refuses a count it has passed and a time outside MaxSkew.
//
// The format is pinned by testdata/vectors.json, which the phone's JavaScript reproduces.
package phone

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	// MaxMessage is the most a message may be before sealing.
	MaxMessage = 256 << 10
	// MaxFrame is the most a frame's ciphertext may be, base64 included.
	MaxFrame = MaxMessage*4/3 + 128
	// MaxSkew is how far a frame's sealing time may be from the opener's clock.
	MaxSkew = 5 * time.Minute
	// MaxSenders is how many senders an opener remembers counts for.
	MaxSenders = 32
	salt       = "friday-phone v1"
)

// Direction is which way a frame goes; each has its own key.
type Direction string

const (
	ToPhone    Direction = "c2p"
	ToComputer Direction = "p2c"
)

// Secret is a pairing.
type Secret [32]byte

// NewSecret is a fresh pairing.
func NewSecret() (Secret, error) {
	var s Secret
	_, err := rand.Read(s[:])
	return s, err
}

var b64 = base64.RawURLEncoding

// Encode is the secret as the link carries it.
func (s Secret) Encode() string { return b64.EncodeToString(s[:]) }

// Link is the phone page at base with the secret in its fragment.
func (s Secret) Link(base string) string { return base + "#k=" + s.Encode() }

// ParseSecret reads a link's fragment ("k=…", or the bare secret).
func ParseSecret(fragment string) (Secret, error) {
	var s Secret
	raw, err := b64.DecodeString(strings.TrimPrefix(strings.TrimPrefix(fragment, "#"), "k="))
	if err != nil || len(raw) != len(s) {
		return s, errors.New("not a Friday phone pairing")
	}
	copy(s[:], raw)
	return s, nil
}

func (s Secret) derive(info string, n int) []byte {
	key, err := hkdf.Key(sha256.New, s[:], []byte(salt), info, n)
	if err != nil {
		panic(err) // only for lengths no caller asks
	}
	return key
}

// Room is the relay room both ends join: derived from the secret, revealing none of its keys.
func (s Secret) Room() string { return b64.EncodeToString(s.derive("room", 16)) }

func (s Secret) aead(dir Direction) (cipher.AEAD, error) {
	if dir != ToPhone && dir != ToComputer {
		return nil, fmt.Errorf("no direction %q", dir)
	}
	block, err := aes.NewCipher(s.derive("key "+string(dir), 32))
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

// Frame is one sealed message on the wire: version, the sender's epoch, its count, and the nonce
// followed by the ciphertext.
type Frame struct {
	V int    `json:"v"`
	E string `json:"e"`
	N int    `json:"n"`
	C string `json:"c"`
}

// envelope is what is sealed: the message and when.
type envelope struct {
	T int64           `json:"t"`
	M json.RawMessage `json:"m"`
}

func aad(dir Direction, epoch string, n int) []byte {
	return []byte(salt + "|" + string(dir) + "|" + epoch + "|" + strconv.Itoa(n))
}

// Sealer seals one sender's messages in one direction.
type Sealer struct {
	aead  cipher.AEAD
	dir   Direction
	epoch string
	mu    sync.Mutex
	n     int
	now   func() time.Time
	nonce func([]byte)
}

// NewSealer is a sender with a fresh epoch.
func NewSealer(s Secret, dir Direction) (*Sealer, error) {
	a, err := s.aead(dir)
	if err != nil {
		return nil, err
	}
	var e [8]byte
	if _, err := rand.Read(e[:]); err != nil {
		return nil, err
	}
	return &Sealer{aead: a, dir: dir, epoch: b64.EncodeToString(e[:]), now: time.Now, nonce: func(b []byte) { _, _ = rand.Read(b) }}, nil
}

// Seal seals a JSON message.
func (s *Sealer) Seal(message []byte) (Frame, error) {
	if len(message) > MaxMessage {
		return Frame{}, fmt.Errorf("a message of %d bytes is over %d", len(message), MaxMessage)
	}
	if !json.Valid(message) {
		return Frame{}, errors.New("a message is JSON")
	}
	plain, err := json.Marshal(envelope{T: s.now().UnixMilli(), M: message})
	if err != nil {
		return Frame{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.n++
	nonce := make([]byte, s.aead.NonceSize())
	s.nonce(nonce)
	sealed := s.aead.Seal(nonce, nonce, plain, aad(s.dir, s.epoch, s.n))
	return Frame{V: 1, E: s.epoch, N: s.n, C: b64.EncodeToString(sealed)}, nil
}

// Opener opens one direction's frames from any number of senders.
type Opener struct {
	aead cipher.AEAD
	dir  Direction
	mu   sync.Mutex
	// last is each sender's last count and when it was seen.
	last map[string]seen
	now  func() time.Time
}

type seen struct {
	n  int
	at time.Time
}

// NewOpener opens frames going dir.
func NewOpener(s Secret, dir Direction) (*Opener, error) {
	a, err := s.aead(dir)
	if err != nil {
		return nil, err
	}
	return &Opener{aead: a, dir: dir, last: map[string]seen{}, now: time.Now}, nil
}

var errRefused = errors.New("a frame that does not open")

// Open is a frame's message, or an error for one that is malformed, tampered with, for the other
// direction or pairing, played again, older than its sender's last, or sealed outside MaxSkew.
func (o *Opener) Open(f Frame) ([]byte, error) {
	if f.V != 1 || len(f.E) != 11 || f.N < 1 || len(f.C) > MaxFrame {
		return nil, errRefused
	}
	sealed, err := b64.DecodeString(f.C)
	if err != nil || len(sealed) < o.aead.NonceSize()+o.aead.Overhead() {
		return nil, errRefused
	}
	ns := o.aead.NonceSize()
	plain, err := o.aead.Open(nil, sealed[:ns], sealed[ns:], aad(o.dir, f.E, f.N))
	if err != nil {
		return nil, errRefused
	}
	var env envelope
	if json.Unmarshal(plain, &env) != nil || len(env.M) == 0 {
		return nil, errRefused
	}
	now := o.now()
	if d := now.Sub(time.UnixMilli(env.T)); d > MaxSkew || d < -MaxSkew {
		return nil, errors.New("a frame sealed too long ago, or ahead of this clock")
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	if prev, ok := o.last[f.E]; ok && f.N <= prev.n {
		return nil, errors.New("a frame already seen, or older than its sender's last")
	}
	o.last[f.E] = seen{n: f.N, at: now}
	o.forget(now)
	return env.M, nil
}

// forget drops senders quiet for longer than MaxSkew (their old frames are refused by time now),
// and the quietest beyond MaxSenders.
func (o *Opener) forget(now time.Time) {
	for e, s := range o.last {
		if now.Sub(s.at) > MaxSkew {
			delete(o.last, e)
		}
	}
	for len(o.last) > MaxSenders {
		oldest, at := "", now
		for e, s := range o.last {
			if !s.at.After(at) {
				oldest, at = e, s.at
			}
		}
		delete(o.last, oldest)
	}
}

func (o *Opener) remembered() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.last)
}

// Vectors pin the format for the phone's side.
type Vectors struct {
	Secret string       `json:"secret"`
	Room   string       `json:"room"`
	Now    int64        `json:"now"`
	Cases  []VectorCase `json:"cases"`
}

// VectorCase is one sealed message.
type VectorCase struct {
	Direction Direction `json:"direction"`
	Message   string    `json:"message"`
	Frame     Frame     `json:"frame"`
}
