package tools

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"
)

// What is going on behind every wait: each command Friday is waiting on, foreground or background,
// as the interface's "what's going on" view shows it (the `activity` session command). Its pid, how
// long it has run, its process tree's CPU share, when it last printed, its last lines, and whether
// it looks stuck (stall.go). The person can stop one, or run it again.

// ActivityTailLines is how many of a command's last lines the view shows.
const ActivityTailLines = 10

// activityTailBytes is how far back the last lines are looked for.
const activityTailBytes = 8 << 10

// Activity is one command as of now.
type Activity struct {
	// ID is a background command's job id (cmd1), or fg1, fg2… for a foreground one.
	ID string
	// CallID is the run_command call a foreground command answers; empty for a background one.
	CallID     string
	Command    string
	Dir        string
	Pid        int
	Background bool
	// Status is running, exited N, stopped, or failed: why.
	Status     string
	Started    time.Time
	Elapsed    time.Duration
	LastOutput time.Time // zero while it has printed nothing
	Quiet      time.Duration
	CPU        float64 // percent of one core since the previous look; meaningful when CPUKnown
	CPUKnown   bool
	Stuck      bool
	Tail       []string
}

// foreground is a run_command call waiting on its command: what the view needs while it runs.
type foreground struct {
	id, callID, command, dir string
	clock                    func() time.Time

	mu         sync.Mutex
	pid        int
	started    time.Time
	out        *outputBuffer
	lastOutput time.Time
	watch      *stallWatch
	cancel     context.CancelFunc // ends the attempt running now
	// restart and stopped say what the person asked for, read when the attempt has ended.
	restart, stopped bool
}

// Write keeps what the command prints, for its last lines.
func (f *foreground) Write(p []byte) (int, error) {
	f.mu.Lock()
	f.out.write(p)
	f.lastOutput = f.clock()
	f.mu.Unlock()
	return len(p), nil
}

// attempt starts one run of the command: its pid and how to end it.
func (f *foreground) attempt(pid int, cancel context.CancelFunc) {
	f.mu.Lock()
	f.pid, f.cancel = pid, cancel
	early := f.stopped || f.restart // asked for before this run had started
	f.mu.Unlock()
	if early {
		cancel()
	}
}

// again is whether the person asked for the command to run again; asking is used up.
func (f *foreground) again() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.restart {
		return false
	}
	f.restart, f.stopped = false, false
	f.started, f.lastOutput, f.pid = f.clock(), time.Time{}, 0
	f.out = newOutputBuffer(0, activityTailBytes)
	f.watch = newStallWatch(f.started)
	return true
}

// stoppedByPerson is whether the person stopped it from the view.
func (f *foreground) stoppedByPerson() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.stopped
}

// beginForeground records a run_command call waiting on command; endForeground forgets it.
func (s *Jobs) beginForeground(callID, command, dir string) *foreground {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.fgNext++
	now := s.now()
	f := &foreground{id: fmt.Sprintf("fg%d", s.fgNext), callID: callID, command: command, dir: dir, clock: s.now,
		started: now, out: newOutputBuffer(0, activityTailBytes), watch: newStallWatch(now)}
	s.foreground = append(s.foreground, f)
	return f
}

func (s *Jobs) endForeground(f *foreground) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, g := range s.foreground {
		if g == f {
			s.foreground = append(s.foreground[:i], s.foreground[i+1:]...)
			return
		}
	}
}

// Activity is every command running now, and the background ones that have ended, oldest first.
// Each call is a look for the stall rule: the interface asks every few seconds while one runs.
func (s *Jobs) Activity() []Activity {
	s.mu.Lock()
	jobs := append([]*Job(nil), s.jobs...)
	fgs := append([]*foreground(nil), s.foreground...)
	s.mu.Unlock()
	now := s.now()
	out := make([]Activity, 0, len(jobs)+len(fgs))
	for _, j := range jobs {
		out = append(out, s.jobActivity(j, now))
	}
	for _, f := range fgs {
		out = append(out, s.foregroundActivity(f, now))
	}
	return out
}

