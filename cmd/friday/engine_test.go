package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/server"
)

// The ACP contract, held by the Go engine through the very client the interface uses: whatever
// passes here, the interface can drive. Each step is what a person does in the interface.

type scriptedModel struct {
	id    string
	turns func(call fantasy.Call) (text string, calls [][2]string)
	n     *atomic.Int64
}

func (m scriptedModel) Model() string    { return m.id }
func (m scriptedModel) Provider() string { return "groq" }
func (m scriptedModel) Generate(context.Context, fantasy.Call) (*fantasy.Response, error) {
	return nil, errors.New("unused")
}
func (m scriptedModel) GenerateObject(context.Context, fantasy.ObjectCall) (*fantasy.ObjectResponse, error) {
	return nil, errors.New("unused")
}
func (m scriptedModel) StreamObject(context.Context, fantasy.ObjectCall) (fantasy.ObjectStreamResponse, error) {
	return nil, errors.New("unused")
}

func (m scriptedModel) Stream(_ context.Context, call fantasy.Call) (fantasy.StreamResponse, error) {
	n := m.n.Add(1)
	text, calls := m.turns(call)
	return func(yield func(fantasy.StreamPart) bool) {
		if text != "" && !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeTextDelta, Delta: text}) {
			return
		}
		for i, c := range calls {
			if !yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeToolCall, ID: fmt.Sprintf("call-%d-%d", n, i), ToolCallName: c[0], ToolCallInput: c[1]}) {
				return
			}
		}
		yield(fantasy.StreamPart{Type: fantasy.StreamPartTypeFinish, FinishReason: fantasy.FinishReasonStop, Usage: fantasy.Usage{InputTokens: 20, OutputTokens: 4}})
	}, nil
}

func lastMessage(call fantasy.Call) (fantasy.MessageRole, string) {
	m := call.Prompt[len(call.Prompt)-1]
	var b strings.Builder
	for _, p := range m.Content {
		switch v := p.(type) {
		case fantasy.TextPart:
			b.WriteString(v.Text)
		case fantasy.ToolResultPart:
			if t, ok := v.Output.(fantasy.ToolResultOutputContentText); ok {
				b.WriteString(t.Text)
			}
			if e, ok := v.Output.(fantasy.ToolResultOutputContentError); ok {
				b.WriteString("ERROR " + e.Error.Error())
			}
		}
	}
	return m.Role, b.String()
}

// engine starts the Go engine in-process behind the real client.
func engine(t *testing.T, root string, turns func(fantasy.Call) (string, [][2]string), forward server.Forwarder) *acp.Client {
	t.Helper()
	var n atomic.Int64
	opts := server.Options{
		Cwd: root, ConfigDir: t.TempDir(), Environ: []string{"GROQ_API_KEY=test", "ARCHYMEDES_TEST_FIRST=off", "ARCHYMEDES_TITLES=off"}, Provider: "groq",
		Open: func(_ context.Context, _ llm.Selection, _ llm.Env, id string) (fantasy.LanguageModel, error) {
			return scriptedModel{id: id, turns: turns, n: &n}, nil
		},
		Forward: forward,
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	client, err := startGoEngine(opts, nil)(ctx)
	if err != nil {
		t.Fatal(err)
	}
	c := client.(*acp.Client)
	t.Cleanup(c.Close)
	return c
}

// collected is what the client delivered for one turn.
type collected struct {
	text     string
	events   []acp.Event
	asked    []acp.PermissionRequest
	stop     string
	replayed []string
}

// turn sends a prompt and gathers the turn's messages, answering approvals with answer.
func turn(t *testing.T, c *acp.Client, sessionID, prompt, answer string) collected {
	t.Helper()
	var got collected
	done := make(chan error, 1)
	go func() {
		_, err := c.Prompt(context.Background(), sessionID, prompt)
		done <- err
	}()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case msg := <-c.Messages():
			switch m := msg.(type) {
			case acp.TextChunk:
				got.text += m.Text
			case acp.AgentEvent:
				got.events = append(got.events, m.Event)
			case acp.PermissionRequest:
				got.asked = append(got.asked, m)
				m.Answer(answer)
			case acp.TurnEnded:
				got.stop = m.StopReason
				if err := <-done; err != nil {
					t.Fatal(err)
				}
				return got
			case acp.Exited:
				t.Fatalf("engine exited: %v %s", m.Err, m.Stderr)
			}
		case <-timeout:
			t.Fatalf("turn did not end; so far %+v", got)
		}
	}
}

func runtimeTypes(events []acp.Event) []string {
	var out []string
	for _, ev := range events {
		if ev.Type == "runtime" && ev.Event != nil {
			out = append(out, ev.Event.Type)
		} else {
			out = append(out, ev.Type)
		}
	}
	return out
}

