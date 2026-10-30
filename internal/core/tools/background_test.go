//go:build !windows

package tools

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// bg is a workspace whose background commands start fast and stop fast, closed when the test ends.
func bg(t *testing.T) (*Workspace, map[string]*tool.Tool) {
	t.Helper()
	w, tools := setup(t, nil)
	w.jobs.window = 300 * time.Millisecond
	w.jobs.grace = 500 * time.Millisecond
	t.Cleanup(w.Close)
	return w, tools
}

// start runs command in the background and returns its job.
func start(t *testing.T, w *Workspace, tools map[string]*tool.Tool, command string) *Job {
	t.Helper()
	r := call(t, tools["run_command"], tool.Args{"command": command, "background": true})
	id, _ := r.Data["id"].(string)
	j, ok := w.jobs.Get(id)
	if !ok {
		t.Fatalf("%q did not start: %+v", command, r)
	}
	return j
}

func waitDone(t *testing.T, j *Job, within time.Duration) {
	t.Helper()
	select {
	case <-j.Done():
	case <-time.After(within):
		t.Fatalf("%s did not end within %s", j.ID, within)
	}
}

// gone waits for a process to be gone: signal 0 fails with ESRCH (an orphan is reaped by init).
func gone(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); errors.Is(err, syscall.ESRCH) {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d is still alive", pid)
}

// pidsIn are the numbers a command printed one per line (`echo $!`).
func pidsIn(t *testing.T, text string) []int {
	t.Helper()
	var pids []int
	for _, line := range strings.Split(text, "\n") {
		if n, err := strconv.Atoi(strings.TrimSpace(line)); err == nil && n > 1 {
			pids = append(pids, n)
		}
	}
	return pids
}

func output(t *testing.T, tools map[string]*tool.Tool, args tool.Args) tool.Result {
	t.Helper()
	r := call(t, tools["command_output"], args)
	if r.IsError {
		t.Fatalf("command_output %v: %s", args, r.Content)
	}
	return r
}

func TestBackgroundStartReturnsAtOnceWithItsJobAndFirstOutput(t *testing.T) {
	w, tools := bg(t)
	w.jobs.window = 2 * time.Second
	began := time.Now()
	r := call(t, tools["run_command"], tool.Args{"command": "echo hello; echo oops >&2; sleep 30", "background": true})
	if r.IsError || !strings.HasPrefix(r.Content, "Started cmd1 in the background (pid ") || !strings.Contains(r.Content, "hello\noops") {
		t.Fatalf("start = %+v", r)
	}
	if d := time.Since(began); d < 1500*time.Millisecond || d > 4*time.Second {
		t.Fatalf("a running command returned after %s, want about the 2s window", d)
	}
	if r.Data["status"] != "running" || r.Data["id"] != "cmd1" || r.Data["pid"].(int) <= 0 || !strings.Contains(r.Content, "[next: since=") {
		t.Fatalf("data = %+v", r.Data)
	}
	// A background start is never a read, whatever it runs; a foreground `ls` still is.
	if e := tools["run_command"].CallEffect(tool.Args{"command": "ls", "background": true}); e != tool.EffectWorkspace {
		t.Fatalf("background ls effect = %s", e)
	}
	if e := tools["run_command"].CallEffect(tool.Args{"command": "ls"}); e != tool.EffectNone {
		t.Fatalf("foreground ls effect = %s", e)
	}
}

func TestBackgroundStartSeesACrashAtOnce(t *testing.T) {
	w, tools := bg(t)
	// The real window: a crash returns the moment it happens either way, and on a loaded machine
	// a shell takes longer than bg's 300 ms to say a program is missing.
	w.jobs.window = CommandStartWindow
	began := time.Now()
	r := call(t, tools["run_command"], tool.Args{"command": "echo boom >&2; exit 3", "background": true})
	if !r.IsError || !strings.Contains(r.Content, "cmd1 exited 3") || !strings.Contains(r.Content, "boom") || r.Data["exitCode"] != 3 {
		t.Fatalf("crash = %+v", r)
	}
	if d := time.Since(began); d > 2*time.Second {
		t.Fatalf("a command that ended at once took %s to report", d)
	}
	r = call(t, tools["run_command"], tool.Args{"command": "definitely-not-a-program-xyz", "background": true})
	if !r.IsError || r.Data["missingProgram"] != "definitely-not-a-program-xyz" {
		t.Fatalf("missing program = %+v", r)
	}
}

