// Package thread keeps a Go-engine session on disk as a tree of threads: the root conversation and
// every sub-agent it started, each with its own messages.
//
// A session is a directory under <project>/.archymedes/go-sessions/<id>/:
//
//	session.json        what the session is (title, provider, model, mode, standing approvals)
//	threads.jsonl       append-only: each thread's spawn, then each status it reached
//	<thread>.json       the thread's conversation as of its last completed step
//
// The log is what makes spawns restart-safe, as OpenCode's spawns-as-transcript are: a spawn is
// written before the child starts and the child's conversation after every step, so a session
// loaded after a crash finds each child that never reached an end, and can resume it from where it
// was. Message files are replaced whole (write and rename), never appended, so a crash mid-write
// leaves the previous step, never half of one.
package thread

import (
	"bufio"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"charm.land/fantasy"
)

// Root is the id of a session's own conversation.
const Root = "root"

// Statuses a thread passes through.
const (
	Running   = "running"
	Idle      = "idle" // a finished turn; the thread can be spoken to again
	Done      = "done"
	Failed    = "failed"
	Cancelled = "cancelled"
	// Interrupted: running when the process ended. Set on load, cleared when it is resumed.
	Interrupted = "interrupted"
	// Paused: a background child stopped because its session closed (the person quit), not
	// because anyone stopped it. It resumes when the session is loaded again.
	Paused = "paused"
)

// Terminal reports whether a status is an end (a finished thread may still be re-opened).
func Terminal(status string) bool {
	return status == Done || status == Failed || status == Cancelled
}

// Thread is one conversation in the tree.
type Thread struct {
	ID     string `json:"id"`
	Parent string `json:"parent,omitempty"`
	// CallID is the parent's tool call that started it; the interface hangs its card there.
	CallID     string `json:"callId,omitempty"`
	Role       string `json:"role,omitempty"`
	Brief      string `json:"brief,omitempty"`
	Fork       string `json:"fork,omitempty"`
	Background bool   `json:"background,omitempty"`
	Model      string `json:"model,omitempty"`
	// Worktree and Branch are set for a writable background child that works on its own checkout.
	Worktree  string    `json:"worktree,omitempty"`
	Branch    string    `json:"branch,omitempty"`
	Status    string    `json:"status"`
	Report    string    `json:"report,omitempty"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
	// Usage is every token the thread's model calls have used, across restarts.
	Usage *Usage `json:"usage,omitempty"`
}

// Usage is a thread's tokens, in the names the interface reads (loop.Usage, acp.Usage).
type Usage struct {
	InputTokens       int `json:"inputTokens"`
	OutputTokens      int `json:"outputTokens"`
	CachedInputTokens int `json:"cachedInputTokens"`
	ReasoningTokens   int `json:"reasoningTokens"`
}

// Meta is what a session is.
type Meta struct {
	ID        string            `json:"id"`
	Title     string            `json:"title,omitempty"`
	Cwd       string            `json:"cwd"`
	Provider  string            `json:"provider,omitempty"`
	Model     string            `json:"model,omitempty"`
	Mode      string            `json:"mode,omitempty"`
	Approvals map[string]string `json:"approvals,omitempty"`
	// ClaudeSession is Claude Code's own id for this conversation, which resuming continues.
	ClaudeSession string `json:"claudeSession,omitempty"`
	// EngineSeen is, per outside engine, how many root messages it has seen: what it is told on
	// coming back is only what came after (the TypeScript record's engineSeen).
	EngineSeen map[string]int `json:"engineSeen,omitempty"`
	// Usage and ModelCalls are what the main conversation's model calls have used (sub-agents keep
	// their own, on their threads).
	Usage      *Usage    `json:"usage,omitempty"`
	ModelCalls int       `json:"modelCalls,omitempty"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

// Store is one session's directory.
type Store struct {
	dir string
	mu  sync.Mutex
}

// Directory is where a project's Go-engine sessions live.
func Directory(root string) string {
	return filepath.Join(root, ".archymedes", "go-sessions")
}

var idPattern = regexp.MustCompile(`^\d{8}T\d{6}Z-[a-z0-9]{6}$`)

// NewID is a session id in the TypeScript agent's format (`friday --resume <id>` accepts both).
func NewID(now time.Time) string {
	return now.UTC().Format("20060102T150405Z") + "-" + randomSuffix(6)
}

// NewThreadID is a short id unique within a session.
func NewThreadID() string { return "t-" + randomSuffix(6) }

func randomSuffix(n int) string {
	const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789"
	buf := make([]byte, n)
	_, _ = rand.Read(buf)
	for i := range buf {
		buf[i] = alphabet[int(buf[i])%len(alphabet)]
	}
	return string(buf)
}

// Create makes a new session's directory.
func Create(root string, meta Meta) (*Store, error) {
	if !idPattern.MatchString(meta.ID) {
		return nil, fmt.Errorf("bad session id %q", meta.ID)
	}
	s := &Store{dir: filepath.Join(Directory(root), meta.ID)}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		return nil, err
	}
	if meta.CreatedAt.IsZero() {
		meta.CreatedAt = time.Now()
	}
	return s, s.SaveMeta(meta)
}

