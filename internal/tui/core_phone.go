package tui

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/config"
)

// Answers from the phone (WS-69). The phone cannot reach this computer, so a reply travels through
// the push server: the notification for an approval or a short question carries ntfy buttons that
// POST to a reply topic beside the push topic, and Friday listens to that topic while something
// waits for an answer. Each prompt gets a random one-time id and, per button, a token: an HMAC of
// the id and the choice under a secret made for this session. A reply counts only with a valid
// token for a prompt still waiting, once; anything else on the topic is ignored without a word.

// phoneGate holds this session's secret and the prompts the phone may still answer.
type phoneGate struct {
	secret  []byte
	pending map[string]map[string]bool // prompt id → the choices its buttons offered
}

func newPhoneGate() *phoneGate {
	secret := make([]byte, 32)
	_, _ = rand.Read(secret)
	return &phoneGate{secret: secret, pending: map[string]map[string]bool{}}
}

// token is the HMAC that proves a reply came from this session's button for this choice.
func (g *phoneGate) token(id, choice string) string {
	mac := hmac.New(sha256.New, g.secret)
	mac.Write([]byte(id + "|" + choice))
	return hex.EncodeToString(mac.Sum(nil))
}

// mint opens a prompt to the phone: a fresh id and a token for each choice.
func (g *phoneGate) mint(choices []string) (id string, tokens map[string]string) {
	raw := make([]byte, 12)
	_, _ = rand.Read(raw)
	id = hex.EncodeToString(raw)
	g.pending[id] = map[string]bool{}
	tokens = map[string]string{}
	for _, choice := range choices {
		g.pending[id][choice] = true
		tokens[choice] = g.token(id, choice)
	}
	return id, tokens
}

// accept reads a reply. It answers ok only for a valid token of a choice offered for a prompt
// still waiting, and then closes that prompt, so no reply counts twice.
func (g *phoneGate) accept(body string) (id, choice string, ok bool) {
	f := strings.Fields(body)
	if len(f) != 4 || f[0] != "friday" {
		return "", "", false
	}
	id, choice = f[1], f[2]
	if !g.pending[id][choice] || !hmac.Equal([]byte(f[3]), []byte(g.token(id, choice))) {
		return "", "", false
	}
	delete(g.pending, id)
	return id, choice, true
}

// forget closes a prompt answered here: its buttons on the phone do nothing from now on.
func (g *phoneGate) forget(id string) { delete(g.pending, id) }

// waiting is how many prompts the phone may still answer.
func (g *phoneGate) waiting() int { return len(g.pending) }

// phoneReplyBody is what a button posts to the reply topic.
func phoneReplyBody(id, choice, token string) string {
	return "friday " + id + " " + choice + " " + token
}

// phoneTopics is the reply topic beside a push topic (`…/topic` → `…/topic-reply`) and the URL of
// its JSON stream. A query, such as ntfy's `auth=`, is kept on both.
func phoneTopics(push string) (reply, stream string, ok bool) {
	u, err := url.Parse(strings.TrimSpace(push))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", "", false
	}
	path := strings.TrimRight(u.Path, "/")
	if path == "" {
		return "", "", false
	}
	u.Path, u.RawPath = path+"-reply", ""
	reply = u.String()
	u.Path += "/json"
	return reply, u.String(), true
}

// ntfyAction is one button of an ntfy notification.
type ntfyAction struct {
	Action string `json:"action"`
	Label  string `json:"label"`
	URL    string `json:"url"`
	Method string `json:"method"`
	Body   string `json:"body"`
	Clear  bool   `json:"clear"`
}

// phoneActions is ntfy's Actions header: the buttons as JSON, in plain ASCII so any label survives
// the trip as a header.
func phoneActions(reply string, labels, bodies []string) string {
	actions := make([]ntfyAction, len(labels))
	for i := range labels {
		label := notificationText(labels[i])
		if r := []rune(label); len(r) > 40 {
			label = string(r[:39]) + "…"
		}
		actions[i] = ntfyAction{Action: "http", Label: label, URL: reply, Method: http.MethodPost, Body: bodies[i], Clear: true}
	}
	raw, _ := json.Marshal(actions)
	var b strings.Builder
	for _, r := range string(raw) {
		if r < 0x80 {
			b.WriteRune(r)
			continue
		}
		for _, unit := range utf16.Encode([]rune{r}) {
			fmt.Fprintf(&b, `\u%04x`, unit)
		}
	}
	return b.String()
}

// phoneChoices is what the phone may answer: Allow and Deny for an approval (never a standing
// rule; Deny alone for a risky one), or each option of a question that takes one of at most three (ntfy's limit).
func phoneChoices(a *approval) (labels, choices []string) {
	if a.ask != nil {
		if a.ask.MultiSelect || len(a.ask.Options) == 0 || len(a.ask.Options) > 3 {
			return nil, nil
		}
		for i, option := range a.ask.Options {
			labels, choices = append(labels, option), append(choices, strconv.Itoa(i+1))
		}
		return labels, choices
	}
	for _, c := range [][2]string{{"allow", "Allow"}, {"deny", "Deny"}} {
		if c[0] == "allow" && len(a.req.Risk) > 0 {
			continue // a risky one is allowed at the terminal, where its command can be read
		}
		if a.offers(c[0]) {
			labels, choices = append(labels, c[1]), append(choices, c[0])
		}
	}
	return labels, choices
}

// phoneLink is the session's side of answers from the phone.
type phoneLink struct {
	gate   *phoneGate
	cancel func() // stops listening to the reply topic; nil while not listening
}