func (s *Jobs) jobActivity(j *Job, now time.Time) Activity {
	// The CPU is read outside the job's lock: it scans /proc.
	ticks, known := uint64(0), false
	if j.View().Status == JobRunning {
		ticks, known = s.cpu(j.Pid)
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	v := j.viewLocked()
	running := v.Status == JobRunning
	st := j.watch.observe(stallSample{At: now, LastOutput: j.lastOutput, Ticks: ticks, CPUKnown: known, Running: running})
	a := Activity{ID: j.ID, Command: j.Command, Dir: j.Dir, Pid: j.Pid, Background: true, Status: statusText(v),
		Started: j.Started, Elapsed: v.Runtime, LastOutput: j.lastOutput, Tail: tailLines(j.out, ActivityTailLines)}
	if running {
		a.Elapsed = max(now.Sub(j.Started), 0)
		a.Quiet, a.CPU, a.CPUKnown, a.Stuck = st.Quiet, st.CPU, st.CPUKnown, st.Stuck
	}
	return a
}

func (s *Jobs) foregroundActivity(f *foreground, now time.Time) Activity {
	f.mu.Lock()
	pid := f.pid
	f.mu.Unlock()
	ticks, known := uint64(0), false
	if pid > 0 {
		ticks, known = s.cpu(pid)
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	st := f.watch.observe(stallSample{At: now, LastOutput: f.lastOutput, Ticks: ticks, CPUKnown: known, Running: true})
	return Activity{ID: f.id, CallID: f.callID, Command: f.command, Dir: f.dir, Pid: f.pid, Status: string(JobRunning),
		Started: f.started, Elapsed: max(now.Sub(f.started), 0), LastOutput: f.lastOutput, Quiet: st.Quiet,
		CPU: st.CPU, CPUKnown: st.CPUKnown, Stuck: st.Stuck, Tail: tailLines(f.out, ActivityTailLines)}
}

// find is the command an id names: a job id, a foreground id, or the call id a foreground one answers.
func (s *Jobs) find(id string) (*Job, *foreground) {
	id = strings.TrimSpace(id)
	s.mu.Lock()
	for _, f := range s.foreground {
		if f.id == id || (f.callID != "" && f.callID == id) {
			s.mu.Unlock()
			return nil, f
		}
	}
	s.mu.Unlock()
	j, _ := s.Get(id)
	return j, nil
}

// StopActivity stops a command the person chose: a background one with everything it started, a
// foreground one by ending the call's run of it (the model is told the person stopped it).
func (s *Jobs) StopActivity(id string) (string, error) {
	j, f := s.find(id)
	switch {
	case f != nil:
		f.mu.Lock()
		f.stopped = true
		cancel := f.cancel
		f.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return fmt.Sprintf("Stopped %s; Friday is told you stopped it", f.command), nil
	case j != nil:
		if j.View().Status != JobRunning {
			return fmt.Sprintf("%s had already ended: %s", j.ID, statusText(j.View())), nil
		}
		s.Stop(j)
		return fmt.Sprintf("Stopped %s: %s", j.ID, j.Command), nil
	}
	return "", fmt.Errorf("no command %s is running this session", strings.TrimSpace(id))
}

// RestartActivity runs a command again, the same in the same folder: a background one is stopped
// and started anew under a new id; a foreground one is ended and run again in the same call.
func (s *Jobs) RestartActivity(id string) (string, error) {
	j, f := s.find(id)
	switch {
	case f != nil:
		f.mu.Lock()
		f.restart = true
		cancel := f.cancel
		f.mu.Unlock()
		if cancel != nil {
			cancel()
		}
		return fmt.Sprintf("Running %s again", f.command), nil
	case j != nil:
		if j.View().Status == JobRunning {
			s.Stop(j)
		}
		again, err := s.Start(j.Command, j.Dir)
		if err != nil {
			return "", fmt.Errorf("%s could not start again: %w", j.ID, err)
		}
		return fmt.Sprintf("Started %s again as %s (pid %d)", j.ID, again.ID, again.Pid), nil
	}
	return "", fmt.Errorf("no command %s this session", strings.TrimSpace(id))
}

// tailLines is the last n lines b holds, oldest first: a carriage return keeps what was drawn
// last on its line (a progress bar), and blank lines are left out.
func tailLines(b *outputBuffer, n int) []string {
	c := b.read(max64(b.Total()-activityTailBytes, 0), activityTailBytes)
	data := c.Before
	if c.Dropped > 0 {
		data = c.After
	}
	text := strings.ToValidUTF8(string(data), "�")
	var lines []string
	for _, line := range strings.Split(text, "\n") {
		if i := strings.LastIndexByte(strings.TrimRight(line, "\r"), '\r'); i >= 0 {
			line = line[i+1:]
		}
		line = strings.TrimRight(line, "\r \t")
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	return lines
}
