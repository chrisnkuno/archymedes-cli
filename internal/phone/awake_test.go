package phone

import (
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// Keeping the computer awake while someone works from their phone: held once however often it is
// asked, let go when asked, never leaving a helper running behind.

type fakeStarter struct {
	mu      sync.Mutex
	started [][]string
	running int
	fail    bool
}

func (f *fakeStarter) start(name string, args ...string) (func(), error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.fail {
		return nil, exec.ErrNotFound
	}
	f.started = append(f.started, append([]string{name}, args...))
	f.running++
	return func() { f.mu.Lock(); f.running--; f.mu.Unlock() }, nil
}

func (f *fakeStarter) state() (starts, running int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.started), f.running
}

// INVARIANT: however Hold and Release interleave, at most one helper runs, and none after Release.
func TestAwakeIsHeldOnceAndLetGo(t *testing.T) {
	f := &fakeStarter{}
	a := newAwake("linux", 4242, f.start)
	for _, step := range []bool{true, true, false, false, true, false, true, true, true, false} {
		if step {
			a.Hold()
		} else {
			a.Release()
		}
		if _, running := f.state(); running > 1 || (!step && running != 0) {
			t.Fatalf("after hold=%v, %d helpers run", step, running)
		}
	}
	a.Close()
	if _, running := f.state(); running != 0 {
		t.Fatal("a helper still runs after close")
	}
}

// BEHAVIOUR: each system's way of staying awake, tied to Friday so it ends with it.
func TestEachSystemStaysAwakeItsOwnWay(t *testing.T) {
	cases := map[string][]string{
		"linux":  {"systemd-inhibit", "--what=idle:sleep", "--who=Friday", "--mode=block"},
		"darwin": {"caffeinate", "-i", "-w", "4242"},
	}
	for goos, want := range cases {
		f := &fakeStarter{}
		a := newAwake(goos, 4242, f.start)
		a.Hold()
		if len(f.started) != 1 {
			t.Fatalf("%s: started %v", goos, f.started)
		}
		got := strings.Join(f.started[0], " ")
		for _, w := range want {
			if !strings.Contains(got, w) {
				t.Fatalf("%s: %q lacks %q", goos, got, w)
			}
		}
		a.Close()
	}
}

// BEHAVIOUR: with no way to stay awake, it says so once and asks nothing again.
func TestWithoutAWayToStayAwakeItSaysSoOnce(t *testing.T) {
	f := &fakeStarter{fail: true}
	a := newAwake("linux", 1, f.start)
	var notes []string
	a.note = func(s string) { notes = append(notes, s) }
	for range 5 {
		a.Hold()
		a.Release()
	}
	if len(notes) != 1 || !strings.Contains(notes[0], "awake") {
		t.Fatalf("notes %v", notes)
	}
}

// FUNCTIONAL: on Linux with systemd-inhibit present, the real helper runs while held and is gone
// after release.
func TestTheRealHelperComesAndGoes(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux only")
	}
	if _, err := exec.LookPath("systemd-inhibit"); err != nil {
		t.Skip("no systemd-inhibit here")
	}
	a := NewAwake()
	a.Hold()
	time.Sleep(200 * time.Millisecond)
	pid := a.pid()
	if pid == 0 {
		t.Skip("systemd-inhibit could not hold here (no session bus)")
	}
	a.Close()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		out, _ := exec.Command("ps", "-o", "pid=", "-p", strconv.Itoa(pid)).Output()
		if strings.TrimSpace(string(out)) == "" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("the helper outlived Close")
}
