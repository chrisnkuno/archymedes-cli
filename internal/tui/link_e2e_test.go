package tui

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/phone/phonetest"
)

// End to end, through a real relay: the Worker in the site repository (workers/phone), run with
// `wrangler dev`. Skipped unless FRIDAY_PHONE_E2E_RELAY names it, e.g. ws://127.0.0.1:8799, and,
// for the page's own JavaScript, FRIDAY_PHONE_E2E_PAGE names that Worker's folder.

func e2eRelay(t *testing.T) string {
	relay := os.Getenv("FRIDAY_PHONE_E2E_RELAY")
	if relay == "" {
		t.Skip("set FRIDAY_PHONE_E2E_RELAY to a running phone relay (wrangler dev in workers/phone)")
	}
	return relay
}

// linkedTo is a paired model on a real relay, with no phone yet.
func linkedTo(t *testing.T, relay string) *linked {
	t.Helper()
	t.Setenv("ARCHYMEDES_PHONE_RELAY", relay)
	t.Setenv("ARCHYMEDES_NOTIFY_URL", "")
	m, agent := newTestModel(t)
	m.Update(tea.WindowSizeMsg{Width: 120, Height: 36})
	l := &linked{m: m, agent: agent, inbox: make(chan tea.Msg, 512), dir: t.TempDir(), awake: &fakeAwake{}}
	m.opts.ConfigDir = l.dir
	m.SetSender(func(msg tea.Msg) {
		select {
		case l.inbox <- msg:
		default:
		}
	})
	m.linkAwake = l.awake
	t.Cleanup(func() { m.linkStop() })
	l.run("/phone")
	press(m, 'q', 0)
	l.pump(t, func() bool { return m.link != nil && m.link.online }, "Friday never reached the real relay")
	return l
}

// FUNCTIONAL, real relay: a phone (the Go test phone) drives a turn and answers an approval
// through the Worker and its Durable Object.
func TestE2EThroughTheRealRelay(t *testing.T) {
	relay := e2eRelay(t)
	l := linkedTo(t, relay)
	l.phone = phonetest.NewPhone(t, relay, l.secret(t))
	l.pump(t, func() bool { return l.m.link.phones == 1 }, "the real relay never said the phone joined")
	state := l.hello(t)
	if state["phase"] != "ready" {
		t.Fatalf("state %v", state)
	}
	l.ask(t, map[string]any{"type": "send", "text": "through the real relay"})
	var heard []string
	l.m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{ToolCallID: "c1", Title: "run_command: make deploy"},
		[]acp.PermissionOption{{OptionID: "allow", Name: "Allow"}, {OptionID: "deny", Name: "Deny"}}, func(id string) { heard = append(heard, id) })})
	a := l.until(t, func(s map[string]any) bool { return s["approval"] != nil }, "the approval never reached the phone")["approval"].(map[string]any)
	if ack := l.ask(t, map[string]any{"type": "answer", "approval": a["id"], "choice": "allow"}); ack["ok"] != true {
		t.Fatalf("answer: %v", ack)
	}
	l.agent.mu.Lock()
	prompts := slices.Clone(l.agent.prompts)
	l.agent.mu.Unlock()
	if len(prompts) != 1 || !strings.Contains(prompts[0], "through the real relay") || !slices.Equal(heard, []string{"allow"}) {
		t.Fatalf("prompts %q, approval heard %v", prompts, heard)
	}
}