// TestStatusSettlesExactlyOnce: running, then exited with the shell's code, stopped, or failed,
// and never anything after; an observer watching all along sees no other sequence.
func TestStatusSettlesExactlyOnce(t *testing.T) {
	w, tools := bg(t)
	for _, c := range []struct {
		command string
		stop    bool
		want    JobStatus
		code    int
	}{
		{"exit 3", false, JobExited, 3},
		{"true", false, JobExited, 0},
		{"sleep 0.2; exit 42", false, JobExited, 42},
		{"kill -9 $$", false, JobExited, 137},
		{"sleep 30", true, JobStopped, 137},
	} {
		j := start(t, w, tools, c.command)
		var seen []JobStatus
		observed := make(chan struct{})
		go func() {
			defer close(observed)
			for {
				v := j.View()
				if len(seen) == 0 || seen[len(seen)-1] != v.Status {
					seen = append(seen, v.Status)
				}
				select {
				case <-j.Done():
					seen = append(seen, j.View().Status)
					return
				default:
					runtime.Gosched()
				}
			}
		}()
		if c.stop {
			w.jobs.Stop(j)
		}
		waitDone(t, j, 5*time.Second)
		<-observed
		seen = slices.Compact(seen)
		if last := seen[len(seen)-1]; last != c.want || (len(seen) == 2 && seen[0] != JobRunning) || len(seen) > 2 {
			t.Fatalf("%q went through %v, want running then %s", c.command, seen, c.want)
		}
		// Settling again, with anything, changes nothing.
		j.settle(JobFailed, 99, "late")
		v := j.View()
		if v.Status != c.want || v.ExitCode != c.code || j.transitions != 1 {
			t.Fatalf("%q: %+v after %d transitions, want %s %d once", c.command, v, j.transitions, c.want, c.code)
		}
		ended := v.Runtime
		time.Sleep(20 * time.Millisecond)
		if j.View().Runtime != ended {
			t.Fatalf("%q: runtime still grows after it ended", c.command)
		}
	}
}

// TestStopKillsTheWholeGroupAndIsIdempotent: what the command started dies with it, a command that
// ignores SIGTERM is killed after the grace, and a second stop only says it had ended.
func TestStopKillsTheWholeGroupAndIsIdempotent(t *testing.T) {
	w, tools := bg(t)
	j := start(t, w, tools, "sleep 100 & echo $!; sleep 100 & echo $!; wait")
	children := pidsIn(t, string(output(t, tools, tool.Args{"id": j.ID, "since": 0.0, "waitSeconds": 2.0}).Content))
	if len(children) != 2 {
		t.Fatalf("children = %v", children)
	}
	r := call(t, tools["stop_command"], tool.Args{"id": j.ID})
	if r.IsError || !strings.HasPrefix(r.Content, "Stopped. cmd1 stopped") || r.Data["status"] != "stopped" {
		t.Fatalf("stop = %+v", r)
	}
	for _, pid := range append(children, j.Pid) {
		gone(t, pid)
	}
	if err := syscall.Kill(-j.Pid, 0); !errors.Is(err, syscall.ESRCH) {
		t.Fatalf("the group %d survived: %v", j.Pid, err)
	}
	for range 3 {
		again := call(t, tools["stop_command"], tool.Args{"id": j.ID})
		if again.IsError || !strings.Contains(again.Content, "had already ended") || again.Data["status"] != "stopped" || j.transitions != 1 {
			t.Fatalf("second stop = %+v", again)
		}
	}

	stubborn := start(t, w, tools, "trap '' TERM; sleep 100")
	began := time.Now()
	call(t, tools["stop_command"], tool.Args{"id": stubborn.ID})
	if d := time.Since(began); d < w.jobs.grace || d > w.jobs.grace+3*time.Second {
		t.Fatalf("a command ignoring SIGTERM was stopped after %s, want just past the %s grace", d, w.jobs.grace)
	}
	if v := stubborn.View(); v.Status != JobStopped {
		t.Fatalf("stubborn = %+v", v)
	}
	gone(t, stubborn.Pid)

	// Its output stays readable after it is stopped.
	if r := output(t, tools, tool.Args{"id": j.ID, "since": 0.0}); !strings.Contains(r.Content, strconv.Itoa(children[0])) {
		t.Fatalf("output after stop = %q", r.Content)
	}
}

