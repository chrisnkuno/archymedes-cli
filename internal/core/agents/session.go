// Package agents is the Go engine's coordinator: one Session per conversation, which runs its root
// thread's turns one at a time, and the sub-agents those turns start, in the foreground or the
// background, as child threads of the same tree.
//
// The turn contract is Crush's (internal/agent/coordinator.go): a prompt is accepted before it
// runs, a prompt that arrives while a turn is running waits its turn, and a cancel stops the
// running turn and every prompt accepted before the cancel, but none accepted after it. That last
// part is what makes "stop" safe to press while a queued message is being handed over.
package agents

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/advise"
	"github.com/chrisnkuno/friday-cli/internal/core/gate"
	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/loop"
	"github.com/chrisnkuno/friday-cli/internal/core/mcp"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/roles"
	"github.com/chrisnkuno/friday-cli/internal/core/skills"
	"github.com/chrisnkuno/friday-cli/internal/core/thread"
	"github.com/chrisnkuno/friday-cli/internal/core/tool"
	"github.com/chrisnkuno/friday-cli/internal/core/tools"
)

// Notice is something a session tells its client. Kind is the `_archymedes/event` type it becomes.
type Notice struct {
	Kind string // runtime | subagent | thread | compaction | steering_unread | rules_problems | suggestions | edit_notes
	// Event is the runtime event, for runtime, subagent and compaction.
	Event *loop.Event
	// ParentToolCallID and Agent place a sub-agent's event under the call that started it.
	ParentToolCallID string
	Agent            string
	Thread           *ThreadInfo
	Messages         []string
	Problems         []string
	// Steps are a finished turn's suggested next steps (suggestions).
	Steps []advise.Step
	// ToolCallID, Path and Notes are what is worth knowing about one edit (edit_notes).
	ToolCallID string
	Path       string
	Notes      []advise.Note
}

// ThreadInfo is a child thread as the interface sees it.
type ThreadInfo struct {
	ID               string `json:"id"`
	ParentToolCallID string `json:"parentToolCallId,omitempty"`
	Agent            string `json:"agent"`
	Status           string `json:"status"`
	Background       bool   `json:"background"`
	Brief            string `json:"brief,omitempty"`
	Report           string `json:"report,omitempty"`
	Branch           string `json:"branch,omitempty"`
	// Model is the model it runs on; Usage is every token it has used so far.
	Model string      `json:"model,omitempty"`
	Usage *loop.Usage `json:"usage,omitempty"`
}

// Asker puts a question to the person; "" with no error is a dismissal.
type Asker func(ctx context.Context, question string, options []string, multiSelect bool) (string, error)

// Config is what a session is opened with.
// DefaultMaxChildren is how many sub-agents run at once when the configuration does not say.
const DefaultMaxChildren = 4

type Config struct {
	Root      string
	ConfigDir string
	Env       llm.Env
	Models    *llm.Models
	Mode      policy.Mode
	// Prompt asks the person to approve a call; Ask asks them a question. Either may be nil.
	Prompt policy.Prompt
	Ask    Asker
	// Notify receives every notice, in order per thread; it must not block for long.
	Notify    func(Notice)
	TestFirst bool
	Budgets   loop.Budgets
	// MaxChildren is how many sub-agents run at once (DefaultMaxChildren unless set).
	MaxChildren int
}

// Session is one conversation and its sub-agents.
type Session struct {
	cfg      Config
	store    *thread.Store
	ws       *tools.Workspace
	profiles []roles.Profile
	inbox    *loop.Inbox
	slots    chan struct{}
	jev      *advise.Jev // nil without a TypeSafe key
	mcp      *mcp.Manager

	mu       sync.Mutex
	models   *llm.Models
	ledger   *policy.Ledger
	messages []fantasy.Message
	meta     thread.Meta

	// turn handover: seq numbers accepted prompts; a cancel marks everything up to now cancelled.
	turnMu     sync.Mutex
	turnCond   *sync.Cond
	busy       bool
	acceptSeq  uint64
	cancelMark uint64
	nextTurn   uint64 // the accepted slot that runs next
	cancelRun  context.CancelFunc

	childMu  sync.Mutex
	children map[string]*child
	closed   bool

	// life ends with the session: background sub-agents run under it, not under the turn that
	// started them, so they keep working after that turn ends.
	life    context.Context
	endLife context.CancelFunc
}

