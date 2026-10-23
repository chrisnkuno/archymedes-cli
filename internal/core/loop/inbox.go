package loop

import "sync"

// Inbox is what reaches a thread while it works: the person steering the turn, or a background
// sub-agent's report. The loop reads it at the top of every step and folds what it finds into the
// conversation as user messages, so steering is an input of the loop rather than a side channel.
//
// Two kinds behave differently when no run is reading. Steering is only accepted while a run is
// open (the person's words belong to the turn they typed them into; otherwise the interface sends
// them as a turn of their own), and what a run accepted but never read is handed back by Close.
// A notice is always accepted and waits for the next run: a report that lands between turns must
// not be lost.
type Inbox struct {
	mu      sync.Mutex
	open    bool
	steer   []string
	notices []notice
	wake    chan struct{}
}

type notice struct{ key, text string }

// NewInbox is a closed, empty inbox.
func NewInbox() *Inbox { return &Inbox{wake: make(chan struct{}, 1)} }

// Open starts accepting steering; a run calls it as it starts.
func (b *Inbox) Open() {
	b.mu.Lock()
	b.open = true
	b.mu.Unlock()
}

// Close stops accepting steering and returns what was accepted and never read. Notices stay.
func (b *Inbox) Close() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.open = false
	unread := b.steer
	b.steer = nil
	return unread
}

// IsOpen reports whether a run is reading.
func (b *Inbox) IsOpen() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.open
}

// Steer hands text to the running turn; false when none is running.
func (b *Inbox) Steer(text string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	if !b.open {
		return false
	}
	b.steer = append(b.steer, text)
	b.signal()
	return true
}

// Notify leaves a message for the thread, read by the running turn or the next one.
func (b *Inbox) Notify(text string) { b.NotifyKey("", text) }

// NotifyKey is Notify with a key that Retract can withdraw it by, while it is unread: a sub-agent's
// report waits here, and is withdrawn when the parent collects it with wait_agents instead.
func (b *Inbox) NotifyKey(key, text string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.notices = append(b.notices, notice{key, text})
	b.signal()
}

// Retract withdraws an unread notice by key; false when there is none.
func (b *Inbox) Retract(key string) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, n := range b.notices {
		if key != "" && n.key == key {
			b.notices = append(b.notices[:i], b.notices[i+1:]...)
			return true
		}
	}
	return false
}

// Pending reports whether anything waits.
func (b *Inbox) Pending() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.steer)+len(b.notices) > 0
}

// HasNotices reports whether a notice waits (what a session checks between turns).
func (b *Inbox) HasNotices() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.notices) > 0
}

// Drain takes everything waiting, notices first (they arrived for the turn, steering is in reply to it).
func (b *Inbox) Drain() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := make([]string, 0, len(b.notices)+len(b.steer))
	for _, n := range b.notices {
		out = append(out, n.text)
	}
	out = append(out, b.steer...)
	b.notices, b.steer = nil, nil
	return out
}

// Wake is signalled whenever something arrives, for a waiter that sleeps until then.
func (b *Inbox) Wake() <-chan struct{} { return b.wake }

func (b *Inbox) signal() {
	select {
	case b.wake <- struct{}{}:
	default:
	}
}
