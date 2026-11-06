package tui

import (
	"encoding/json"
	"hash/fnv"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/config"
	"github.com/chrisnkuno/friday-cli/internal/phone"
)

// What the phone is shown: the session as the protocol's state, and, between states, patches of
// only what changed. Items keep an id for as long as they are on screen; an item that goes makes
// the next message a whole state.

// linkMessage is the next message for the phone: a state, a patch, or nil when nothing changed.
func (m *Model) linkMessage() []byte {
	l := m.link
	parts := m.linkParts()
	var upserts []map[string]any
	present := map[string]bool{}
	var order []string
	for _, it := range m.tr.items {
		entry, ok := m.linkItem(it)
		if !ok {
			continue
		}
		id := entry["id"].(string)
		present[id], order = true, append(order, id)
		// What the phone would be shown, hashed: any change to it, whatever made it, is sent.
		raw, _ := json.Marshal(entry)
		h := fnv.New64a()
		h.Write(raw)
		if sum := h.Sum64() | 1; l.full || l.versions[id] != sum { // |1: never the zero of "not sent"
			l.versions[id] = sum
			upserts = append(upserts, entry)
		}
	}
	for _, id := range l.sent {
		if !present[id] {
			l.full = true // an item went: the phone is sent the whole picture again
		}
	}
	msg := map[string]any{}
	changed := false
	for name, value := range parts {
		raw, _ := json.Marshal(value)
		if l.full || l.parts[name] != string(raw) {
			l.parts[name], msg[name], changed = string(raw), value, true
		}
	}
	if l.full {
		var all []map[string]any
		for _, it := range m.tr.items {
			if entry, ok := m.linkItem(it); ok {
				all = append(all, entry)
			}
		}
		msg["type"], msg["items"] = "state", all
		if all == nil {
			msg["items"] = []map[string]any{}
		}
		l.full = false
	} else {
		if len(upserts) == 0 && !changed {
			return nil
		}
		msg["type"] = "patch"
		if len(upserts) > 0 {
			msg["items"] = upserts
		}
	}
	l.sent = order
	l.rev++
	msg["rev"] = l.rev
	raw, err := json.Marshal(msg)
	if err != nil || len(raw) > phone.MaxMessage {
		// Too big even with items cut: send the newest items only, as a state.
		msg["type"] = "state"
		msg["items"] = m.linkNewest(phone.MaxMessage / 2)
		raw, _ = json.Marshal(msg)
	}
	return raw
}

// linkNewest is the newest items whose text fits in budget bytes.
func (m *Model) linkNewest(budget int) []map[string]any {
	var out []map[string]any
	for i := len(m.tr.items) - 1; i >= 0; i-- {
		entry, ok := m.linkItem(m.tr.items[i])
		if !ok {
			continue
		}
		raw, _ := json.Marshal(entry)
		if budget -= len(raw); budget < 0 {
			break
		}
		out = append(out, entry)
	}
	slices.Reverse(out)
	m.link.sent = nil
	for _, e := range out {
		m.link.sent = append(m.link.sent, e["id"].(string))
	}
	return out
}

// linkParts is the state's parts other than its items.
func (m *Model) linkParts() map[string]any {
	info := m.session.Info
	ctxText, _ := contextGauge(m.contextUsed, info)
	session := map[string]any{"project": m.projectName(), "model": info.Model, "mode": m.mode, "ctx": ctxText}
	phase := map[phase]string{connecting: "starting", ready: "ready", busy: "busy", failed: "failed"}[m.phase]
	parts := map[string]any{"session": session, "phase": phase, "since": nil, "approval": m.linkApproval(), "plan": nil}
	if m.phase == busy {
		parts["since"] = m.turnStart.UnixMilli()
	}
	queue := []map[string]any{}
	for _, q := range m.queue {
		queue = append(queue, map[string]any{"id": "q" + strconv.Itoa(q.id), "text": m.linkText(q.text)})
	}
	parts["queue"] = queue
	if n := len(m.growth.plan); n > 0 {
		done := 0
		for _, b := range m.growth.plan {
			if b.status == "done" {
				done++
			}
		}
		plan := map[string]any{"done": done, "total": n, "left": ""}
		if left, ok := m.planTimeLeft(); ok && done < n {
			plan["left"] = approx(left)
		}
		parts["plan"] = plan
	}
	activity := []map[string]any{}
	for _, a := range m.activity.byID {
		activity = append(activity, map[string]any{"id": a.ID, "command": m.linkText(a.Command), "status": a.Status, "stuck": a.Stuck})
	}
	slices.SortFunc(activity, func(a, b map[string]any) int { return strings.Compare(a["id"].(string), b["id"].(string)) })
	parts["activity"] = activity
	return parts
}