// ErrBusyClosed is returned by a turn asked of a closed session.
var ErrBusyClosed = errors.New("session is closed")

// Create opens a new session.
func Create(ctx context.Context, cfg Config, prompt string) (*Session, error) {
	sel := cfg.Models.Selection()
	meta := thread.Meta{ID: thread.NewID(time.Now()), Cwd: cfg.Root, Provider: sel.Provider.ID, Model: sel.Model, Mode: string(cfg.Mode), Title: thread.Title(prompt)}
	store, err := thread.Create(cfg.Root, meta)
	if err != nil {
		return nil, err
	}
	if err := store.Spawn(thread.Thread{ID: thread.Root, Status: thread.Idle}); err != nil {
		return nil, err
	}
	return newSession(cfg, store, meta, nil), nil
}

// Load reopens a stored session ("latest" for the newest), resuming every sub-agent that was
// running when it was last open: its report reaches the conversation as a notice.
func Load(ctx context.Context, cfg Config, id string) (*Session, error) {
	store, err := thread.Open(cfg.Root, id)
	if err != nil {
		return nil, err
	}
	meta, err := store.Meta()
	if err != nil {
		return nil, err
	}
	messages, err := store.Messages(thread.Root)
	if err != nil {
		return nil, err
	}
	if cfg.Mode == "" {
		if mode, ok := policy.ParseMode(meta.Mode); ok {
			cfg.Mode = mode
		}
	}
	s := newSession(cfg, store, meta, thread.Complete(messages))
	if len(meta.Approvals) > 0 {
		s.ledger.Restore(meta.Approvals)
	}
	interrupted, err := store.Interrupted()
	if err != nil {
		return nil, err
	}
	for _, t := range interrupted {
		s.resumeInterrupted(t)
	}
	return s, nil
}

func newSession(cfg Config, store *thread.Store, meta thread.Meta, messages []fantasy.Message) *Session {
	if cfg.Mode == "" {
		cfg.Mode = policy.Build
	}
	if cfg.MaxChildren <= 0 {
		cfg.MaxChildren = DefaultMaxChildren
	}
	if cfg.Notify == nil {
		cfg.Notify = func(Notice) {}
	}
	ws := tools.NewWorkspace(cfg.Root)
	rules := policy.LoadCommandRules(cfg.Root, cfg.ConfigDir)
	ws.Rules = rules.Rules
	profiles, problems := roles.Load(cfg.Root, cfg.ConfigDir)
	s := &Session{
		cfg: cfg, store: store, ws: ws, profiles: profiles, inbox: loop.NewInbox(),
		slots: make(chan struct{}, cfg.MaxChildren), messages: messages, meta: meta, models: cfg.Models,
		children: map[string]*child{},
	}
	if s.suggesting() {
		s.jev = advise.NewJev(cfg.Env.Get)
	}
	cacheDir := ""
	if cfg.ConfigDir != "" {
		cacheDir = filepath.Join(cfg.ConfigDir, "mcp-cache")
	}
	s.mcp = mcp.NewManager(mcp.Files(cfg.Root, cfg.ConfigDir), cfg.Env.Get, os.Environ(), cacheDir)
	s.mcp.Tools() // a server never listed is listed now, in the background, ready by the first turn
	s.turnCond = sync.NewCond(&s.turnMu)
	s.nextTurn = 1
	s.life, s.endLife = context.WithCancel(context.Background())
	s.ledger = policy.NewLedger(cfg.Mode, s.askApproval)
	s.ledger.SetCommandRules(rules.Rules)
	if all := append(rules.Problems, problems...); len(all) > 0 {
		cfg.Notify(Notice{Kind: "rules_problems", Problems: all})
	}
	return s
}

// ID is the session id.
func (s *Session) ID() string { return s.meta.ID }

// Meta is what the session is now.
func (s *Session) Meta() thread.Meta {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.meta
}

// Mode is the session's mode.
func (s *Session) Mode() policy.Mode {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.ledger.Mode()
}

// Messages is the root conversation.
func (s *Session) Messages() []fantasy.Message {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]fantasy.Message(nil), s.messages...)
}

// Todos is the session's checklist.
func (s *Session) Todos() []tools.TodoItem { return s.ws.Todos.Items() }

