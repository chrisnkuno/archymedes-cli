package phone

import (
	"bytes"
	"encoding/json"
	"math/rand/v2"
	"os"
	"strings"
	"testing"
	"time"
)

// The phone link's crypto. The relay between computer and phone sees every frame; it must not be
// able to read one, forge one, swap the direction of one, or play one back. These tests hold the
// sealing to that, over edge inputs and random ones, and pin the format with vectors the phone's
// JavaScript reproduces (testdata/vectors.json).

func fixedSecret() Secret {
	var s Secret
	for i := range s {
		s[i] = byte(i)
	}
	return s
}

// clock is a settable now.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func pair(t *testing.T, s Secret, dir Direction) (*Sealer, *Opener, *clock) {
	t.Helper()
	c := &clock{t: time.Unix(1_793_900_000, 0)}
	sealer, err := NewSealer(s, dir)
	if err != nil {
		t.Fatal(err)
	}
	sealer.now = c.now
	opener, err := NewOpener(s, dir)
	if err != nil {
		t.Fatal(err)
	}
	opener.now = c.now
	return sealer, opener, c
}

// INVARIANT: whatever is sealed opens to exactly itself, in order, for every payload shape.
func TestEverySealedMessageOpensToItself(t *testing.T) {
	payloads := [][]byte{
		[]byte(`{}`), []byte(`""`), []byte(`{"type":"send","text":""}`),
		[]byte(`{"text":"ünïcødé 日本語 🙂 \u0000 \n\t"}`),
		[]byte(`"` + strings.Repeat("x", MaxMessage-64) + `"`),
	}
	r := rand.New(rand.NewPCG(1, 2))
	for range 200 {
		b, _ := json.Marshal(map[string]any{"n": r.Int(), "s": strings.Repeat("é", r.IntN(500))})
		payloads = append(payloads, b)
	}
	for _, dir := range []Direction{ToPhone, ToComputer} {
		sealer, opener, _ := pair(t, NewSecretForTest(r), dir)
		for i, p := range payloads {
			f, err := sealer.Seal(p)
			if err != nil {
				t.Fatalf("%s #%d: seal: %v", dir, i, err)
			}
			got, err := opener.Open(f)
			if err != nil {
				t.Fatalf("%s #%d: open: %v", dir, i, err)
			}
			if !bytes.Equal(got, p) {
				t.Fatalf("%s #%d: opened %q, sealed %q", dir, i, got, p)
			}
		}
	}
}

// INVARIANT: no frame carries its message in the clear, and no two frames repeat a nonce.
func TestFramesHideTheMessageAndNeverRepeatANonce(t *testing.T) {
	sealer, _, _ := pair(t, fixedSecret(), ToPhone)
	seen := map[string]bool{}
	for i := range 2000 {
		f, err := sealer.Seal([]byte(`{"secret":"hunter2-plain-text"}`))
		if err != nil {
			t.Fatal(err)
		}
		wire, _ := json.Marshal(f)
		if bytes.Contains(wire, []byte("hunter2")) {
			t.Fatalf("frame %d shows the message: %s", i, wire)
		}
		nonce := f.C[:16] // base64 of the first 12 bytes
		if seen[nonce] {
			t.Fatalf("nonce repeated at frame %d", i)
		}
		seen[nonce] = true
	}
}

// INVARIANT: changing any one character of a frame makes it refused, never misread.
func TestATamperedFrameIsRefused(t *testing.T) {
	sealer, _, c := pair(t, fixedSecret(), ToComputer)
	f, _ := sealer.Seal([]byte(`{"type":"answer","id":"a1","choice":"deny"}`))
	r := rand.New(rand.NewPCG(3, 4))
	for range 300 {
		bad := f
		switch r.IntN(3) {
		case 0:
			cs := []byte(bad.C)
			i := r.IntN(len(cs))
			cs[i] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"[r.IntN(64)]
			if string(cs) == f.C {
				continue
			}
			bad.C = string(cs)
		case 1:
			bad.N += 1 + r.IntN(5)
		case 2:
			bad.E = "AAAAAAAAAAA"
		}
		opener, _ := NewOpener(fixedSecret(), ToComputer)
		opener.now = c.now
		if got, err := opener.Open(bad); err == nil {
			t.Fatalf("a tampered frame opened to %q: %+v", got, bad)
		}
	}
}

// BEHAVIOUR: a frame sealed for one direction never opens in the other, so the relay cannot
// reflect the computer's own words back to it as if the phone said them.
func TestAFrameDoesNotOpenInTheOtherDirection(t *testing.T) {
	sealer, _, c := pair(t, fixedSecret(), ToPhone)
	f, _ := sealer.Seal([]byte(`{"type":"send","text":"rm -rf"}`))
	back, _ := NewOpener(fixedSecret(), ToComputer)
	back.now = c.now
	if _, err := back.Open(f); err == nil {
		t.Fatal("a frame to the phone opened as one from the phone")
	}
}

