package tui

import (
	"context"
	"fmt"
	"path"
	"slices"
	"sort"
	"strings"
	"time"

	"charm.land/bubbles/v2/key"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// Suggestions beside the work, from the engine's core/advise: up to three next steps under a turn
// that changed code (alt+1..3 or tab put one in the input; a click too), notes under each edit,
// and while a request is typed, the command, earlier request or file it seems headed for (tab
// takes it). The interface finds the typing candidates itself and ranks them by the words they
// share; Jev, when the engine has it, weighs them again. Nothing is ever sent without enter.

const (
	// typingPause is how long typing rests before hints are looked for.
	typingPause = 250 * time.Millisecond
	// minTypedRunes is the least typed before hints appear: fewer says too little to match.
	minTypedRunes = 4
	// maxHints is how many typing hints are shown, on one row.
	maxHints = 2
	// minLocalMatch is the share of the typed words a candidate must share to be offered without
	// Jev. Jev is asked about any that share a word, so it finds what the words alone miss.
	minLocalMatch = 0.5
	// maxJudged is how many candidates Jev weighs at once (advise.MaxOptions).
	maxJudged = 24
	// minJudged is the least probability, by Jev, for a hint it weighed to stay.
	minJudged = 0.25
)

// hint is one typing candidate: what taking it does (kind command, request or file), the text it
// puts in, the line shown, and how well it matches.
type hint struct {
	kind, text, label string
	score             float64
}

// adviceState is the Model's share of this: the last turn's next steps, and the typing hints.
type adviceState struct {
	nextSteps []acp.Suggestion
	typing    typingHints
}

// adviceMsg handles the typing pause and Jev's answer; false for any other message.
func (m *Model) adviceMsg(msg tea.Msg) (tea.Cmd, bool) {
	switch msg := msg.(type) {
	case typingTickMsg:
		return m.lookForHints(msg), true
	case typingRankedMsg:
		m.hintsRanked(msg)
		return nil, true
	}
	return nil, false
}

// typingHints is what the typing row shows, for the input it was found for.
type typingHints struct {
	seq     int
	input   string
	options []hint
	judged  bool // Jev weighed these
}

type typingTickMsg struct{ seq int }

type typingRankedMsg struct {
	seq    int
	input  string
	scores []float64
	none   float64
	pool   []hint
}

// suggester is an agent that can weigh typing candidates (the Go engine's _archymedes/suggest).
type suggester interface {
	Suggest(ctx context.Context, input string, options []string) ([]float64, float64, bool)
}

// --- next steps after a turn ---

// takeSuggestions keeps a finished turn's next steps; a turn already running makes them stale.
func (m *Model) takeSuggestions(steps []acp.Suggestion) {
	if m.phase == busy {
		return
	}
	m.nextSteps = steps
}

// noteEdit puts the engine's notes under the edit they are about.
func (m *Model) noteEdit(ev acp.Event) {
	if t := m.tools[ev.ToolCallID]; t != nil && len(ev.Notes) > 0 {
		t.notes = append(t.notes, ev.Notes...)
		t.touch()
	}
}

// useSuggestion puts suggestion i in the input: a next step on an empty input, else typing hint i.
func (m *Model) useSuggestion(i int) bool {
	if m.input.value() != "" {
		if h := m.shownHints(); i < len(h) {
			m.applyHint(h[i])
			return true
		}
		return false
	}
	if steps := m.shownSteps(); i < len(steps) {
		m.input.area.InsertString(steps[i].Text)
		return true
	}
	return false
}

// offerNextStep is tab on an empty input (or on a step it put there) after a turn: the next of the
// steps, in turn. False when there are none, so tab does what it always does.
func (m *Model) offerNextStep() bool {
	steps := m.shownSteps()
	if len(steps) == 0 {
		return false
	}
	next := 0
	if current := m.input.value(); current != "" {
		i := slices.IndexFunc(steps, func(s acp.Suggestion) bool { return s.Text == current })
		if i < 0 {
			return false
		}
		next = (i + 1) % len(steps)
	}
	m.input.take()
	m.input.area.InsertString(steps[next].Text)
	return true
}

// shownSteps are the next steps while they apply: Chat, no turn running, nothing else typed.
func (m *Model) shownSteps() []acp.Suggestion {
	if m.phase == busy || m.landingVisible() || m.activeWindow() != nil {
		return nil
	}
	if v := m.input.value(); v != "" && !slices.ContainsFunc(m.nextSteps, func(s acp.Suggestion) bool { return s.Text == v }) {
		return nil
	}
	return m.nextSteps
}

// --- hints while typing ---

// typed starts the pause after a change to the input, after which hints are looked for.
func (m *Model) typed(before string) tea.Cmd {
	if m.input.value() == before {
		return nil
	}
	m.typing.seq++
	seq := m.typing.seq
	return tea.Tick(typingPause, func(time.Time) tea.Msg { return typingTickMsg{seq} })
}

// lookForHints finds candidates for what is typed now and, when the engine can, asks it to weigh
// them.
func (m *Model) lookForHints(msg typingTickMsg) tea.Cmd {
	if msg.seq != m.typing.seq {
		return nil
	}
	input := m.input.value()
	m.typing = typingHints{seq: m.typing.seq, input: input}
	if !m.hintable(input) {
		return nil
	}
	pool := m.hintPool(input)
	local := slices.DeleteFunc(slices.Clone(pool), func(h hint) bool { return h.score < minLocalMatch })
	m.typing.options = local[:min(len(local), maxHints)]
	var cmds []tea.Cmd
	if m.knownFiles == nil && !m.filesLoading && len(lastWord(input)) >= 3 {
		cmds = append(cmds, m.listFiles()) // file names join the candidates once read
	}
	if j, ok := m.agent.(suggester); ok && len(pool) > 0 {
		pool := pool[:min(len(pool), maxJudged)]
		options := make([]string, len(pool))
		for i, h := range pool {
			options[i] = h.label
		}
		seq := m.typing.seq
		cmds = append(cmds, func() tea.Msg {
			scores, none, ok := j.Suggest(context.Background(), input, options)
			if !ok {
				return nil
			}
			return typingRankedMsg{seq: seq, input: input, scores: scores, none: none, pool: pool}
		})
	}
	return tea.Batch(cmds...)
}

// hintsRanked takes Jev's weights, if the input is still what they were for.
func (m *Model) hintsRanked(msg typingRankedMsg) {
	if msg.seq != m.typing.seq || msg.input != m.input.value() {
		return
	}
	var kept []hint
	for i, h := range msg.pool {
		if msg.scores[i] >= minJudged && msg.scores[i] > msg.none {
			h.score = msg.scores[i]
			kept = append(kept, h)
		}
	}
	sort.SliceStable(kept, func(a, b int) bool { return kept[a].score > kept[b].score })
	m.typing.options, m.typing.judged = kept[:min(len(kept), maxHints)], true
}

// hintable: worth hinting at. Not a command or a shell line (they complete already), not while a
// completion list is open, and not too short to match.
func (m *Model) hintable(input string) bool {
	t := strings.TrimSpace(input)
	return len([]rune(t)) >= minTypedRunes && !strings.HasPrefix(t, "/") && !strings.HasPrefix(t, "!") &&
		len(m.input.complete) == 0 && m.activeWindow() == nil
}

// shownHints are the typing hints while they are for what is typed.
func (m *Model) shownHints() []hint {
	if m.typing.input != m.input.value() || !m.hintable(m.input.value()) {
		return nil
	}
	return m.typing.options
}

// hintPool is every candidate for input that shares a word with it, best first: slash commands by
// what they do, earlier requests, next steps and starters, and a file the last word begins.
func (m *Model) hintPool(input string) []hint {
	words := contentWords(input)
	var pool []hint
	add := func(h hint) {
		if h.score > 0 && !slices.ContainsFunc(pool, func(p hint) bool { return p.text == h.text }) {
			pool = append(pool, h)
		}
	}
	lower := strings.ToLower(strings.TrimSpace(input))
	requests := slices.Clone(m.input.history)
	slices.Reverse(requests)
	for _, s := range m.nextSteps {
		requests = append(requests, s.Text)
	}
	requests = append(requests, m.starters()...)
	for _, r := range requests {
		if strings.EqualFold(strings.TrimSpace(r), lower) || strings.HasPrefix(r, "/") {
			continue
		}
		score := overlap(words, r)
		if strings.HasPrefix(strings.ToLower(r), lower) {
			score = 1
		}
		add(hint{kind: "request", text: r, label: r, score: score})
	}
	for _, c := range append(slices.Clone(commands), m.custom...) {
		add(hint{kind: "command", text: "/" + c.name, label: "/" + c.name + " · " + c.help, score: overlap(words, c.name+" "+c.help)})
	}
	if last := lastWord(input); len(last) >= 3 && !strings.HasPrefix(last, "@") {
		for _, f := range m.knownFiles {
			if strings.HasPrefix(strings.ToLower(path.Base(f)), strings.ToLower(last)) {
				add(hint{kind: "file", text: f, label: "@" + f, score: 0.8})
				break
			}
		}
	}
	sort.SliceStable(pool, func(a, b int) bool { return pool[a].score > pool[b].score })
	return pool
}

// applyHint takes a hint: a command or a request replaces the input, a file replaces the last word.
func (m *Model) applyHint(h hint) {
	value := m.input.value()
	switch h.kind {
	case "file":
		cut := strings.LastIndexAny(value, " \t\n") + 1
		m.input.area.SetValue(value[:cut] + "@" + h.text + " ")
	case "command":
		m.input.area.SetValue(h.text + " ")
	default:
		m.input.area.SetValue(h.text)
	}
	m.input.area.MoveToEnd()
	m.input.refreshCompletions()
	m.typing.options = nil
}

// stopWords carry no meaning for matching a request to a command or another request.
var stopWords = map[string]bool{"the": true, "and": true, "for": true, "this": true, "that": true, "with": true, "can": true, "you": true,
	"please": true, "what": true, "how": true, "are": true, "was": true, "from": true, "into": true, "all": true, "my": true, "me": true, "its": true, "it's": true}

// contentWords are the typed words that say something, lower case.
func contentWords(text string) []string {
	var out []string
	for _, w := range strings.FieldsFunc(strings.ToLower(text), func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '\'')
	}) {
		if len(w) >= 3 && !stopWords[w] {
			out = append(out, w)
		}
	}
	return out
}