func (s *Session) askApproval(ctx context.Context, r policy.Request) (policy.Decision, error) {
	if s.cfg.Prompt == nil {
		return policy.Deny, nil
	}
	return s.cfg.Prompt(ctx, r)
}

// Accepted is a prompt's place in line, taken when the client's request arrives.
type Accepted struct{ seq uint64 }

// Accept reserves a place for a prompt. A cancel from now on covers it until it starts.
func (s *Session) Accept() Accepted {
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	s.acceptSeq++
	return Accepted{seq: s.acceptSeq}
}

// Prompt runs one turn of the root thread for an accepted prompt, after every prompt accepted
// before it. It returns how the turn ended; a prompt cancelled before it started ends Cancelled unrun.
func (s *Session) Prompt(ctx context.Context, accepted Accepted, text string) loop.Result {
	return s.inTurn(ctx, accepted, func(ctx context.Context) loop.Result { return s.runRoot(ctx, text) })
}

// inTurn runs work in an accepted slot. Slots run strictly in the order they were accepted (a
// sync.Cond wakes waiters in no particular order, so each waits for its own number to come up),
// one at a time, and a slot at or below the cancel mark ends without running. Every accepted slot
// must come through here exactly once, or the ones after it wait forever.
func (s *Session) inTurn(ctx context.Context, accepted Accepted, work func(context.Context) loop.Result) loop.Result {
	s.turnMu.Lock()
	for !s.closed && accepted.seq > s.cancelMark && (s.busy || accepted.seq != s.nextTurn) {
		s.turnCond.Wait()
	}
	if s.closed {
		s.advancePast(accepted.seq)
		s.turnMu.Unlock()
		return loop.Result{Status: loop.Cancelled, Err: ErrBusyClosed}
	}
	if accepted.seq <= s.cancelMark {
		s.advancePast(accepted.seq)
		s.turnMu.Unlock()
		return loop.Result{Status: loop.Cancelled}
	}
	s.busy = true
	runCtx, cancel := context.WithCancel(ctx)
	s.cancelRun = cancel
	s.turnMu.Unlock()

	defer func() {
		cancel()
		s.turnMu.Lock()
		s.busy = false
		s.cancelRun = nil
		s.advancePast(accepted.seq)
		s.turnMu.Unlock()
	}()
	return work(runCtx)
}

// advancePast moves the next slot past seq and past everything a cancel covered, and wakes the
// waiters so the one whose number came up can start. Called with turnMu held.
func (s *Session) advancePast(seq uint64) {
	if seq >= s.nextTurn {
		s.nextTurn = seq + 1
	}
	if s.nextTurn <= s.cancelMark {
		s.nextTurn = s.cancelMark + 1
	}
	s.turnCond.Broadcast()
}

// Cancel stops the running turn and every prompt accepted so far that has not started.
func (s *Session) Cancel() {
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	s.cancelMark = s.acceptSeq
	if s.cancelRun != nil {
		s.cancelRun()
	}
	if !s.busy {
		s.advancePast(s.cancelMark)
	}
	s.turnCond.Broadcast()
}

// Busy reports whether a turn is running.
func (s *Session) Busy() bool {
	s.turnMu.Lock()
	defer s.turnMu.Unlock()
	return s.busy
}

// Steer hands text to the running turn; false when none runs (send it as a turn instead).
func (s *Session) Steer(text string) bool { return s.inbox.Steer(text) }

// SetMode changes what the session may do, keeping standing approvals.
func (s *Session) SetMode(mode policy.Mode) {
	s.mu.Lock()
	defer s.mu.Unlock()
	standing := s.ledger.Snapshot()
	patterns := s.ledger.Patterns()
	s.ledger = policy.NewLedger(mode, s.askApproval)
	s.ledger.Restore(standing)
	for _, p := range patterns {
		_ = s.ledger.AllowPattern(p)
	}
	s.ledger.SetCommandRules(s.ws.Rules)
	s.meta.Mode = string(mode)
	_ = s.store.SaveMeta(s.meta)
}

// SetModel switches the session's model on the same provider, keeping the conversation.
func (s *Session) SetModel(ctx context.Context, model string) error {
	if err := s.Models().Switch(ctx, model); err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta.Model = model
	return s.store.SaveMeta(s.meta)
}