// Open opens an existing session; "latest" is the newest.
func Open(root, id string) (*Store, error) {
	if id == "latest" {
		list := List(root, 1)
		if len(list) == 0 {
			return nil, errors.New("no Go-engine session to resume in this project")
		}
		id = list[0].ID
	}
	if !idPattern.MatchString(id) {
		return nil, fmt.Errorf("bad session id %q", id)
	}
	s := &Store{dir: filepath.Join(Directory(root), id)}
	if _, err := os.Stat(filepath.Join(s.dir, "session.json")); err != nil {
		return nil, fmt.Errorf("no Go-engine session %s in this project", id)
	}
	return s, nil
}

// Dir is the session's directory.
func (s *Store) Dir() string { return s.dir }

// SaveMeta replaces session.json, stamping UpdatedAt.
func (s *Store) SaveMeta(meta Meta) error {
	meta.UpdatedAt = time.Now()
	return s.writeJSON("session.json", meta)
}

// Meta reads session.json.
func (s *Store) Meta() (Meta, error) {
	var meta Meta
	err := s.readJSON("session.json", &meta)
	return meta, err
}

// Spawn records a thread before it starts.
func (s *Store) Spawn(t Thread) error {
	now := time.Now()
	if t.CreatedAt.IsZero() {
		t.CreatedAt = now
	}
	t.UpdatedAt = now
	if t.Status == "" {
		t.Status = Running
	}
	return s.appendRecord(record{Kind: "spawn", Thread: &t})
}

// SetStatus records a thread reaching a status; report is its final words when it has them.
func (s *Store) SetStatus(id, status, report string) error {
	return s.appendRecord(record{Kind: "status", ID: id, Status: status, Report: report, At: time.Now()})
}

// SetUsage records a thread's tokens so far: the whole total, which replaces the last one.
func (s *Store) SetUsage(id string, u Usage) error {
	return s.appendRecord(record{Kind: "usage", ID: id, Usage: &u, At: time.Now()})
}

// SaveMessages replaces a thread's conversation.
func (s *Store) SaveMessages(id string, messages []fantasy.Message) error {
	return s.writeJSON(id+".json", messages)
}

// Messages reads a thread's conversation; none yet is an empty conversation.
func (s *Store) Messages(id string) ([]fantasy.Message, error) {
	var messages []fantasy.Message
	err := s.readJSON(id+".json", &messages)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return messages, err
}

