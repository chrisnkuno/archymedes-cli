package tui

import (
	"encoding/json"
	"slices"
	"strconv"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// What the phone may ask (docs/engine/PHONE_PROTOCOL.md, Messages to the computer). Each request
// does what the same act at the terminal does, through the same code, and is answered with an ack.
// Nothing the phone sends runs a shell or a slash command: a message is only ever a message.

type linkRequest struct {
	Type     string   `json:"type"`
	ID       string   `json:"id"`
	Text     *string  `json:"text"`
	Approval string   `json:"approval"`
	Choice   string   `json:"choice"`
	Choices  []string `json:"choices"`
	Mode     string   `json:"mode"`
	Command  string   `json:"command"`
	Action   string   `json:"action"`
	Arg      string   `json:"arg"`
	Path     string   `json:"path"`
	Offset   int64    `json:"offset"`
	Query    string   `json:"query"`
	Item     string   `json:"item"`
	Helper   string   `json:"helper"`
}

// linkRequest handles one request from the phone.
func (m *Model) linkRequest(raw json.RawMessage) tea.Cmd {
	var r linkRequest
	if err := json.Unmarshal(raw, &r); err != nil {
		var id struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(raw, &id)
		m.linkAck(id.ID, false, "That request could not be read")
		return nil
	}
	refuse := func(why string) tea.Cmd { m.linkAck(r.ID, false, why); return nil }
	ok := func(text string, cmd tea.Cmd) tea.Cmd { m.linkAck(r.ID, true, text); return cmd }
	switch r.Type {
	case "hello", "resync":
		m.link.full = true
		return ok("", nil)
	case "send":
		if r.Text == nil || strings.TrimSpace(*r.Text) == "" {
			return refuse("Nothing to send")
		}
		text := *r.Text
		m.home = false
		switch m.phase {
		case busy:
			return ok("Queued: it goes in after what Friday is doing", m.queueDuringRun(text))
		case ready:
			return ok("Sent", m.send(text))
		case connecting:
			m.enqueue(text)
			return ok("Queued: Friday is still starting", nil)
		}
		return refuse("Friday is not running on the computer")
	case "answer":
		return m.linkAnswer(r)
	case "stop":
		if m.phase != busy {
			return refuse("Nothing is running")
		}
		return ok("Stopping", m.cancelTurn())
	case "undo":
		return ok("Undoing the last turn", m.sessionCommand("undo", ""))
	case "mode":
		if !slices.Contains(acp.Modes, r.Mode) {
			return refuse("No mode " + strconv.Quote(r.Mode))
		}
		return ok("Mode "+r.Mode, m.setMode(r.Mode))
	case "files", "file", "search", "changes", "diff", "overview", "log":
		return m.linkProject(r)
	case "slash":
		return m.linkSlash(r)
	case "queue":
		return m.linkQueue(r)
	case "helper":
		return m.linkHelper(r)
	case "command":
		if r.Command == "" {
			return refuse("Which command?")
		}
		switch r.Action {
		case "stop":
			return ok("Stopping "+r.Command, m.sessionCommand("command-stop", r.Command))
		case "restart":
			return ok("Running "+r.Command+" again", m.sessionCommand("command-restart", r.Command))
		}
		return refuse("A command can be stopped or restarted")
	}
	return refuse("Friday does not know that request")
}

// linkAnswer answers the approval or question waiting now; the first answer wins, here or there.
func (m *Model) linkAnswer(r linkRequest) tea.Cmd {
	a := m.approval
	if a == nil || r.Approval == "" || m.link.approvals[a] != r.Approval {
		m.linkAck(r.ID, false, "That was answered already, or is not the one waiting")
		return nil
	}
	said, card := "", a.req.ToolCall.ToolCallID
	if a.ask != nil {
		card = a.ask.ToolCallID
		switch {
		case r.Text != nil && strings.TrimSpace(*r.Text) != "" && !a.ask.MultiSelect:
			said = strings.TrimSpace(*r.Text)
		case len(r.Choices) > 0 && a.ask.MultiSelect:
			var labels []string
			for _, c := range r.Choices {
				i, err := strconv.Atoi(c)
				if err != nil || i < 1 || i > len(a.ask.Options) {
					m.linkAck(r.ID, false, "No option "+c)
					return nil
				}
				labels = append(labels, a.ask.Options[i-1])
			}
			said = strings.Join(labels, ", ")
		case r.Choice != "":
			i, err := strconv.Atoi(r.Choice)
			if err != nil || i < 1 || i > len(a.ask.Options) {
				m.linkAck(r.ID, false, "No option "+r.Choice)
				return nil
			}
			said = a.ask.Options[i-1]
		default:
			m.linkAck(r.ID, false, "No answer given")
			return nil
		}
		a.ask.Answer(said)
	} else {
		if !a.offers(r.Choice) {
			m.linkAck(r.ID, false, "That choice is not offered")
			return nil
		}
		said = r.Choice
		for _, o := range a.req.Options {
			if o.OptionID == r.Choice {
				said = o.Name
			}
		}
		a.req.Answer(r.Choice)
	}
	m.nextApproval()
	if t := m.tools[card]; t != nil && card != "" {
		t.phone = said
		t.touch()
	}
	m.linkAck(r.ID, true, "Answered: "+said)
	return m.toast(toastInfo, "Answered from your phone: "+notificationText(said))
}