// TestCloseStopsEveryCommandAndLeaksNothing: closing the session ends every job, with all they
// started, including a sub-agent's in its own worktree; nothing starts after; and no goroutine is
// left behind.
func TestCloseStopsEveryCommandAndLeaksNothing(t *testing.T) {
	baseline := runtime.NumGoroutine()
	w, tools := setup(t, nil)
	w.jobs.window, w.jobs.grace = 100*time.Millisecond, 300*time.Millisecond
	sub := w.At(t.TempDir())
	subTools := map[string]*tool.Tool{}
	for _, tl := range sub.Builtins() {
		subTools[tl.Name] = tl
	}
	jobs := []*Job{
		start(t, w, tools, "sleep 100 & echo $!; wait"),
		start(t, w, tools, "trap '' TERM; sleep 100"),
		start(t, w, tools, "exit 0"),
		start(t, sub, subTools, "pwd; sleep 100"),
	}
	if len(w.jobs.List()) != 4 || len(sub.jobs.List()) != 4 {
		t.Fatal("a sub-agent's workspace does not share the session's background commands")
	}
	if r := output(t, tools, tool.Args{"id": "cmd4", "since": 0.0}); !strings.Contains(r.Content, sub.Root) {
		t.Fatalf("a sub-agent's command did not run in its own root: %q", r.Content)
	}
	grandchild := pidsIn(t, output(t, tools, tool.Args{"id": "cmd1", "since": 0.0}).Content)
	w.Close()
	for _, j := range jobs {
		select {
		case <-j.Done():
		default:
			t.Fatalf("%s is still running after Close", j.ID)
		}
		gone(t, j.Pid)
	}
	for _, pid := range grandchild {
		gone(t, pid)
	}
	if s := jobs[0].View().Status; s != JobStopped {
		t.Fatalf("cmd1 = %s after Close", s)
	}
	if s := jobs[2].View().Status; s != JobExited {
		t.Fatalf("a command that had exited became %s on Close", s)
	}
	r := call(t, tools["run_command"], tool.Args{"command": "sleep 1", "background": true})
	if !r.IsError || r.Data["reason"] != "session_closing" {
		t.Fatalf("start after Close = %+v", r)
	}
	w.Close() // twice is fine
	deadline := time.Now().Add(3 * time.Second)
	for runtime.NumGoroutine() > baseline && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := runtime.NumGoroutine(); n > baseline {
		buf := make([]byte, 1<<16)
		t.Fatalf("%d goroutines after Close, %d before:\n%s", n, baseline, buf[:runtime.Stack(buf, true)])
	}
}

// TestWaitReturnsOnOutputOnExitOnMatchAndAtTheDeadline: waitSeconds blocks only until there is
// news, and returns at the deadline when there is none.
func TestWaitReturnsOnOutputOnExitOnMatchAndAtTheDeadline(t *testing.T) {
	w, tools := bg(t)
	w.jobs.window = 50 * time.Millisecond
	timed := func(args tool.Args) (tool.Result, time.Duration) {
		began := time.Now()
		r := output(t, tools, args)
		return r, time.Since(began)
	}

	late := start(t, w, tools, "sleep 0.4; echo late; sleep 30")
	r, d := timed(tool.Args{"id": late.ID, "waitSeconds": 20.0})
	if !strings.Contains(r.Content, "late") || d > 3*time.Second {
		t.Fatalf("wait for output: %s after %s", r.Content, d)
	}

	exits := start(t, w, tools, "sleep 0.4; exit 4")
	r, d = timed(tool.Args{"id": exits.ID, "waitSeconds": 20.0})
	if !strings.Contains(r.Content, "exited 4") || d > 3*time.Second {
		t.Fatalf("wait for exit: %s after %s", r.Content, d)
	}

	quiet := start(t, w, tools, "sleep 30")
	r, d = timed(tool.Args{"id": quiet.ID, "waitSeconds": 1.0})
	if !strings.Contains(r.Content, "(no new output)") || d < 900*time.Millisecond || d > 3*time.Second {
		t.Fatalf("wait with no news: %s after %s", r.Content, d)
	}

	ready := start(t, w, tools, "for i in 1 2 3 4 5; do echo line $i; sleep 0.1; done; echo server READY on 8080; sleep 30")
	r, d = timed(tool.Args{"id": ready.ID, "since": 0.0, "waitSeconds": 20.0, "pattern": "READY"})
	if !strings.Contains(r.Content, "server READY on 8080") || strings.Contains(r.Content, "line 1") || d > 4*time.Second {
		t.Fatalf("wait for a match: %s after %s", r.Content, d)
	}

	// A cancelled turn stops the wait.
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	began := time.Now()
	tools["command_output"].Run(ctx, tool.Context{}, tool.Args{"id": quiet.ID, "waitSeconds": 30.0, "pattern": "never"})
	if d := time.Since(began); d > 2*time.Second {
		t.Fatalf("a cancelled wait took %s", d)
	}

	// The wait is capped.
	if CommandWaitCeiling > 60*time.Second {
		t.Fatalf("CommandWaitCeiling = %s", CommandWaitCeiling)
	}
}

