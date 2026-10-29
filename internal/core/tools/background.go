package tools

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// Background commands: what run_command starts with background: true, read with command_output,
// stopped with stop_command and listed with list_commands. Each keeps its output in bounded memory
// and is stopped, with everything it started, when the session closes.
const (
	// MaxBackgroundCommands is how many may run at once; a start past it is refused.
	MaxBackgroundCommands = 8
	// KeptBackgroundCommands is how many are remembered, running or finished; past it the oldest
	// finished one is forgotten.
	KeptBackgroundCommands = 20
	// CommandHeadBytes of a command's output are kept from its start, and CommandTailBytes from its
	// end; what falls between is dropped and counted.
	CommandHeadBytes = 20_000
	CommandTailBytes = 200_000
	// CommandReadMax is the most output one read returns.
	CommandReadMax = 30_000
	// CommandStartWindow is how long a start watches a command before returning, so a crash on
	// startup is seen at once; a command that ends sooner returns sooner.
	CommandStartWindow = 2 * time.Second
	// CommandWaitCeiling is the longest command_output waits for news.
	CommandWaitCeiling = 60 * time.Second
	// CommandStopGrace is how long a stopped command has to exit on SIGTERM before SIGKILL.
	CommandStopGrace = 3 * time.Second
	// drainGrace is how long a finished command's output may keep arriving (from what it left
	// running) before its status is settled; the rest is still captured as it comes.
	drainGrace = 500 * time.Millisecond
)

// JobStatus is where a background command is: running, then exactly one of the others, for good.
type JobStatus string

const (
	JobRunning JobStatus = "running"
	JobExited  JobStatus = "exited"
	JobStopped JobStatus = "stopped"
	JobFailed  JobStatus = "failed"
)

// Job is one background command.
type Job struct {
	ID      string
	Command string
	Dir     string
	Pid     int
	Started time.Time

	mu       sync.Mutex
	out      *outputBuffer
	status   JobStatus
	exitCode int
	failure  string
	ended    time.Time
	stopping bool
	// transitions counts status changes, for the invariant that there is exactly one.
	transitions int
	// notify is closed and cleared on every change a waiter may care about; nil while no one waits.
	notify chan struct{}
	// mark is where the last read with no cursor left off.
	mark int64

	cmd     *exec.Cmd
	pipe    *os.File
	cancel  context.CancelFunc
	done    chan struct{} // closed once the status has left running
	drained chan struct{} // closed once the output pipe is read to its end
}

// JobView is a job as of one moment.
type JobView struct {
	ID, Command string
	Pid         int
	Status      JobStatus
	ExitCode    int
	Failure     string
	Runtime     time.Duration
	Bytes       int64
}

// View is the job now.
func (j *Job) View() JobView {
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.viewLocked()
}

func (j *Job) viewLocked() JobView {
	end := time.Now()
	if j.status != JobRunning {
		end = j.ended
	}
	return JobView{ID: j.ID, Command: j.Command, Pid: j.Pid, Status: j.status, ExitCode: j.exitCode, Failure: j.failure, Runtime: end.Sub(j.Started), Bytes: j.out.Total()}
}

// Done is closed once the job has finished, whichever way.
func (j *Job) Done() <-chan struct{} { return j.done }

func (j *Job) wakeLocked() {
	if j.notify != nil {
		close(j.notify)
		j.notify = nil
	}
}

func (j *Job) write(p []byte) {
	j.mu.Lock()
	j.out.write(p)
	j.wakeLocked()
	j.mu.Unlock()
}

// settle moves the job out of running, once; a second call changes nothing.
func (j *Job) settle(status JobStatus, code int, failure string) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if j.status != JobRunning {
		return
	}
	j.status, j.exitCode, j.failure, j.ended = status, code, failure, time.Now()
	j.transitions++
	j.wakeLocked()
	close(j.done)
}

// Read is up to max bytes from cursor since; since < 0 reads from where the last read ended (the
// mark), and every read moves the mark to where it ended.
func (j *Job) Read(since int64, max int) (chunk, JobView) {
	return j.read(since, max, false, true)
}

