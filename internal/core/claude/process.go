package claude

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// The `claude` program, driven as Anthropic's Agent SDK drives it: `--input-format stream-json
// --output-format stream-json`, one JSON message per line each way. Besides the conversation's
// messages, both sides send control requests and answer them by id:
//
//   - Friday asks: initialize (first, before any message), interrupt, set_permission_mode,
//     set_model, rewind_files;
//   - Claude Code asks: can_use_tool (`--permission-prompt-tool stdio`), which Friday answers with
//     {behavior: allow | deny}; a control_cancel_request withdraws a question still open.
//
// Everything else Claude Code writes is the conversation, passed on in order.

// startOptions are what one Claude Code process starts with.
type startOptions struct {
	executable string
	root       string
	environ    []string
	model      string // "" is Claude Code's own default
	mode       string // a Claude Code permission mode
	resume     string // Claude's session id to continue, or ""
	appendText string // added to Claude Code's own system prompt
	effort     string // --effort, "" for Claude Code's own default
}

// toolRequest is Claude Code asking whether a tool may run.
type toolRequest struct {
	ToolName    string            `json:"tool_name"`
	Input       map[string]any    `json:"input"`
	Suggestions []json.RawMessage `json:"permission_suggestions"`
	ToolUseID   string            `json:"tool_use_id"`
	Title       string            `json:"title"`
}

// process is one running Claude Code.
type process struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser

	writeMu sync.Mutex
	nextID  atomic.Int64

	mu      sync.Mutex
	pending map[string]chan controlReply
	asked   map[string]context.CancelFunc // Claude Code's open questions, by request id
	gone    bool

	// messages are the conversation's lines, in order; closed when Claude Code's output ends.
	messages chan json.RawMessage
	// done is closed once it has exited; err then says why, when it was not asked to.
	done chan struct{}
	err  error

	stderrMu sync.Mutex
	stderr   string

	// canUseTool answers Claude Code's permission questions; ctx ends if it withdraws the question.
	canUseTool func(ctx context.Context, r toolRequest) map[string]any
	// models are what initialize said Claude Code offers.
	models []string
	// effort is the --effort it was started with.
	effort string
	// retired is set when the session replaced it on purpose; its end then ends no turn.
	retired atomic.Bool
}

type controlReply struct {
	Subtype   string          `json:"subtype"`
	RequestID string          `json:"request_id"`
	Response  json.RawMessage `json:"response"`
	Error     string          `json:"error"`
}

// start runs Claude Code and completes its handshake.
func start(ctx context.Context, opts startOptions, canUseTool func(context.Context, toolRequest) map[string]any) (*process, error) {
	args := []string{"--output-format", "stream-json", "--verbose", "--input-format", "stream-json",
		"--permission-prompt-tool", "stdio", "--permission-mode", opts.mode, "--include-partial-messages"}
	if opts.model != "" && opts.model != "default" {
		args = append(args, "--model", opts.model)
	}
	if opts.resume != "" {
		args = append(args, "--resume", opts.resume)
	}
	if opts.effort != "" {
		args = append(args, "--effort", opts.effort)
	}
	// Not CommandContext: the process outlives the request that started it.
	cmd := exec.Command(opts.executable, args...)
	cmd.Dir, cmd.Env = opts.root, opts.environ
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	p := &process{cmd: cmd, stdin: stdin, pending: map[string]chan controlReply{}, asked: map[string]context.CancelFunc{},
		messages: make(chan json.RawMessage, 256), done: make(chan struct{}), canUseTool: canUseTool, effort: opts.effort}
	cmd.Stderr = stderrTail{p}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	go p.read(stdout)
	init := map[string]any{"subtype": "initialize", "hooks": nil}
	if opts.appendText != "" {
		init["appendSystemPrompt"] = opts.appendText
	}
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	raw, err := p.request(ctx, init)
	if err != nil {
		p.close()
		return nil, fmt.Errorf("%w%s", err, p.stderrLast())
	}
	var answer struct {
		Models []struct {
			Value string `json:"value"`
		} `json:"models"`
	}
	if json.Unmarshal(raw, &answer) == nil {
		for _, m := range answer.Models {
			if m.Value != "" {
				p.models = append(p.models, m.Value)
			}
		}
	}
	return p, nil
}