// BEHAVIOUR: another pairing's key opens nothing.
func TestAnotherPairingOpensNothing(t *testing.T) {
	sealer, _, c := pair(t, fixedSecret(), ToComputer)
	f, _ := sealer.Seal([]byte(`{"type":"stop"}`))
	var other Secret
	other[0] = 9
	o, _ := NewOpener(other, ToComputer)
	o.now = c.now
	if _, err := o.Open(f); err == nil {
		t.Fatal("another secret opened the frame")
	}
}

// BEHAVIOUR: a frame played again is refused, and so is one older than the last from its sender.
func TestReplayedOrReorderedFramesAreRefused(t *testing.T) {
	sealer, opener, _ := pair(t, fixedSecret(), ToComputer)
	a, _ := sealer.Seal([]byte(`{"type":"answer","choice":"allow"}`))
	b, _ := sealer.Seal([]byte(`{"type":"send","text":"next"}`))
	if _, err := opener.Open(a); err != nil {
		t.Fatal(err)
	}
	if _, err := opener.Open(a); err == nil {
		t.Fatal("the same frame opened twice")
	}
	if _, err := opener.Open(b); err != nil {
		t.Fatal(err)
	}
	if _, err := opener.Open(a); err == nil {
		t.Fatal("an older frame opened after a newer one")
	}
}

// BEHAVIOUR: a frame from far in the past or future is refused, so one recorded long ago cannot be
// played to a computer that has forgotten its sender, after a restart for instance.
func TestStaleOrFutureFramesAreRefused(t *testing.T) {
	sealer, _, c := pair(t, fixedSecret(), ToComputer)
	old, _ := sealer.Seal([]byte(`{"type":"answer","choice":"allow"}`))
	c.t = c.t.Add(MaxSkew + time.Second)
	fresh, _ := NewOpener(fixedSecret(), ToComputer) // a restarted computer: nothing remembered
	fresh.now = c.now
	if _, err := fresh.Open(old); err == nil {
		t.Fatal("a frame older than the allowed skew opened")
	}
	ahead, _ := NewSealer(fixedSecret(), ToComputer)
	ahead.now = func() time.Time { return c.t.Add(MaxSkew + time.Second) }
	future, _ := ahead.Seal([]byte(`{}`))
	if _, err := fresh.Open(future); err == nil {
		t.Fatal("a frame from the future opened")
	}
	near, _ := NewSealer(fixedSecret(), ToComputer)
	near.now = func() time.Time { return c.t.Add(-MaxSkew + time.Second) }
	ok, _ := near.Seal([]byte(`{}`))
	if _, err := fresh.Open(ok); err != nil {
		t.Fatalf("a frame within the skew was refused: %v", err)
	}
}

// BEHAVIOUR: several phones (or a phone that reloaded) each start their own count; one's frames do
// not shut the other out.
func TestTwoSendersEachKeepTheirOwnCount(t *testing.T) {
	s := fixedSecret()
	_, opener, c := pair(t, s, ToComputer)
	one, _ := NewSealer(s, ToComputer)
	two, _ := NewSealer(s, ToComputer)
	one.now, two.now = c.now, c.now
	for i := range 5 {
		f1, _ := one.Seal([]byte(`{"from":1}`))
		f2, _ := two.Seal([]byte(`{"from":2}`))
		if _, err := opener.Open(f1); err != nil {
			t.Fatalf("round %d phone one: %v", i, err)
		}
		if _, err := opener.Open(f2); err != nil {
			t.Fatalf("round %d phone two: %v", i, err)
		}
	}
}

// INVARIANT: the opener's memory of senders stays bounded however many come and go.
func TestTheOpenerForgetsSendersItCanNoLongerBeFooledBy(t *testing.T) {
	s := fixedSecret()
	_, opener, c := pair(t, s, ToComputer)
	for range 5000 {
		sealer, _ := NewSealer(s, ToComputer)
		sealer.now = c.now
		f, _ := sealer.Seal([]byte(`{}`))
		if _, err := opener.Open(f); err != nil {
			t.Fatal(err)
		}
		c.t = c.t.Add(time.Second)
	}
	if n := opener.remembered(); n > MaxSenders {
		t.Fatalf("remembers %d senders, at most %d", n, MaxSenders)
	}
}

// BEHAVIOUR: a message over the limit is refused when sealed, and a frame over it when opened.
func TestOversizedMessagesAreRefused(t *testing.T) {
	sealer, opener, _ := pair(t, fixedSecret(), ToPhone)
	if _, err := sealer.Seal(make([]byte, MaxMessage+1)); err == nil {
		t.Fatal("sealed a message over the limit")
	}
	if _, err := opener.Open(Frame{V: 1, E: "AAAAAAAAAAA", N: 1, C: strings.Repeat("A", MaxFrame+1)}); err == nil {
		t.Fatal("opened a frame over the limit")
	}
}