// advanceMark records next as where the last read ended.
func (j *Job) advanceMark(next int64) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.mark = next
}

// Cursor is since, or the mark where the last read ended when since < 0.
func (j *Job) Cursor(since int64) int64 {
	if since >= 0 {
		return since
	}
	j.mu.Lock()
	defer j.mu.Unlock()
	return j.mark
}

// read is Read with two choices: fromEnd skips to the last max bytes when there are more (counted
// in the chunk's Dropped, never silently), and advance moves the mark.
func (j *Job) read(since int64, max int, fromEnd, advance bool) (chunk, JobView) {
	j.mu.Lock()
	defer j.mu.Unlock()
	if since < 0 {
		since = j.mark
	}
	var skipped int64
	if total := j.out.Total(); fromEnd && max > 0 && total-since > int64(max) {
		skipped = total - int64(max) - max64(since, 0)
		since = total - int64(max)
	}
	c := j.out.read(since, max)
	if skipped > 0 {
		c.Since -= skipped
		if c.Dropped == 0 && len(c.After) == 0 {
			c.After, c.Before = c.Before, nil
		}
		c.Dropped += skipped
	}
	if advance {
		j.mark = c.Next
	}
	return c, j.viewLocked()
}

// Await blocks until output past since exists, the job has finished, the deadline passes or ctx
// ends; it reports the output total and whether the job is still running. It never polls: a
// writer or the settling closes the channel it waits on.
func (j *Job) Await(ctx context.Context, since int64, deadline time.Time) (int64, bool) {
	var timer *time.Timer
	for {
		j.mu.Lock()
		total, running := j.out.Total(), j.status == JobRunning
		if total > since || !running || !time.Now().Before(deadline) || ctx.Err() != nil {
			j.mu.Unlock()
			if timer != nil {
				timer.Stop()
			}
			return total, running
		}
		if j.notify == nil {
			j.notify = make(chan struct{})
		}
		wake := j.notify
		j.mu.Unlock()
		if timer == nil {
			timer = time.NewTimer(time.Until(deadline))
		}
		select {
		case <-wake:
		case <-timer.C:
		case <-ctx.Done():
		}
	}
}

// pump copies the pipe into the buffer until every writer has closed it (or it is closed under it).
func (j *Job) pump() {
	defer func() {
		_ = j.pipe.Close()
		close(j.drained)
	}()
	buf := make([]byte, 32<<10)
	for {
		n, err := j.pipe.Read(buf)
		if n > 0 {
			j.write(buf[:n])
		}
		if err != nil {
			return
		}
	}
}

// reap waits for the command, then for its output, then settles it.
func (j *Job) reap() {
	err := j.cmd.Wait()
	select {
	case <-j.drained:
	case <-time.After(drainGrace):
	}
	j.mu.Lock()
	stopping := j.stopping
	j.mu.Unlock()
	var exit *exec.ExitError
	switch {
	case stopping:
		j.settle(JobStopped, exitCodeOf(err), "")
	case err == nil:
		j.settle(JobExited, 0, "")
	case errors.As(err, &exit):
		j.settle(JobExited, exitCodeOf(err), "")
	default:
		j.settle(JobFailed, -1, err.Error())
	}
	j.cancel()
}

func exitCodeOf(err error) int {
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		if err == nil {
			return 0
		}
		return -1
	}
	if code := exit.ExitCode(); code >= 0 {
		return code
	}
	return 137 // killed by a signal
}

// stop ends the job and everything it started: SIGTERM to its group, SIGKILL after the grace. It
// returns once the job has settled; stopping a finished job only sweeps what it left running.
func (j *Job) stop(grace time.Duration) {
	j.mu.Lock()
	running := j.status == JobRunning
	if running {
		j.stopping = true
	}
	j.mu.Unlock()
	if !running {
		killGroup(j.Pid)
		return
	}
	terminateGroup(j)
	select {
	case <-j.done:
	case <-time.After(grace):
	}
	// SIGKILL whatever is left, the leader included if it ignored the SIGTERM.
	killGroup(j.Pid)
	j.cancel()
	<-j.done
}