// Threads replays the log: every thread with its latest status, oldest first. A line that does
// not parse (the tail of a write cut short) is skipped, not fatal.
func (s *Store) Threads() ([]Thread, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := os.Open(filepath.Join(s.dir, "threads.jsonl"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer file.Close()
	byID := map[string]*Thread{}
	var order []string
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64<<10), 16<<20)
	for scanner.Scan() {
		var rec record
		if json.Unmarshal(scanner.Bytes(), &rec) != nil {
			continue
		}
		switch rec.Kind {
		case "spawn":
			if rec.Thread == nil {
				continue
			}
			t := *rec.Thread
			if _, seen := byID[t.ID]; !seen {
				order = append(order, t.ID)
			}
			byID[t.ID] = &t
		case "status":
			if t := byID[rec.ID]; t != nil {
				t.Status = rec.Status
				t.UpdatedAt = rec.At
				if rec.Report != "" {
					t.Report = rec.Report
				}
			}
		case "usage":
			if t := byID[rec.ID]; t != nil && rec.Usage != nil {
				u := *rec.Usage
				t.Usage = &u
			}
		}
	}
	out := make([]Thread, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, scanner.Err()
}

// Thread finds one thread by id.
func (s *Store) Thread(id string) (Thread, bool) {
	threads, _ := s.Threads()
	for _, t := range threads {
		if t.ID == id {
			return t, true
		}
	}
	return Thread{}, false
}

// Interrupted lists the child threads to resume: those running when the process ended (a crash)
// and those paused when the session closed (a quit). It marks them interrupted, so the caller can
// resume them and a second load does not see them twice.
func (s *Store) Interrupted() ([]Thread, error) {
	threads, err := s.Threads()
	if err != nil {
		return nil, err
	}
	var out []Thread
	for _, t := range threads {
		if t.ID != Root && (t.Status == Running || t.Status == Paused) {
			if err := s.SetStatus(t.ID, Interrupted, ""); err != nil {
				return nil, err
			}
			t.Status = Interrupted
			out = append(out, t)
		}
	}
	return out, nil
}

type record struct {
	Kind   string    `json:"t"`
	Thread *Thread   `json:"thread,omitempty"`
	ID     string    `json:"id,omitempty"`
	Status string    `json:"status,omitempty"`
	Report string    `json:"report,omitempty"`
	Usage  *Usage    `json:"usage,omitempty"`
	At     time.Time `json:"at,omitzero"`
}

func (s *Store) appendRecord(rec record) error {
	line, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	file, err := os.OpenFile(filepath.Join(s.dir, "threads.jsonl"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return err
	}
	_, err = file.Write(append(line, '\n'))
	if serr := file.Sync(); err == nil {
		err = serr
	}
	if cerr := file.Close(); err == nil {
		err = cerr
	}
	return err
}

func (s *Store) writeJSON(name string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tmp, err := os.CreateTemp(s.dir, "."+name+".*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return os.Rename(tmp.Name(), filepath.Join(s.dir, name))
}

func (s *Store) readJSON(name string, out any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	data, err := os.ReadFile(filepath.Join(s.dir, name))
	if err != nil {
		return err
	}
	return json.Unmarshal(data, out)
}

// Summary is one session for a resume picker.
type Summary struct {
	ID        string
	Title     string
	UpdatedAt time.Time
}

// List is a project's sessions, newest first, at most limit (0 for all).
func List(root string, limit int) []Summary {
	entries, _ := os.ReadDir(Directory(root))
	var out []Summary
	for _, e := range entries {
		if !e.IsDir() || !idPattern.MatchString(e.Name()) {
			continue
		}
		s := &Store{dir: filepath.Join(Directory(root), e.Name())}
		meta, err := s.Meta()
		if err != nil {
			continue
		}
		out = append(out, Summary{ID: meta.ID, Title: meta.Title, UpdatedAt: meta.UpdatedAt})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].UpdatedAt.After(out[j].UpdatedAt) })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

// Title is a session's title from its first request: the first line, shortened.
func Title(prompt string) string {
	line := strings.TrimSpace(strings.SplitN(strings.TrimSpace(prompt), "\n", 2)[0])
	if runes := []rune(line); len(runes) > 60 {
		line = strings.TrimSpace(string(runes[:59])) + "…"
	}
	return line
}