// BEHAVIOUR: malformed frames are refused without a panic.
func TestMalformedFramesAreRefused(t *testing.T) {
	_, opener, _ := pair(t, fixedSecret(), ToPhone)
	for _, f := range []Frame{{}, {V: 2, E: "AAAAAAAAAAA", N: 1, C: "AAAA"}, {V: 1, E: "", N: 1, C: "AAAA"}, {V: 1, E: "AAAAAAAAAAA", N: 0, C: "AAAA"},
		{V: 1, E: "AAAAAAAAAAA", N: 1, C: "!!!"}, {V: 1, E: "AAAAAAAAAAA", N: 1, C: "AAAA"}, {V: 1, E: "AAAAAAAAAAA", N: -4, C: ""}} {
		if _, err := opener.Open(f); err == nil {
			t.Fatalf("opened malformed %+v", f)
		}
	}
}

// INVARIANT: the room is derived from the secret alone, the same every time, and says nothing of
// the keys: different secrets, different rooms; the room is URL-safe.
func TestTheRoomIsStableAndRevealsNoKey(t *testing.T) {
	s := fixedSecret()
	if s.Room() != s.Room() || len(s.Room()) != 22 {
		t.Fatalf("room %q", s.Room())
	}
	var other Secret
	other[31] = 1
	if other.Room() == s.Room() {
		t.Fatal("two secrets share a room")
	}
	for _, c := range s.Room() {
		if !strings.ContainsRune("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_", c) {
			t.Fatalf("room %q is not URL-safe", s.Room())
		}
	}
}

// BEHAVIOUR: the link carries the secret only after '#', which browsers never send to a server, and
// reads back to the same secret; anything else is refused.
func TestTheLinkKeepsTheSecretInItsFragment(t *testing.T) {
	s := fixedSecret()
	link := s.Link("https://archymedes.xyz/phone")
	base, frag, ok := strings.Cut(link, "#")
	if !ok || base != "https://archymedes.xyz/phone" || strings.Contains(base, s.Encode()) {
		t.Fatalf("link %q", link)
	}
	got, err := ParseSecret(frag)
	if err != nil || got != s {
		t.Fatalf("read back %v %v", got, err)
	}
	for _, bad := range []string{"", "k=", "short", strings.Repeat("A", 44), "k=" + strings.Repeat("*", 43)} {
		if _, err := ParseSecret(bad); err == nil {
			t.Fatalf("accepted %q", bad)
		}
	}
}

// FORMAT: the vectors the phone's JavaScript must reproduce. Regenerate with
// FRIDAY_PHONE_VECTORS=write go test ./internal/phone -run Vectors.
func TestVectors(t *testing.T) {
	s := fixedSecret()
	at := time.Unix(1_793_900_000, 0)
	var cases []VectorCase
	for i, dir := range []Direction{ToPhone, ToComputer} {
		sealer, _ := NewSealer(s, dir)
		sealer.now = func() time.Time { return at }
		sealer.epoch = strings.Repeat(string(rune('A'+i)), 11)
		sealer.nonce = func(b []byte) {
			for j := range b {
				b[j] = byte(j + i)
			}
		}
		msg := `{"type":"send","text":"héllo 🙂"}`
		f, err := sealer.Seal([]byte(msg))
		if err != nil {
			t.Fatal(err)
		}
		cases = append(cases, VectorCase{Direction: dir, Message: msg, Frame: f})
	}
	v := Vectors{Secret: s.Encode(), Room: s.Room(), Now: at.UnixMilli(), Cases: cases}
	want, _ := json.MarshalIndent(v, "", "  ")
	if os.Getenv("FRIDAY_PHONE_VECTORS") == "write" {
		if err := os.WriteFile("testdata/vectors.json", append(want, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	got, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatalf("no vectors: %v (write them with FRIDAY_PHONE_VECTORS=write)", err)
	}
	if string(bytes.TrimSpace(got)) != string(want) {
		t.Fatalf("the sealing changed; the phone's JavaScript must change with it:\n%s", want)
	}
	// And they open, as the other side would.
	for _, c := range v.Cases {
		o, _ := NewOpener(s, c.Direction)
		o.now = func() time.Time { return at }
		m, err := o.Open(c.Frame)
		if err != nil || string(m) != c.Message {
			t.Fatalf("%s vector opens to %q, %v", c.Direction, m, err)
		}
	}
}

// NewSecretForTest is a secret from a seeded source, so a failure repeats.
func NewSecretForTest(r *rand.Rand) Secret {
	var s Secret
	for i := range s {
		s[i] = byte(r.IntN(256))
	}
	return s
}