func TestContractATurnWithAnApprovedEdit(t *testing.T) {
	root := t.TempDir()
	c := engine(t, root, func(call fantasy.Call) (string, [][2]string) {
		role, text := lastMessage(call)
		switch {
		case role == fantasy.MessageRoleUser && text == "make hello.txt":
			return "Writing it.", [][2]string{{"write_file", `{"path":"hello.txt","content":"hi"}`}}
		case role == fantasy.MessageRoleUser: // the gate asking for evidence
			return " Nothing to run for a text file.", nil
		}
		return "Done: " + text, nil
	}, nil)
	sess, err := c.NewSession(context.Background(), root, "")
	if err != nil {
		t.Fatal(err)
	}
	if sess.Info.Provider != "groq" || sess.Info.Mode != "build" || sess.Info.Root != root || sess.ID == "" {
		t.Fatalf("session info = %+v", sess)
	}
	got := turn(t, c, sess.ID, "make hello.txt", "allow")
	if got.stop != "end_turn" || !strings.Contains(got.text, "Writing it.") || !strings.Contains(got.text, "Done: Wrote hello.txt") || !strings.Contains(got.text, "Nothing to run") {
		t.Fatalf("turn = %+v", got)
	}
	if len(got.asked) != 1 || got.asked[0].ToolCall.Kind != "edit" || !strings.Contains(got.asked[0].ToolCall.Title, "hello.txt") || len(got.asked[0].Options) != 4 {
		t.Fatalf("approval = %+v", got.asked)
	}
	if data, _ := os.ReadFile(filepath.Join(root, "hello.txt")); string(data) != "hi" {
		t.Fatalf("file = %q", data)
	}
	types := strings.Join(runtimeTypes(got.events), ",")
	for _, want := range []string{"model_turn", "tool_call", "tool_result", "runtime_stop"} {
		if !strings.Contains(types, want) {
			t.Fatalf("events %s lack %s", types, want)
		}
	}
	if strings.Contains(types, "assistant_delta") {
		t.Fatal("assistant text was repeated on the extension channel")
	}
}

func TestContractADeniedEditIsNotWritten(t *testing.T) {
	root := t.TempDir()
	c := engine(t, root, func(call fantasy.Call) (string, [][2]string) {
		role, text := lastMessage(call)
		if role == fantasy.MessageRoleUser {
			return "", [][2]string{{"write_file", `{"path":"x.txt","content":"no"}`}}
		}
		return text, nil
	}, nil)
	sess, _ := c.NewSession(context.Background(), root, "")
	got := turn(t, c, sess.ID, "write x", "")
	if _, err := os.Stat(filepath.Join(root, "x.txt")); err == nil {
		t.Fatal("a denied write happened")
	}
	if !strings.Contains(got.text, "declined") {
		t.Fatalf("text = %q", got.text)
	}
}

func TestContractPlanModeSteeringCommandsAndResume(t *testing.T) {
	root := t.TempDir()
	_ = os.WriteFile(filepath.Join(root, "a.go"), []byte("package a\n"), 0o644)
	var steerOnce sync.Once
	var client *acp.Client
	var sessionID string
	c := engine(t, root, func(call fantasy.Call) (string, [][2]string) {
		role, text := lastMessage(call)
		if role == fantasy.MessageRoleUser && strings.HasPrefix(text, "plan") {
			steerOnce.Do(func() {
				ok, err := client.Steer(context.Background(), sessionID, "mention the package")
				if err != nil || !ok {
					panic(fmt.Sprintf("steer: %v %v", ok, err))
				}
			})
			return "", [][2]string{{"todo_write", `{"items":["read a.go","plan"]}`}, {"read_file", `{"path":"a.go"}`}}
		}
		if role == fantasy.MessageRoleUser {
			return "noted: " + text, nil
		}
		return "Plan ready.", nil
	}, nil)
	client = c
	sess, _ := c.NewSession(context.Background(), root, "")
	sessionID = sess.ID
	if err := c.SetMode(context.Background(), sess.ID, "plan"); err != nil {
		t.Fatal(err)
	}
	got := turn(t, c, sess.ID, "plan the change", "allow")
	if len(got.asked) != 0 || !strings.Contains(got.text, "noted: mention the package") {
		t.Fatalf("plan turn = %+v", got)
	}
	todos, err := c.Command(context.Background(), sess.ID, "todos", "")
	if err != nil || todos.Kind != "todos" || len(todos.Items) != 2 {
		t.Fatalf("todos = %+v, %v", todos, err)
	}
	if res, _ := c.Command(context.Background(), sess.ID, "undo", ""); res.Kind != "error" || !strings.Contains(res.Text, "Go engine") {
		t.Fatalf("an unported command should say so: %+v", res)
	}
	list, err := c.Sessions(context.Background(), root)
	if err != nil || len(list) != 1 || list[0].Title != "plan the change" {
		t.Fatalf("sessions = %+v, %v", list, err)
	}

	resumed, err := c.NewSession(context.Background(), root, sess.ID)
	if err != nil || resumed.ID != sess.ID || resumed.Info.Mode != "plan" {
		t.Fatalf("resume = %+v, %v", resumed, err)
	}
	var replay []string
	deadline := time.After(2 * time.Second)
	for len(replay) < 2 {
		select {
		case msg := <-c.Messages():
			switch m := msg.(type) {
			case acp.UserChunk:
				replay = append(replay, "user:"+m.Text)
			case acp.TextChunk:
				replay = append(replay, "agent:"+m.Text)
			}
		case <-deadline:
			t.Fatalf("replay = %v", replay)
		}
	}
	if replay[0] != "user:plan the change" {
		t.Fatalf("replay = %v", replay)
	}
}