// read is every line Claude Code writes, until it exits.
func (p *process) read(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64<<10), 64<<20)
	for scanner.Scan() {
		line := scanner.Bytes()
		var head struct {
			Type      string          `json:"type"`
			RequestID string          `json:"request_id"`
			Request   json.RawMessage `json:"request"`
			Response  controlReply    `json:"response"`
		}
		if json.Unmarshal(line, &head) != nil {
			continue
		}
		switch head.Type {
		case "control_response":
			p.mu.Lock()
			ch := p.pending[head.Response.RequestID]
			delete(p.pending, head.Response.RequestID)
			p.mu.Unlock()
			if ch != nil {
				ch <- head.Response
			}
		case "control_request":
			go p.answer(head.RequestID, head.Request)
		case "control_cancel_request":
			p.mu.Lock()
			if cancel := p.asked[head.RequestID]; cancel != nil {
				cancel()
			}
			p.mu.Unlock()
		case "keep_alive":
		default:
			p.messages <- append(json.RawMessage(nil), line...)
		}
	}
	err := p.cmd.Wait()
	p.mu.Lock()
	p.gone = true
	for id, ch := range p.pending {
		close(ch)
		delete(p.pending, id)
	}
	for _, cancel := range p.asked {
		cancel()
	}
	p.mu.Unlock()
	if err != nil {
		p.err = fmt.Errorf("%w%s", err, p.stderrLast())
	}
	close(p.messages)
	close(p.done)
}

// answer is Friday's reply to one of Claude Code's control requests.
func (p *process) answer(id string, raw json.RawMessage) {
	var req struct {
		Subtype string `json:"subtype"`
		toolRequest
	}
	_ = json.Unmarshal(raw, &req)
	reply := map[string]any{"subtype": "success", "request_id": id}
	switch req.Subtype {
	case "can_use_tool":
		ctx, cancel := context.WithCancel(context.Background())
		p.mu.Lock()
		p.asked[id] = cancel
		p.mu.Unlock()
		reply["response"] = p.canUseTool(ctx, req.toolRequest)
		p.mu.Lock()
		delete(p.asked, id)
		p.mu.Unlock()
		cancel()
	default:
		reply = map[string]any{"subtype": "error", "request_id": id, "error": "Friday does not handle " + req.Subtype}
	}
	_ = p.write(map[string]any{"type": "control_response", "response": reply})
}

// request sends one control request and waits for its answer.
func (p *process) request(ctx context.Context, request map[string]any) (json.RawMessage, error) {
	id := "friday_" + strconv.FormatInt(p.nextID.Add(1), 10)
	ch := make(chan controlReply, 1)
	p.mu.Lock()
	if p.gone {
		p.mu.Unlock()
		return nil, errors.New("Claude Code has exited")
	}
	p.pending[id] = ch
	p.mu.Unlock()
	if err := p.write(map[string]any{"type": "control_request", "request_id": id, "request": request}); err != nil {
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
		return nil, err
	}
	select {
	case reply, ok := <-ch:
		switch {
		case !ok:
			return nil, errors.New("Claude Code exited before it answered")
		case reply.Subtype == "error":
			return nil, errors.New(firstNonEmpty(reply.Error, "Claude Code refused "+fmt.Sprint(request["subtype"])))
		}
		return reply.Response, nil
	case <-ctx.Done():
		p.mu.Lock()
		delete(p.pending, id)
		p.mu.Unlock()
		return nil, ctx.Err()
	}
}

// send is one user message: a prompt, or steering for the running turn.
func (p *process) send(text, uuid string) error {
	return p.write(map[string]any{"type": "user", "message": map[string]any{"role": "user", "content": text}, "parent_tool_use_id": nil, "session_id": "", "uuid": uuid})
}

func (p *process) write(message any) error {
	line, err := json.Marshal(message)
	if err != nil {
		return err
	}
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	_, err = p.stdin.Write(append(line, '\n'))
	return err
}

// close ends Claude Code: its input first, so it can finish writing its session, then the process.
func (p *process) close() {
	_ = p.stdin.Close()
	select {
	case <-p.done:
	case <-time.After(3 * time.Second):
		_ = p.cmd.Process.Kill()
		<-p.done
	}
}

// stderrTail keeps the end of what Claude Code says on stderr, for explaining a failure.
type stderrTail struct{ p *process }

func (w stderrTail) Write(b []byte) (int, error) {
	w.p.stderrMu.Lock()
	defer w.p.stderrMu.Unlock()
	w.p.stderr += string(b)
	if len(w.p.stderr) > 4000 {
		w.p.stderr = w.p.stderr[len(w.p.stderr)-4000:]
	}
	return len(b), nil
}

// stderrLast is the last line Claude Code wrote to stderr, as " (…)", or "".
func (p *process) stderrLast() string {
	p.stderrMu.Lock()
	defer p.stderrMu.Unlock()
	lines := strings.Split(strings.TrimSpace(p.stderr), "\n")
	last := strings.TrimSpace(lines[len(lines)-1])
	if last == "" {
		return ""
	}
	if r := []rune(last); len(r) > 300 {
		last = string(r[:300])
	}
	return " (" + last + ")"
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return strings.TrimSpace(v)
		}
	}
	return ""
}