// linkApproval is what waits for an answer, as the phone shows it, or nil.
func (m *Model) linkApproval() any {
	a := m.approval
	if a == nil {
		return nil
	}
	id := m.link.approvals[a]
	if id == "" {
		m.link.nextID++
		id = "a" + strconv.Itoa(m.link.nextID)
		m.link.approvals[a] = id
	}
	if a.ask != nil {
		options := []map[string]any{}
		for i, o := range a.ask.Options {
			options = append(options, map[string]any{"id": strconv.Itoa(i + 1), "label": m.linkText(o)})
		}
		return map[string]any{"id": id, "kind": "question", "text": m.linkText(a.ask.Question), "options": options,
			"multi": a.ask.MultiSelect, "free": !a.ask.MultiSelect}
	}
	command := a.req.ToolCall.Title
	if t := m.tools[a.req.ToolCall.ToolCallID]; t != nil {
		if isCommand(t.name, t.args) {
			command = commandText(t.args)
		} else if brief := toolBrief(t); brief != "" {
			command = t.name + " " + brief
		}
	}
	options := []map[string]any{}
	for _, o := range a.req.Options {
		options = append(options, map[string]any{"id": o.OptionID, "label": o.Name})
	}
	risk := a.req.Risk
	if risk == nil {
		risk = []string{}
	}
	return map[string]any{"id": id, "kind": "approval", "title": m.linkText(a.req.ToolCall.Title), "command": m.linkText(command),
		"risk": risk, "options": options}
}

// linkItem is one transcript block as the phone shows it; false for blocks the phone skips.
func (m *Model) linkItem(it item) (map[string]any, bool) {
	id := m.link.ids[it]
	if id == "" {
		m.link.nextID++
		id = "i" + strconv.Itoa(m.link.nextID)
		m.link.ids[it] = id
	}
	e := map[string]any{"id": id, "status": "done", "stuck": false}
	switch v := it.(type) {
	case *userItem:
		e["kind"], e["text"] = "user", m.linkText(v.text)
	case *assistantItem:
		e["kind"], e["text"] = "assistant", m.linkText(strings.TrimSpace(v.text.String()))
		if v.open {
			e["status"] = "running"
		}
	case *toolItem:
		e["kind"] = "tool"
		if v.sub != nil || delegationTools[v.name] {
			e["kind"] = "helper"
		}
		title := v.name
		if isCommand(v.name, v.args) {
			title += " " + commandText(v.args)
		} else if brief := toolBrief(v); brief != "" {
			title += " " + brief
		}
		e["title"] = m.linkText(title)
		text := v.result
		if v.diff != "" {
			text = v.diff
		}
		e["text"] = m.linkText(text)
		switch {
		case !v.done:
			e["status"] = "running"
		case v.isError || v.denied:
			e["status"] = "failed"
		}
		e["stuck"] = v.stuck != ""
		if v.phone != "" {
			e["answered"] = v.phone
		}
	case *noticeItem:
		e["kind"], e["text"] = "notice", m.linkText(v.text)
	case *turnItem:
		return nil, false
	default:
		ctx := renderCtx{th: m.th, md: m.md, width: 72, root: m.projectRoot(), zones: m.zones.frame}
		e["kind"], e["text"] = "notice", m.linkText(ansi.Strip(strings.Join(it.render(ctx), "\n")))
	}
	return e, true
}

// linkText is text fit for the phone: no escape codes, no known secret, at most its last
// linkItemText characters.
func (m *Model) linkText(s string) string {
	s = ansi.Strip(s)
	for _, secret := range m.link.secrets {
		s = strings.ReplaceAll(s, secret, "[hidden]")
	}
	if r := []rune(s); len(r) > linkItemText {
		s = "…" + string(r[len(r)-linkItemText+1:])
	}
	return s
}

var secretName = regexp.MustCompile(`(?i)(key|token|secret|password|passwd|auth|credential)`)

// knownSecrets are the values of keys, tokens and passwords in the environment and in Friday's
// settings: never sent to the phone, whatever prints them.
func knownSecrets(configDir string) []string {
	var out []string
	add := func(name, value string) {
		if value = strings.TrimSpace(value); len(value) >= 8 && secretName.MatchString(name) {
			out = append(out, value)
		}
	}
	for _, kv := range os.Environ() {
		if name, value, ok := strings.Cut(kv, "="); ok {
			add(name, value)
		}
	}
	for name, value := range config.Settings(configDir) {
		add(name, value)
	}
	// Longest first, so a key that contains another is hidden whole.
	slices.SortFunc(out, func(a, b string) int { return len(b) - len(a) })
	return out
}
