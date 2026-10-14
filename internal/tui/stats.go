package tui

import (
	"sort"
	"time"
)

// What the Stats app and the tray's sparkline draw, gathered from what the interface already
// receives: usage on each model call, each tool call, each turn's start and end, and the reply's
// text as it streams. Nothing extra is asked of the agent.

// streamBucket is the streaming-rate sparkline's resolution; streamBuckets is how many it keeps.
const (
	streamBucket  = 250 * time.Millisecond
	streamBuckets = 48
)

type callStat struct {
	at      time.Time
	in, out int
}

type turnStat struct {
	prompt   string
	start    time.Time
	seconds  float64
	in, out  int
	calls    int
	tools    int
	stop     string
	finished bool
}

type sessionStats struct {
	calls []callStat
	turns []turnStat
	tools map[string]int

	// The streaming rate: characters per bucket, newest last, while a turn runs.
	stream      []float64
	bucketStart time.Time
	bucketChars int
}

func newSessionStats() sessionStats { return sessionStats{tools: map[string]int{}} }

func (s *sessionStats) current() *turnStat {
	if n := len(s.turns); n > 0 && !s.turns[n-1].finished {
		return &s.turns[n-1]
	}
	return nil
}

func (s *sessionStats) startTurn(prompt string, now time.Time) {
	s.turns = append(s.turns, turnStat{prompt: prompt, start: now})
	s.stream, s.bucketStart, s.bucketChars = nil, now, 0
}

func (s *sessionStats) call(in, out int, now time.Time) {
	s.calls = append(s.calls, callStat{at: now, in: in, out: out})
	if t := s.current(); t != nil {
		t.in, t.out, t.calls = t.in+in, t.out+out, t.calls+1
	}
}

func (s *sessionStats) tool(name string) {
	s.tools[name]++
	if t := s.current(); t != nil {
		t.tools++
	}
}

// toolCount is every tool call this session.
func (s *sessionStats) toolCount() int {
	total := 0
	for _, n := range s.tools {
		total += n
	}
	return total
}

// text records streamed reply text, for the rate sparkline.
func (s *sessionStats) text(n int, now time.Time) {
	if s.current() == nil {
		return
	}
	s.roll(now)
	s.bucketChars += n
}

// roll closes every bucket that has ended by now, so a pause in the stream shows as a dip to zero.
func (s *sessionStats) roll(now time.Time) {
	if s.current() == nil || s.bucketStart.IsZero() {
		return
	}
	for now.Sub(s.bucketStart) >= streamBucket {
		s.stream = append(s.stream, float64(s.bucketChars))
		s.bucketChars = 0
		s.bucketStart = s.bucketStart.Add(streamBucket)
		if len(s.stream) > streamBuckets {
			s.stream = s.stream[len(s.stream)-streamBuckets:]
		}
	}
}

func (s *sessionStats) endTurn(stop string, now time.Time) {
	if t := s.current(); t != nil {
		t.seconds, t.stop, t.finished = now.Sub(t.start).Seconds(), stop, true
	}
	s.stream = nil
}

// toolRanking is tools by use, most first; ties by name, so the order is stable.
func (s *sessionStats) toolRanking() []string {
	names := make([]string, 0, len(s.tools))
	for name := range s.tools {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool {
		if s.tools[names[i]] != s.tools[names[j]] {
			return s.tools[names[i]] > s.tools[names[j]]
		}
		return names[i] < names[j]
	})
	return names
}