// release waits for the pump; a pipe some escaped process still holds is closed under it, which
// ends the read.
func (j *Job) release() {
	select {
	case <-j.drained:
	case <-time.After(drainGrace):
		_ = j.pipe.Close()
		<-j.drained
	}
}

// Jobs is a session's background commands, shared by the workspaces of its sub-agents.
type Jobs struct {
	mu     sync.Mutex
	next   int
	jobs   []*Job
	closed bool
	// limits, set from the exported constants; tests lower them.
	maxRunning, kept, headBytes, tailBytes int
	grace, window                          time.Duration
}

// NewJobs is an empty set held to the package limits.
func NewJobs() *Jobs {
	return &Jobs{maxRunning: MaxBackgroundCommands, kept: KeptBackgroundCommands, headBytes: CommandHeadBytes, tailBytes: CommandTailBytes, grace: CommandStopGrace, window: CommandStartWindow}
}

// errLimit is a start refused for the number already running.
type errLimit struct{ running []string }

func (e errLimit) Error() string {
	return fmt.Sprintf("%d background commands are already running (%s), the most at once; stop one with stop_command first", len(e.running), strings.Join(e.running, ", "))
}

var errClosed = errors.New("the session is closing; no background command can start")

// Start runs command through the platform shell in dir, in its own process group, with stdout and
// stderr in one stream. It returns once the process has started.
func (s *Jobs) Start(command, dir string) (*Job, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, errClosed
	}
	var running []string
	for _, j := range s.jobs {
		if j.View().Status == JobRunning {
			running = append(running, j.ID)
		}
	}
	if len(running) >= s.maxRunning {
		return nil, errLimit{running}
	}
	pr, pw, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	cmd := shellCommand(ctx, command, dir)
	cmd.Stdout, cmd.Stderr = pw, pw
	if err := cmd.Start(); err != nil {
		cancel()
		_ = pr.Close()
		_ = pw.Close()
		return nil, err
	}
	_ = pw.Close() // the child holds its own copy; the pipe ends when the last holder closes it
	s.next++
	j := &Job{
		ID: fmt.Sprintf("cmd%d", s.next), Command: command, Dir: dir, Pid: cmd.Process.Pid, Started: time.Now(),
		out: newOutputBuffer(s.headBytes, s.tailBytes), status: JobRunning,
		cmd: cmd, pipe: pr, cancel: cancel, done: make(chan struct{}), drained: make(chan struct{}),
	}
	go j.pump()
	go j.reap()
	s.jobs = append(s.jobs, j)
	s.forgetLocked()
	return j, nil
}

// forgetLocked drops the oldest finished jobs past the kept number.
func (s *Jobs) forgetLocked() {
	for len(s.jobs) > s.kept {
		i := -1
		for k, j := range s.jobs {
			if j.View().Status != JobRunning {
				i = k
				break
			}
		}
		if i < 0 {
			return
		}
		old := s.jobs[i]
		s.jobs = append(s.jobs[:i], s.jobs[i+1:]...)
		go func() {
			old.stop(s.grace) // sweeps what it left running
			old.release()
		}()
	}
}

// Get finds a job by id.
func (s *Jobs) Get(id string) (*Job, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	id = strings.TrimSpace(id)
	for _, j := range s.jobs {
		if j.ID == id {
			return j, true
		}
	}
	return nil, false
}

// List is every remembered job, oldest first.
func (s *Jobs) List() []*Job {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]*Job(nil), s.jobs...)
}

// Stop stops one job and waits for it.
func (s *Jobs) Stop(j *Job) { j.stop(s.grace) }

// Close stops every job, refuses new ones, and returns once every goroutine they ran has ended.
// It is safe to call more than once.
func (s *Jobs) Close() {
	s.mu.Lock()
	s.closed = true
	jobs := append([]*Job(nil), s.jobs...)
	s.mu.Unlock()
	var wg sync.WaitGroup
	for _, j := range jobs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			j.stop(s.grace)
			j.release()
		}()
	}
	wg.Wait()
}