// phoneReplyMsg is one message from the reply topic.
type phoneReplyMsg struct{ body string }

// phoneRepliesOff is whether answers from the phone are off: they are taken only with
// ARCHYMEDES_NOTIFY_REPLIES=on, since anyone who can read the push topic can press its buttons.
func (m *Model) phoneRepliesOff() bool {
	return !strings.EqualFold(strings.TrimSpace(firstNonEmpty(os.Getenv("ARCHYMEDES_NOTIFY_REPLIES"), config.Setting(m.opts.ConfigDir, "ARCHYMEDES_NOTIFY_REPLIES"))), "on")
}

// offerToPhone opens a prompt to the phone and returns the buttons for its notification, or "" when
// the phone cannot answer this one. It listens to the reply topic from now until nothing waits.
func (m *Model) offerToPhone(push string, a *approval) string {
	if m.sender == nil || m.phoneRepliesOff() {
		return ""
	}
	reply, stream, ok := phoneTopics(push)
	labels, choices := phoneChoices(a)
	if !ok || len(choices) == 0 {
		return ""
	}
	link := &m.notifier.phone
	if link.gate == nil {
		link.gate = newPhoneGate()
	}
	id, tokens := link.gate.mint(choices)
	a.phone = id
	if link.cancel == nil {
		link.cancel = listenPhone(stream, m.sender)
	}
	bodies := make([]string, len(choices))
	for i, choice := range choices {
		bodies[i] = phoneReplyBody(id, choice, tokens[choice])
	}
	return phoneActions(reply, labels, bodies)
}

// forgetPhone closes an answered request's prompt on the phone, and stops listening when nothing
// else waits for it.
func (m *Model) forgetPhone(a *approval) {
	link := &m.notifier.phone
	if link.gate == nil {
		return
	}
	if a != nil && a.phone != "" {
		link.gate.forget(a.phone)
	}
	if link.gate.waiting() == 0 {
		m.stopPhone()
	}
}

// stopPhone stops listening to the reply topic.
func (m *Model) stopPhone() {
	if m.notifier.phone.cancel != nil {
		m.notifier.phone.cancel()
		m.notifier.phone.cancel = nil
	}
}

// phoneReply answers the request a valid reply is for, as if its button had been pressed here.
func (m *Model) phoneReply(body string) tea.Cmd {
	gate := m.notifier.phone.gate
	if gate == nil {
		return nil
	}
	id, choice, ok := gate.accept(body)
	if !ok {
		return nil
	}
	a := m.takeApproval(id)
	defer m.forgetPhone(nil)
	if a == nil {
		return nil
	}
	said, card := "Allow", a.req.ToolCall.ToolCallID
	switch {
	case a.ask != nil:
		index, _ := strconv.Atoi(choice)
		said, card = a.ask.Options[index-1], a.ask.ToolCallID
		a.ask.Answer(said)
	default:
		if choice == "deny" {
			said = "Deny"
		}
		a.req.Answer(choice)
	}
	if t := m.tools[card]; t != nil && card != "" {
		t.phone = said
		t.touch()
	}
	return m.toast(toastInfo, "Answered from your phone: "+notificationText(said))
}

// takeApproval removes the request with this phone prompt, on screen or waiting behind it.
func (m *Model) takeApproval(id string) *approval {
	if a := m.approval; a != nil && a.phone == id {
		m.approval = nil
		if len(m.approvals) > 0 {
			m.approval, m.approvals = m.approvals[0], m.approvals[1:]
		}
		return a
	}
	for i, a := range m.approvals {
		if a.phone == id {
			m.approvals = append(m.approvals[:i:i], m.approvals[i+1:]...)
			return a
		}
	}
	return nil
}

// phoneBackoff is the first wait before listening again after the stream dropped; it doubles to
// phoneBackoffMax.
var phoneBackoff = time.Second

const phoneBackoffMax = 30 * time.Second

// listenPhone follows the reply topic's JSON stream, reconnecting with backoff, and hands each
// message to send until stopped. It asks for messages from a minute before it started (`since=`), so
// a reply sent while it connects or reconnects is not lost; one read twice is refused by the gate.
func listenPhone(stream string, send func(tea.Msg)) (stop func()) {
	ctx, cancel := context.WithCancel(context.Background())
	since := time.Now().Add(-time.Minute).Unix()
	first := phoneBackoff // read once, here: the goroutine never reads the package variable
	go func() {
		wait := first
		for ctx.Err() == nil {
			if readPhoneStream(ctx, stream, since, func(body string) {
				if ctx.Err() == nil {
					send(phoneReplyMsg{body: body})
				}
			}) {
				wait = first
			}
			select {
			case <-ctx.Done():
				return
			case <-time.After(wait):
			}
			wait = min(wait*2, phoneBackoffMax)
		}
	}()
	return cancel
}

// readPhoneStream reads one connection to the stream until it ends; connected says it was taken.
func readPhoneStream(ctx context.Context, stream string, since int64, deliver func(string)) (connected bool) {
	u, err := url.Parse(stream)
	if err != nil {
		return false
	}
	q := u.Query()
	q.Set("since", strconv.FormatInt(since, 10))
	u.RawQuery = q.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return false
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return false
	}
	lines := bufio.NewScanner(resp.Body)
	lines.Buffer(make([]byte, 64*1024), 64*1024)
	for lines.Scan() {
		var event struct{ Event, Message string }
		if json.Unmarshal(lines.Bytes(), &event) == nil && event.Event == "message" {
			deliver(event.Message)
		}
	}
	return true
}