func TestContractBackgroundSubAgentReportsAsAThreadEvent(t *testing.T) {
	root := t.TempDir()
	release := make(chan struct{})
	c := engine(t, root, func(call fantasy.Call) (string, [][2]string) {
		system := ""
		if len(call.Prompt) > 0 && call.Prompt[0].Role == fantasy.MessageRoleSystem {
			_, system = lastMessage(fantasy.Call{Prompt: call.Prompt[:1]})
		}
		if strings.Contains(system, "Friday sub-agent") {
			<-release
			return "explored: nothing odd", nil
		}
		role, text := lastMessage(call)
		switch {
		case role == fantasy.MessageRoleUser && text == "explore":
			return "", [][2]string{{"delegate_readonly_task", `{"task":"look","background":true}`}}
		case strings.Contains(text, "in the background"):
			close(release)
			return "", [][2]string{{"wait_agents", `{}`}}
		default:
			return "Summary: " + text, nil
		}
	}, nil)
	sess, _ := c.NewSession(context.Background(), root, "")
	got := turn(t, c, sess.ID, "explore", "allow")
	var statuses []string
	for _, ev := range got.events {
		if ev.Type == "thread" && ev.Thread != nil {
			statuses = append(statuses, ev.Thread.Status)
			if ev.Thread.Agent != "explore" || !ev.Thread.Background || ev.Thread.ParentToolCallID == "" {
				t.Fatalf("thread event = %+v", ev.Thread)
			}
		}
	}
	if strings.Join(statuses, ",") != "running,done" || !strings.Contains(got.text, "explored: nothing odd") {
		t.Fatalf("statuses %v, text %q", statuses, got.text)
	}
}

func TestContractForwardsWhatTheGoEngineDoesNotHave(t *testing.T) {
	var asked []string
	var mu sync.Mutex
	forward := func(_ context.Context, method string, params json.RawMessage) (json.RawMessage, error) {
		mu.Lock()
		asked = append(asked, method)
		mu.Unlock()
		switch method {
		case "_archymedes/settings/list":
			return json.RawMessage(`{"file":"/x/settings.json","rows":[]}`), nil
		case "_archymedes/startup":
			return json.RawMessage(`{"notices":["update available"]}`), nil
		}
		return nil, errors.New("unexpected " + method)
	}
	c := engine(t, t.TempDir(), func(fantasy.Call) (string, [][2]string) { return "x", nil }, forward)
	list, err := c.Settings(context.Background())
	if err != nil || list.File != "/x/settings.json" {
		t.Fatalf("settings = %+v, %v", list, err)
	}
	notices, err := c.Startup(context.Background())
	if err != nil || len(notices) != 1 || notices[0] != "update available" {
		t.Fatalf("startup = %v, %v", notices, err)
	}
	if _, err := c.CallRaw(context.Background(), "_archymedes/nothing", json.RawMessage(`{}`)); err == nil || !strings.Contains(err.Error(), "Method not found") {
		t.Fatalf("unknown method = %v", err)
	}
}

func TestEngineOptionsRefuseWhatTheGoEngineWouldIgnore(t *testing.T) {
	opts, err := engineOptions([]string{"acp", "--auto", "--provider", "groq", "--model=llama"}, "/p")
	if err != nil || opts.Mode != "auto" || opts.Provider != "groq" || opts.Model != "llama" {
		t.Fatalf("opts = %+v, %v", opts, err)
	}
	for _, args := range [][]string{{"--sandbox", "docker"}, {"--budget", "5"}} {
		if _, err := engineOptions(args, "/p"); err == nil {
			t.Fatalf("%v was accepted", args)
		}
	}
	if _, err := engineOptions([]string{"--sandbox", "local", "--free"}, "/p"); err != nil {
		t.Fatal(err)
	}
}