// TestPatternHoldsAnUnfinishedLine: a line still being written is not matched or skipped: the
// cursor stops before it and the next read sees it whole.
func TestPatternHoldsAnUnfinishedLine(t *testing.T) {
	w, tools := bg(t)
	j := start(t, w, tools, "printf 'ok 1\\nok 2\\nok'; sleep 0.5; printf ' 3\\n'; sleep 30")
	r := output(t, tools, tool.Args{"id": j.ID, "since": 0.0, "pattern": "^ok"})
	if !strings.HasSuffix(r.Content, "\nok 1\nok 2\n[next: since=10]") || r.Data["next"] != int64(10) {
		t.Fatalf("first read = %q", r.Content)
	}
	r = output(t, tools, tool.Args{"id": j.ID, "waitSeconds": 5.0, "pattern": "^ok"})
	if !strings.HasSuffix(r.Content, "\nok 3\n[next: since=15]") {
		t.Fatalf("second read = %q", r.Content)
	}
}

// TestCursorsNeverRepeatAndTailKeepsTheEnd: reads with no cursor follow on from the last, and tail
// keeps the last lines.
func TestCursorsNeverRepeatAndTailKeepsTheEnd(t *testing.T) {
	w, tools := bg(t)
	j := start(t, w, tools, "seq 1 3; sleep 0.3; seq 4 6")
	waitDone(t, j, 5*time.Second)
	// The start already returned 1 to 3 (or more); together the reads are 1..6 once each.
	var got []string
	for _, args := range []tool.Args{{"id": j.ID, "since": 0.0}, {"id": j.ID}} {
		r := output(t, tools, args)
		lines := strings.Split(r.Content, "\n")[1:]
		for _, l := range lines {
			if l != "(no new output)" {
				got = append(got, l)
			}
		}
	}
	if strings.Join(got, ",") != "1,2,3,4,5,6" {
		t.Fatalf("reads = %v", got)
	}

	long := start(t, w, tools, "seq 1 1000")
	waitDone(t, long, 5*time.Second)
	r := output(t, tools, tool.Args{"id": long.ID, "since": 0.0, "tail": 3.0})
	if !strings.HasSuffix(r.Content, "\n998\n999\n1000") || r.Data["next"] != long.View().Bytes {
		t.Fatalf("tail = %q %+v", r.Content, r.Data)
	}
}

