// Package server is the Go engine's side of the Agent Client Protocol: JSON-RPC 2.0, one message
// per line, over any reader and writer. It is Friday's default engine: the Go interface talks to it
// through an in-process pipe, and `friday acp` serves it on stdio for any ACP client (Zed, JetBrains).
//
// It speaks ACP v1 and the `_archymedes/*` extension exactly as the TypeScript agent does
// (packages/core/src/cli/acp.ts), so the interface cannot tell the engines apart. Methods it does
// not implement yet are forwarded to the TypeScript agent when one is available: the switch to Go
// happens a method at a time, and nothing the person uses goes missing meanwhile.
//
// Inside, a turn already has ACP v2's shape (accepted, then updates, then idle): Accept is taken
// when the request arrives, Prompt waits its turn, and the reply only reports how it ended.
package server

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
)

// ProtocolVersion is the ACP major version spoken.
const ProtocolVersion = 1

// Forwarder sends a method this engine does not implement to another agent (the TypeScript one).
type Forwarder func(ctx context.Context, method string, params json.RawMessage) (json.RawMessage, error)

// Options configure a server.
type Options struct {
	// Cwd is the project when session/new names none.
	Cwd       string
	ConfigDir string
	// Environ is the process environment ("KEY=value"), laid over settings.json.
	Environ []string
	// Mode, Provider and Model are the command line's choices for new sessions.
	Mode     policy.Mode
	Provider string
	Model    string
	// Forward, when set, answers the methods this engine does not implement.
	Forward Forwarder
	// Open opens models; nil opens real providers. Tests pass a scripted model.
	Open llm.Opener
	// Version is shown in the startup notice.
	Version string
}

// frame is one line on the wire.
type frame struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return e.Message }

const (
	codeInvalidRequest = -32600
	codeMethodNotFound = -32601
	codeInvalidParams  = -32602
	codeInternal       = -32603
)

func errorf(code int, format string, args ...any) *rpcError {
	return &rpcError{Code: code, Message: fmt.Sprintf(format, args...)}
}

// Server is one connection.
type Server struct {
	opts Options
	out  io.Writer

	writeMu sync.Mutex
	nextID  atomic.Int64
	pendMu  sync.Mutex
	pending map[string]chan frame

	initialized atomic.Bool
	events      atomic.Bool
	questions   atomic.Bool

	sessMu   sync.Mutex
	sessions map[string]*session
	closing  bool // set by closeAll: no session may be registered after it
	wg       sync.WaitGroup
}

// New is a server writing to out.
func New(out io.Writer, opts Options) *Server {
	return &Server{opts: opts, out: out, pending: map[string]chan frame{}, sessions: map[string]*session{}}
}

// Serve reads requests from in until it ends or ctx is done, then closes every session.
func (s *Server) Serve(ctx context.Context, in io.Reader) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	lines := make(chan []byte)
	readErr := make(chan error, 1)
	go func() {
		scanner := bufio.NewScanner(in)
		scanner.Buffer(make([]byte, 64<<10), 64<<20)
		for scanner.Scan() {
			line := append([]byte(nil), scanner.Bytes()...)
			select {
			case lines <- line:
			case <-ctx.Done():
				return
			}
		}
		readErr <- scanner.Err()
	}()
	var err error
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case err = <-readErr:
			break loop
		case line := <-lines:
			s.handle(ctx, line)
		}
	}
	cancel()
	s.closeAll()
	s.wg.Wait()
	s.failPending()
	return err
}

func (s *Server) handle(ctx context.Context, line []byte) {
	if len(strings.TrimSpace(string(line))) == 0 {
		return
	}
	var f frame
	if json.Unmarshal(line, &f) != nil {
		return
	}
	switch {
	case f.Method == "" && len(f.ID) > 0: // a reply to one of our requests
		s.pendMu.Lock()
		ch, ok := s.pending[idKey(f.ID)]
		delete(s.pending, idKey(f.ID))
		s.pendMu.Unlock()
		if ok {
			ch <- f
		}
	case len(f.ID) == 0: // a notification
		s.notification(f)
	default:
		// A prompt takes its place in line here, on the reading goroutine (see acceptPrompt).
		var accepted acceptedPrompt
		var acceptErr error
		if f.Method == "session/prompt" {
			if !s.initialized.Load() {
				acceptErr = errorf(codeInvalidRequest, "initialize must come first")
			} else {
				accepted, acceptErr = s.acceptPrompt(f.Params)
			}
		}
		// Requests run concurrently: a prompt holds its reply for the whole turn, and the steering,
		// cancel and model calls for that session must still be answered meanwhile.
		s.wg.Add(1)
		go func() {
			defer s.wg.Done()
			var result any
			var err error
			switch {
			case acceptErr != nil:
				err = acceptErr
			case f.Method == "session/prompt":
				result, err = s.prompt(ctx, accepted)
			default:
				result, err = s.dispatch(ctx, f.Method, f.Params)
			}
			reply := frame{JSONRPC: "2.0", ID: f.ID}
			if err != nil {
				var re *rpcError
				if !errors.As(err, &re) {
					re = &rpcError{Code: codeInternal, Message: err.Error()}
				}
				reply.Error = re
			} else {
				reply.Result = mustJSON(result)
			}
			s.write(reply)
		}()
	}
}

func (s *Server) notification(f frame) {
	switch f.Method {
	case "session/cancel":
		var p struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(f.Params, &p)
		if sess := s.session(p.SessionID); sess != nil {
			sess.core.Cancel()
		}
	}
}

// request asks the client something and waits for the answer.
func (s *Server) request(ctx context.Context, method string, params any) (json.RawMessage, error) {
	id := strconv.FormatInt(s.nextID.Add(1), 10)
	ch := make(chan frame, 1)
	s.pendMu.Lock()
	s.pending[id] = ch
	s.pendMu.Unlock()
	s.write(frame{JSONRPC: "2.0", ID: json.RawMessage(strconv.Quote("friday-" + id)), Method: method, Params: mustJSON(params)})
	select {
	case f, ok := <-ch:
		if !ok {
			return nil, errors.New("the client went away")
		}
		if f.Error != nil {
			return nil, f.Error
		}
		return f.Result, nil
	case <-ctx.Done():
		s.pendMu.Lock()
		delete(s.pending, id)
		s.pendMu.Unlock()
		return nil, ctx.Err()
	}
}

func (s *Server) failPending() {
	s.pendMu.Lock()
	defer s.pendMu.Unlock()
	for id, ch := range s.pending {
		close(ch)
		delete(s.pending, id)
	}
}

// idKey makes `"friday-7"`, `"7"` and `7` the same key: we send "friday-<n>", a client may echo
// it back as given or (wrongly) as a number.
func idKey(raw json.RawMessage) string {
	return strings.TrimPrefix(strings.Trim(string(raw), `"`), "friday-")
}

func (s *Server) notify(method string, params any) {
	s.write(frame{JSONRPC: "2.0", Method: method, Params: mustJSON(params)})
}

func (s *Server) write(f frame) {
	f.JSONRPC = "2.0"
	line, err := json.Marshal(f)
	if err != nil {
		return
	}
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	_, _ = s.out.Write(append(line, '\n'))
}

func mustJSON(value any) json.RawMessage {
	if raw, ok := value.(json.RawMessage); ok {
		return raw
	}
	data, err := json.Marshal(value)
	if err != nil {
		return json.RawMessage(`null`)
	}
	return data
}