// overlap is the share of words found in text, a word matching another on its first four letters
// ("review" finds "reviewing").
func overlap(words []string, text string) float64 {
	if len(words) == 0 {
		return 0
	}
	other := contentWords(text)
	found := 0
	for _, w := range words {
		if slices.ContainsFunc(other, func(o string) bool { return stem(o) == stem(w) }) {
			found++
		}
	}
	return float64(found) / float64(len(words))
}

func stem(w string) string { return w[:min(len(w), 4)] }

func lastWord(text string) string {
	if strings.HasSuffix(text, " ") {
		return ""
	}
	f := strings.Fields(text)
	if len(f) == 0 {
		return ""
	}
	return f[len(f)-1]
}

// --- drawing ---

// adviceRows is how many rows the next steps or typing hints take above the input.
func (m *Model) adviceRows() int {
	if len(m.input.complete) > 0 {
		return 0
	}
	if h := m.shownHints(); len(h) > 0 {
		return 1
	}
	return len(m.shownSteps())
}

// adviceLines draws them, each with the key that takes it.
func (m *Model) adviceLines(width int) []string {
	th := m.th
	if len(m.input.complete) > 0 {
		return nil
	}
	if hints := m.shownHints(); len(hints) > 0 {
		var parts []string
		for i, h := range hints {
			part := th.Key.Render(keyLabel(m.suggestKey(i).Keys())) + th.Faint.Render(" › "+h.label)
			if i == 0 {
				part = th.Key.Render(keyLabel(m.keys.Complete.Keys())) + th.Faint.Render(" › ") + th.Body.Render(h.label)
			}
			parts = append(parts, mark(m.zones.frame, fmt.Sprintf("hintopt:%d", i), part)) // a click takes it
		}
		line := strings.Join(parts, th.Faint.Render("  ·  "))
		if m.typing.judged {
			line = th.Faint.Render("⟡ ") + line // weighed by Jev, not only matched by words
		}
		return []string{ansi.Truncate(line, width, "…")}
	}
	var out []string
	for i, s := range m.shownSteps() {
		keys := keyLabel(m.suggestKey(i).Keys())
		if i == 0 && m.input.value() == "" {
			keys += "/" + keyLabel(m.keys.Complete.Keys())
		}
		text := th.Body.Render(s.Text)
		if m.input.value() == s.Text {
			text = th.Title.Render(s.Text)
		}
		row := th.Key.Render(padRight(keys, 10)) + th.Faint.Render("› ") + text + th.Faint.Render(" · "+s.Why)
		if s.Score > 0 {
			row += th.Faint.Render(fmt.Sprintf("  %d%%", int(s.Score*100+0.5)))
		}
		out = append(out, mark(m.zones.frame, fmt.Sprintf("step:%d", i), ansi.Truncate(row, width, "…")))
	}
	return out
}