// FUNCTIONAL, real relay and the page's own JavaScript: the phone page's lib.js pairs, says hello,
// gets the state, sends a message that becomes a turn, waits for the approval and allows it.
func TestE2EThePagesOwnCodeDrivesFriday(t *testing.T) {
	relay := e2eRelay(t)
	page := os.Getenv("FRIDAY_PHONE_E2E_PAGE")
	if page == "" {
		t.Skip("set FRIDAY_PHONE_E2E_PAGE to the workers/phone folder")
	}
	l := linkedTo(t, relay)
	steps, _ := json.Marshal([]map[string]any{
		{"type": "hello", "device": "e2e"},
		{"type": "send", "text": "from the page's own code"},
		{"wait": "approval"},
		{"type": "answer", "approval": "$current", "choice": "allow"},
	})
	cmd := exec.Command("bun", "test/e2e-phone.js", relay, l.secret(t).Encode(), string(steps))
	cmd.Dir = page
	out, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	lines := make(chan map[string]any, 256)
	go func() {
		s := bufio.NewScanner(out)
		s.Buffer(make([]byte, 1<<20), 1<<22)
		for s.Scan() {
			var m map[string]any
			if json.Unmarshal(s.Bytes(), &m) == nil {
				lines <- m
			}
		}
		close(lines)
	}()
	var heard []string
	asked, done := false, false
	var last map[string]any
	deadline := time.After(40 * time.Second)
	for !done {
		select {
		case msg := <-l.inbox:
			_, c := l.m.Update(msg)
			deliver(l.m, c)
		case line, ok := <-lines:
			if !ok {
				t.Fatal("the page's phone ended early")
			}
			if line["refused"] != nil {
				t.Fatal("the page could not open a frame from Friday")
			}
			if line["timeout"] != nil || line["closed"] != nil {
				t.Fatalf("the page's phone: %v", line)
			}
			if s, ok := line["state"].(map[string]any); ok {
				last = s
			}
			done = line["done"] == true
		case <-time.After(30 * time.Millisecond):
			deliver(l.m, l.m.linkAfter())
		case <-deadline:
			t.Fatalf("the page's phone did not finish; last state %v", last)
		}
		l.agent.mu.Lock()
		prompted := len(l.agent.prompts) == 1
		l.agent.mu.Unlock()
		if prompted && !asked {
			asked = true
			l.m.Update(agentMsg{acp.NewPermissionRequestForTest(acp.ToolCallRef{ToolCallID: "c1", Title: "run_command: make deploy"},
				[]acp.PermissionOption{{OptionID: "allow", Name: "Allow"}, {OptionID: "deny", Name: "Deny"}}, func(id string) { heard = append(heard, id) })})
		}
	}
	l.agent.mu.Lock()
	prompts := slices.Clone(l.agent.prompts)
	l.agent.mu.Unlock()
	if len(prompts) != 1 || !strings.Contains(prompts[0], "from the page's own code") {
		t.Fatalf("Friday heard %q", prompts)
	}
	if !slices.Equal(heard, []string{"allow"}) {
		t.Fatalf("the approval heard %v", heard)
	}
	if u := lastItem(last, "user"); u == nil || u["text"] != "from the page's own code" {
		t.Fatalf("the page's picture lacks the message: %v", last)
	}
}

// until takes what the phone is sent into its view until cond holds of its picture, or fails after
// a deadline: over the internet, a quiet spell is no sign that everything has arrived.
func (l *linked) until(t *testing.T, cond func(map[string]any) bool, what string) map[string]any {
	t.Helper()
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		if v := l.drain(t); v != nil && v.state != nil && cond(v.state) {
			return v.state
		}
	}
	t.Fatal(what)
	return nil
}

// FUNCTIONAL, real relay and the page's own code: a large binary file and a text file arrive on the
// phone byte for byte, chunk by chunk through the Worker.
func TestE2EThePageReadsTheProjectsFiles(t *testing.T) {
	relay := e2eRelay(t)
	page := os.Getenv("FRIDAY_PHONE_E2E_PAGE")
	if page == "" {
		t.Skip("set FRIDAY_PHONE_E2E_PAGE to the workers/phone folder")
	}
	l := linkedTo(t, relay)
	root := t.TempDir()
	big := make([]byte, 700_000)
	for i := range big {
		big[i] = byte(i*31 + i/7)
	}
	_ = os.WriteFile(root+"/manual.pdf", append([]byte("%PDF-1.7\n"), big...), 0o644)
	_ = os.WriteFile(root+"/README.md", []byte("# Read me\n\nFrom the phone.\n"), 0o644)
	l.m.opts.Cwd, l.m.session.Info.Root = root, root
	steps, _ := json.Marshal([]map[string]any{{"type": "hello"}, {"fetch": "manual.pdf"}, {"fetch": "README.md"}})
	cmd := exec.Command("bun", "test/e2e-phone.js", relay, l.secret(t).Encode(), string(steps))
	cmd.Dir = page
	out, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
	lines := make(chan map[string]any, 256)
	go func() {
		s := bufio.NewScanner(out)
		s.Buffer(make([]byte, 1<<20), 1<<22)
		for s.Scan() {
			var m map[string]any
			if json.Unmarshal(s.Bytes(), &m) == nil {
				lines <- m
			}
		}
		close(lines)
	}()
	fetched := map[string]string{}
	deadline := time.After(60 * time.Second)
	for done := false; !done; {
		select {
		case msg := <-l.inbox:
			_, c := l.m.Update(msg)
			l.exec(c)
		case line, ok := <-lines:
			if !ok {
				t.Fatal("the page's phone ended early")
			}
			if line["badChunk"] != nil || line["refused"] != nil || line["timeout"] != nil || line["closed"] != nil {
				t.Fatalf("the page's phone: %v", line)
			}
			if p, ok := line["fetched"].(string); ok {
				fetched[p] = line["sha256"].(string)
			}
			done = line["done"] == true
		case <-time.After(30 * time.Millisecond):
			l.exec(l.m.linkAfter())
		case <-deadline:
			t.Fatalf("the page did not finish reading; got %v", fetched)
		}
	}
	for _, name := range []string{"manual.pdf", "README.md"} {
		disk, _ := os.ReadFile(root + "/" + name)
		sum := sha256.Sum256(disk)
		if fetched[name] != hex.EncodeToString(sum[:]) {
			t.Fatalf("%s on the phone is not the file on disk (%s vs %x)", name, fetched[name], sum)
		}
	}
}