// UseModels moves the session to another provider's models, keeping the conversation. The next
// step of a running turn still finishes on the old ones.
func (s *Session) UseModels(models *llm.Models) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.models = models
	sel := models.Selection()
	s.meta.Provider, s.meta.Model = sel.Provider.ID, sel.Model
	return s.store.SaveMeta(s.meta)
}

// Models is the session's models now.
func (s *Session) Models() *llm.Models {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.models
}

// Close stops the running turn and every sub-agent, and waits for them.
func (s *Session) Close() {
	s.turnMu.Lock()
	s.closed = true
	if s.cancelRun != nil {
		s.cancelRun()
	}
	s.turnCond.Broadcast()
	s.turnMu.Unlock()
	s.childMu.Lock()
	running := make([]*child, 0, len(s.children))
	for _, c := range s.children {
		running = append(running, c)
	}
	s.childMu.Unlock()
	s.endLife()
	for _, c := range running {
		c.stop()
		<-c.done
	}
	s.mcp.Close()
}

// MCP is the session's MCP servers.
func (s *Session) MCP() *mcp.Manager { return s.mcp }

// runRoot is one turn of the root thread.
func (s *Session) runRoot(ctx context.Context, text string) loop.Result {
	s.mu.Lock()
	ledger := s.ledger
	history := append([]fantasy.Message(nil), s.messages...)
	first := len(history) == 0
	if s.meta.Title == "" {
		s.meta.Title = thread.Title(text)
	}
	s.mu.Unlock()
	if first && s.cfg.Env.Get("ARCHYMEDES_TITLES") != "off" {
		s.nameSession(text)
	}
	_ = s.store.SetStatus(thread.Root, thread.Running, "")

	model, _, err := s.Models().For(ctx, "main")
	if err != nil {
		return loop.Result{Status: loop.Failed, Err: err}
	}
	// A server still being listed (just added, never cached) gets a moment, so this turn has its tools.
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	s.mcp.WaitListed(wait)
	cancel()
	catalog := s.rootTools(ledger.Mode())
	var verify *gate.Gate
	if ledger.Mode() != policy.Plan {
		verify = gate.New(s.cfg.TestFirst)
	}
	rec := newTurnRecord(text)
	emit := func(ev loop.Event) { s.emitRoot(ev) }
	if s.suggesting() {
		emit = func(ev loop.Event) { s.emitRoot(ev); s.observe(rec, ev) }
	}
	result := loop.Run(ctx, loop.Request{
		ThreadID: thread.Root, Root: s.cfg.Root, Model: model,
		System:  s.rootSystemPrompt(ledger.Mode(), catalog),
		History: history, Prompt: text, Tools: catalog,
		Approve: ledger.Decide, Gate: verify, Inbox: s.inbox, Budgets: s.cfg.Budgets,
		Emit:       emit,
		Checkpoint: func(m []fantasy.Message) { s.saveRoot(m) },
		Compact:    s.compactor(),
	})
	s.saveRoot(result.Messages)
	status := thread.Idle
	if result.Status == loop.Failed {
		status = thread.Failed
	}
	_ = s.store.SetStatus(thread.Root, status, "")
	if len(result.Unread) > 0 {
		s.cfg.Notify(Notice{Kind: "steering_unread", Messages: result.Unread})
	}
	s.mu.Lock()
	s.meta.Approvals = ledger.Snapshot()
	_ = s.store.SaveMeta(s.meta)
	s.mu.Unlock()
	if s.suggesting() {
		s.suggestAfter(rec, result)
	}
	return result
}

func (s *Session) saveRoot(messages []fantasy.Message) {
	s.mu.Lock()
	s.messages = messages
	s.mu.Unlock()
	if err := s.store.SaveMessages(thread.Root, messages); err != nil {
		fmt.Fprintln(os.Stderr, "friday: saving the session:", err)
	}
}

func (s *Session) emitRoot(ev loop.Event) {
	if ev.Type == loop.EventModelTurn && ev.Usage != nil {
		s.countRoot(*ev.Usage)
	}
	if ev.Type == loop.EventCompaction {
		s.cfg.Notify(Notice{Kind: "compaction", Event: &ev})
		return
	}
	s.cfg.Notify(Notice{Kind: "runtime", Event: &ev})
}

