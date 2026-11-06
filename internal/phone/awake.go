package phone

import (
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"sync"
)

// Awake keeps the computer from sleeping while someone works from their phone: Linux through
// systemd-inhibit, macOS through caffeinate tied to Friday's pid, Windows through
// SetThreadExecutionState. Held once however often it is asked; the helper ends on Release or
// Close, and with Friday itself.
type Awake struct {
	goos  string
	self  int // Friday's pid, which caffeinate watches
	start func(name string, args ...string) (stop func(), err error)
	note  func(string)

	mu      sync.Mutex
	stop    func()
	running int // the helper's pid, 0 when none or not a process
	failed  bool
}

// NewAwake is the computer's own.
func NewAwake() *Awake {
	a := newAwake(runtime.GOOS, os.Getpid(), nil)
	a.start = a.startProcess
	return a
}

func newAwake(goos string, pid int, start func(string, ...string) (func(), error)) *Awake {
	return &Awake{goos: goos, self: pid, start: start, note: func(string) {}}
}

// OnNote sets where Awake says, once, that it cannot keep the computer awake.
func (a *Awake) OnNote(f func(string)) { a.mu.Lock(); a.note = f; a.mu.Unlock() }

// Hold keeps the computer awake until Release.
func (a *Awake) Hold() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.stop != nil || a.failed {
		return
	}
	var stop func()
	var err error
	switch a.goos {
	case "linux":
		stop, err = a.start("systemd-inhibit", "--what=idle:sleep", "--who=Friday",
			"--why=Working while you are away from the computer", "--mode=block", "sleep", "infinity")
	case "darwin":
		stop, err = a.start("caffeinate", "-i", "-w", strconv.Itoa(a.self))
	case "windows":
		stop, err = holdWindows()
	default:
		err = exec.ErrNotFound
	}
	if err != nil {
		a.failed = true
		a.note("Friday cannot keep this computer awake here; it may sleep while you are away")
		return
	}
	a.stop = stop
}

// Release lets the computer sleep again.
func (a *Awake) Release() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.stop != nil {
		a.stop()
		a.stop, a.running = nil, 0
	}
}

// Close releases for good.
func (a *Awake) Close() { a.Release() }

func (a *Awake) pid() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.running
}

// startProcess runs a helper until stopped; it is killed then, and waited for.
func (a *Awake) startProcess(name string, args ...string) (func(), error) {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	a.running = cmd.Process.Pid
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	return func() {
		_ = cmd.Process.Kill()
		<-done
	}, nil
}