// composerClick is a click on what opens above the input: a completion (the first selects it, a
// second takes it) or a typing hint (taken at once, as tab takes it).
func (m *Model) composerClick(msg tea.MouseClickMsg) (tea.Cmd, bool) {
	for i := range m.input.complete {
		if m.zones.frame.Get(fmt.Sprintf("comp:%d", i)).InBounds(msg) {
			if m.input.compPos == i {
				m.input.accept()
			}
			m.input.compPos = i
			return nil, true
		}
	}
	for i, h := range m.shownHints() {
		if m.zones.frame.Get(fmt.Sprintf("hintopt:%d", i)).InBounds(msg) {
			m.applyHint(h)
			return nil, true
		}
	}
	return nil, false
}

func (m *Model) suggestKey(i int) key.Binding {
	return [...]key.Binding{m.keys.Suggest1, m.keys.Suggest2, m.keys.Suggest3}[min(i, 2)]
}

// editNotes are the lines under an edit: each note, a judged one with Jev's probability.
func editNotes(ctx renderCtx, notes []acp.EditNote) []string {
	th := ctx.th
	var out []string
	for _, n := range notes {
		line := "  " + th.Warn.Render("⚑ ") + th.Body.Render(n.Text)
		if n.Kind == "judged" {
			line += th.Faint.Render(fmt.Sprintf(" · jev %d%%", int(n.Score*100+0.5)))
		}
		out = append(out, ansi.Truncate(line, ctx.width, "…"))
	}
	return out
}