// countRoot adds one main-conversation model call to the session's totals, kept in session.json.
func (s *Session) countRoot(u loop.Usage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := loop.Usage{}
	if s.meta.Usage != nil {
		total = loop.Usage(*s.meta.Usage)
	}
	total.Add(u)
	t := thread.Usage(total)
	s.meta.Usage, s.meta.ModelCalls = &t, s.meta.ModelCalls+1
	_ = s.store.SaveMeta(s.meta)
}

// rootTools is what the root thread may call in a mode: the built-ins its capabilities allow,
// the person's question tool, and the delegation tools.
func (s *Session) rootTools(mode policy.Mode) *tool.Catalog {
	allowed := map[string]bool{}
	for _, c := range policy.CapabilitiesForMode(mode) {
		allowed[c] = true
	}
	var list []*tool.Tool
	for _, t := range s.ws.Builtins() {
		if allowed[t.Capability] {
			list = append(list, t)
		}
	}
	if s.cfg.Ask != nil {
		list = append(list, s.askTool())
	}
	list = append(list, s.delegationTools(mode)...)
	if found, _ := s.Skills(); len(found) > 0 {
		list = append(list, skills.Tool(func() []skills.Skill { found, _ := s.Skills(); return found }))
	}
	for _, t := range s.mcp.Tools() { // deferred: tool_search finds them, or the model names one
		if allowed[t.Capability] {
			list = append(list, t)
		}
	}
	deferTools(list, s.cfg.Env.Get("ARCHYMEDES_DEFER_TOOLS"))
	// The secret scan is defender mode's from the start; elsewhere tool_search finds it.
	for _, t := range list {
		if t.Name == "scan_secrets" {
			t.Deferred = mode != policy.Defender
		}
	}
	return tool.NewCatalog(list...)
}

// Skills are the skills found now in the project and the person's skills folders, and what was
// wrong with any skipped. Read again each time, so a skill added mid-session is found.
func (s *Session) Skills() ([]skills.Skill, []string) {
	home, _ := os.UserHomeDir()
	return skills.Discover(skills.Folders(s.cfg.Root, home, s.cfg.ConfigDir))
}

// Tools is what the root thread may call in the session's mode now, as the model sees them.
func (s *Session) Tools() []*tool.Tool { return s.rootTools(s.Mode()).All() }

// rarelyNeeded are built-ins deferred by default: each is sent on every request otherwise, and
// most turns never call them.
var rarelyNeeded = []string{"git_log", "git_show", "todo_read", "close_agent"}

// deferTools applies ARCHYMEDES_DEFER_TOOLS: "off" sends every tool, a comma list defers those
// names, and anything else (the default) defers the rarely needed ones.
func deferTools(list []*tool.Tool, setting string) {
	setting = strings.TrimSpace(strings.ToLower(setting))
	if setting == "off" || setting == "none" {
		return
	}
	names := rarelyNeeded
	if setting != "" && setting != "auto" {
		names = strings.Split(setting, ",")
	}
	for _, t := range list {
		for _, name := range names {
			if strings.TrimSpace(name) == t.Name {
				t.Deferred = true
			}
		}
	}
}

func (s *Session) askTool() *tool.Tool {
	return &tool.Tool{
		Name:        "ask_user",
		Description: "Ask the person one question when you cannot reasonably decide yourself. Options are suggestions; they may answer anything.",
		Schema: tool.ObjectSchema(map[string]any{
			"question":    map[string]any{"type": "string"},
			"options":     map[string]any{"type": "array", "items": map[string]any{"type": "string"}},
			"multiSelect": map[string]any{"type": "boolean"},
		}, "question"),
		Capability: tool.CapPlanning, Effect: tool.EffectNone,
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			question := tool.StringArg(args, "question")
			if question == "" {
				return tool.Error("`question` is required")
			}
			var options []string
			if list, ok := args["options"].([]any); ok {
				for _, o := range list {
					if text, ok := o.(string); ok {
						options = append(options, text)
					}
				}
			}
			answer, err := s.cfg.Ask(ctx, question, options, tool.BoolArg(args, "multiSelect"))
			if err != nil {
				return tool.Error("No answer: " + err.Error())
			}
			if strings.TrimSpace(answer) == "" {
				return tool.Text("The person dismissed the question without answering. Decide yourself, and say what you assumed.")
			}
			return tool.Result{Content: "The person answered: " + answer, Data: map[string]any{"answer": answer}}
		},
	}
}