func TestTheGoEngineIsTheDefaultAndTheTypeScriptOneTakesWhatOnlyItCanDo(t *testing.T) {
	none := func(string) bool { return false }
	base := engineFacts{cwd: "/p", env: llm.Env{"GROQ_API_KEY": "k"}, tsAvailable: true, tsSession: none, goSession: none}
	with := func(change func(*engineFacts)) engineFacts {
		f := base
		change(&f)
		return f
	}
	cases := []struct {
		name   string
		facts  engineFacts
		goWant bool
		why    string
	}{
		{"plain friday", base, true, ""},
		{"display flags stay on Go", with(func(f *engineFacts) { f.args = []string{"--language", "fr", "--auto"} }), true, ""},
		{"no provider yet: Go, setup is forwarded", with(func(f *engineFacts) { f.env = llm.Env{} }), true, ""},
		{"explicit ts", with(func(f *engineFacts) { f.explicit = "ts" }), false, ""},
		{"explicit go beats every fallback", with(func(f *engineFacts) { f.explicit = "go"; f.args = []string{"--sandbox", "docker"} }), true, ""},
		{"docker sandbox", with(func(f *engineFacts) { f.args = []string{"--sandbox", "docker"} }), false, "--sandbox docker"},
		{"money budget", with(func(f *engineFacts) { f.args = []string{"--budget", "5"} }), false, "--budget"},
		{"Claude Code remembered stays on Go", with(func(f *engineFacts) { f.env = llm.Env{"ARCHYMEDES_PROVIDER": "claude"} }), true, ""},
		{"Claude Code asked for stays on Go", with(func(f *engineFacts) { f.args = []string{"--provider", "claude"} }), true, ""},
		{"Codex asked for", with(func(f *engineFacts) { f.args = []string{"--provider", "codex"} }), false, "Codex"},
		{"Archymedes Cloud", with(func(f *engineFacts) {
			f.env = llm.Env{"ARCHYMEDES_CLOUD_TOKEN": "t", "ARCHYMEDES_CLOUD_BASE_URL": "u"}
			f.args = []string{"--provider", "archymedes-cloud"}
		}), false, "Archymedes Cloud"},
		{"keyless free gateway", with(func(f *engineFacts) {
			f.env = llm.Env{"ARCHYMEDES_FREE_GATEWAY_URL": "https://g"}
			f.args = []string{"--free"}
		}), false, "free gateway"},
		{"free with a key stays on Go", with(func(f *engineFacts) { f.env = llm.Env{"OPENROUTER_API_KEY": "k"}; f.args = []string{"--free"} }), true, ""},
		{"resuming a TypeScript session", with(func(f *engineFacts) {
			f.resume = "20261001T000000Z-abcdef"
			f.tsSession = func(string) bool { return true }
		}), false, "TypeScript engine"},
		{"resuming a Go session", with(func(f *engineFacts) {
			f.resume = "20261001T000000Z-abcdef"
			f.tsSession = func(string) bool { return true }
			f.goSession = func(string) bool { return true }
		}), true, ""},
		{"no TypeScript agent: always Go", with(func(f *engineFacts) { f.tsAvailable = false; f.args = []string{"--sandbox", "docker"} }), true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := chooseEngine(c.facts)
			if err != nil {
				t.Fatal(err)
			}
			if got.goEngine != c.goWant || !strings.Contains(got.why, c.why) {
				t.Fatalf("choice = %+v", got)
			}
		})
	}
	if _, err := chooseEngine(with(func(f *engineFacts) { f.explicit = "rust" })); err == nil {
		t.Fatal("an unknown engine was accepted")
	}
}

func TestContractToolsCommandListsWhatEachToolMayDo(t *testing.T) {
	root := t.TempDir()
	c := engine(t, root, func(fantasy.Call) (string, [][2]string) { return "x", nil }, nil)
	sess, _ := c.NewSession(context.Background(), root, "")
	res, err := c.Command(context.Background(), sess.ID, "tools", "")
	if err != nil || res.Kind != "text" {
		t.Fatalf("tools = %+v, %v", res, err)
	}
	for _, want := range []string{"Tools in build mode", "read_file", "changes nothing; never asks", "write_file", "asks first", "run_command", "read-only uses run unasked", "git_log (found with tool_search)"} {
		if !strings.Contains(res.Text, want) {
			t.Errorf("tools text lacks %q:\n%s", want, res.Text)
		}
	}
}