// TestConcurrentReadersSeeOneConsistentStream: many readers, each following its own cursor while
// the command writes, each get every byte at most once, at the offset it belongs, and account for
// every other byte as dropped. Run under -race.
func TestConcurrentReadersSeeOneConsistentStream(t *testing.T) {
	w, tools := bg(t)
	w.jobs.headBytes, w.jobs.tailBytes = 1000, 50_000
	const n = 100_000
	var want strings.Builder
	for i := 1; i <= n; i++ {
		fmt.Fprintf(&want, "%d\n", i)
	}
	expected := want.String()
	j := start(t, w, tools, fmt.Sprintf("seq 1 %d", n))
	var wg sync.WaitGroup
	errs := make(chan error, 16)
	for r := 0; r < 8; r++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			var cursor, delivered, dropped int64
			for {
				c, v := j.read(cursor, 1+r*997, false, false)
				if string(c.Before) != expected[c.Since:c.Since+int64(len(c.Before))] {
					errs <- fmt.Errorf("reader %d: wrong bytes at %d", r, c.Since)
					return
				}
				afterAt := c.Since + int64(len(c.Before)) + c.Dropped
				if string(c.After) != expected[afterAt:afterAt+int64(len(c.After))] {
					errs <- fmt.Errorf("reader %d: wrong bytes after the gap at %d", r, afterAt)
					return
				}
				if c.Next < cursor {
					errs <- fmt.Errorf("reader %d: cursor went back", r)
					return
				}
				delivered += int64(len(c.Before) + len(c.After))
				dropped += c.Dropped
				cursor = c.Next
				if v.Status != JobRunning && c.Pending == 0 {
					if delivered+dropped != int64(len(expected)) {
						errs <- fmt.Errorf("reader %d: %d delivered + %d dropped != %d", r, delivered, dropped, len(expected))
					}
					return
				}
				if c.Pending == 0 {
					j.Await(context.Background(), cursor, time.Now().Add(time.Second))
				}
			}
		}()
	}
	// The tools, at the same time.
	for range 4 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for range 20 {
				call(t, tools["list_commands"], tool.Args{})
				call(t, tools["command_output"], tool.Args{"id": j.ID, "tail": 2.0})
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Error(err)
	}
}

// TestRunningCommandsAreLimitedAndFinishedOnesForgotten: a start past MaxBackgroundCommands is
// refused, saying which run and how to make room; past the kept number the oldest finished one
// is forgotten.
func TestRunningCommandsAreLimitedAndFinishedOnesForgotten(t *testing.T) {
	w, tools := bg(t)
	w.jobs.window = 10 * time.Millisecond
	var running []*Job
	for range MaxBackgroundCommands {
		running = append(running, start(t, w, tools, "sleep 30"))
	}
	r := call(t, tools["run_command"], tool.Args{"command": "sleep 30", "background": true})
	if !r.IsError || r.Data["reason"] != "too_many_background_commands" || !strings.Contains(r.Content, "stop_command") || !strings.Contains(r.Content, "cmd1") {
		t.Fatalf("one too many = %+v", r)
	}
	call(t, tools["stop_command"], tool.Args{"id": running[0].ID})
	if r := call(t, tools["run_command"], tool.Args{"command": "sleep 30", "background": true}); r.IsError {
		t.Fatalf("after a stop = %+v", r)
	}

	w2, tools2 := bg(t)
	w2.jobs.window, w2.jobs.kept = 10*time.Millisecond, 3
	for range 5 {
		waitDone(t, start(t, w2, tools2, "true"), 5*time.Second)
	}
	list := call(t, tools2["list_commands"], tool.Args{})
	if rows := list.Data["commands"].([]map[string]any); len(rows) != 3 || rows[0]["id"] != "cmd3" {
		t.Fatalf("kept = %+v", list.Data)
	}
	if r := call(t, tools2["command_output"], tool.Args{"id": "cmd1"}); !r.IsError || !strings.Contains(r.Content, "there are cmd3, cmd4, cmd5") {
		t.Fatalf("a forgotten job = %+v", r)
	}
	if r := call(t, tools2["command_output"], tool.Args{}); !r.IsError {
		t.Fatalf("no id = %+v", r)
	}
	if r := call(t, tools2["command_output"], tool.Args{"id": "cmd5", "pattern": "("}); !r.IsError || !strings.Contains(r.Content, "`pattern`") {
		t.Fatalf("bad pattern = %+v", r)
	}
}

// TestBackgroundObeysTheSameRules: what is refused in the foreground is refused in the
// background, and nothing starts.
func TestBackgroundObeysTheSameRules(t *testing.T) {
	w, tools := bg(t)
	w.Rules = []policy.CommandRule{{Prefix: []policy.PrefixWord{policy.Word("curl")}, Decision: "forbid", Source: "test"}}
	for command, reason := range map[string]string{
		"curl https://example.com": "command_rule",
		"rm -rf /":                 "refused_command",
		"git reset --hard HEAD~3":  "refused_command",
	} {
		r := call(t, tools["run_command"], tool.Args{"command": command, "background": true})
		if !r.IsError || r.Data["reason"] != reason {
			t.Errorf("%q in the background = %+v", command, r)
		}
	}
	if n := len(w.jobs.List()); n != 0 {
		t.Fatalf("%d jobs started from refused commands", n)
	}
}

// TestOnlyThoseWhoRunCommandsGetBackgroundTools: the new tools are terminal tools, so plan mode
// gets none of them; reads are parallel and change nothing; stop runs alone. That read-only roles
// get none either is checked where roles meet tools (core/agents, background_roles_test.go).
func TestOnlyThoseWhoRunCommandsGetBackgroundTools(t *testing.T) {
	_, tools := bg(t)
	for _, name := range []string{"command_output", "stop_command", "list_commands"} {
		tl := tools[name]
		if tl.Capability != tool.CapTerminal || tl.Effect != tool.EffectNone {
			t.Errorf("%s: %s, %s", name, tl.Capability, tl.Effect)
		}
		if slices.Contains(policy.CapabilitiesForMode(policy.Plan), tl.Capability) {
			t.Errorf("plan mode would get %s", name)
		}
	}
	if !tools["command_output"].ParallelSafe || !tools["list_commands"].ParallelSafe || tools["stop_command"].ParallelSafe {
		t.Error("reads run together; a stop runs alone")
	}
}

// TestReadAfterFiftyMegabytesIsCheap: a command that printed 50 MB holds no more than its bound,
// and reading what is new costs what is new.
func TestReadAfterFiftyMegabytesIsCheap(t *testing.T) {
	w, tools := bg(t)
	j := start(t, w, tools, "head -c 50000000 /dev/zero | tr '\\0' 'x'; echo; echo done")
	waitDone(t, j, 30*time.Second)
	if v := j.View(); v.Bytes != 50_000_000+1+5 {
		t.Fatalf("bytes = %d", v.Bytes)
	}
	j.mu.Lock()
	held := cap(j.out.head) + cap(j.out.tail)
	j.mu.Unlock()
	if held > CommandHeadBytes+CommandTailBytes {
		t.Fatalf("holds %d bytes for 50 MB of output", held)
	}
	began := time.Now()
	r := output(t, tools, tool.Args{"id": j.ID, "since": float64(50_000_000)})
	if d := time.Since(began); d > 50*time.Millisecond || !strings.HasSuffix(r.Content, "\ndone") {
		t.Fatalf("read of the newest bytes took %s: %q", d, r.Content)
	}
	// From the start: the 20,000-byte head, the dropped middle counted, then ring bytes up to the
	// read limit, and where to read on.
	r = output(t, tools, tool.Args{"id": j.ID, "since": 0.0})
	if !strings.Contains(r.Content, "\n[… 49,780,006 bytes dropped …]\n") || !strings.HasSuffix(r.Content, "[190,000 more bytes; read on with since=49810006]") || r.Data["dropped"] != int64(49_780_006) {
		t.Fatalf("a read from the start: %q", r.Content[len(r.Content)-120:])
	}
	r = output(t, tools, tool.Args{"id": j.ID, "since": 30_000.0})
	if !strings.Contains(r.Content, "[… 49,770,006 bytes dropped …]") {
		t.Fatalf("a stale cursor does not say what it missed: %q", r.Content[:200])
	}
}

// TestCommandOutputProgressMovesOnlyWithTheJob: the stuck-call detector reads Data["progress"]; it
// changes when the job prints or ends, and a read that waited on a running job is never a repeat.
func TestCommandOutputProgressMovesOnlyWithTheJob(t *testing.T) {
	w, tools := bg(t)
	j := start(t, w, tools, "echo one; sleep 0.4; echo two")
	read := func(args tool.Args) string {
		args["id"], args["since"] = j.ID, 0
		p, _ := call(t, tools["command_output"], args).Data["progress"].(string)
		return p
	}
	if p := read(tool.Args{"waitSeconds": 1}); !strings.HasPrefix(p, "waited") && !strings.HasPrefix(p, "exited") {
		t.Fatalf("a read that waited on a running job reports its wait: %q", p)
	}
	waitDone(t, j, 3*time.Second)
	first, second := read(tool.Args{}), read(tool.Args{})
	if first != second || !strings.HasPrefix(first, "exited") {
		t.Fatalf("two reads of an ended job are the same news: %q, %q", first, second)
	}
}
