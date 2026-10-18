package tui

import (
	"fmt"
	"io"

	"charm.land/bubbles/v2/spinner"
	tea "charm.land/bubbletea/v2"
	"charm.land/log/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
)

// A structured debug log (charm.land/log/v2, logfmt) of what the interface does: every message it
// handles except the animation ticks, with enough detail to replay a report. Written only to the
// file ARCHYMEDES_DEBUG_LOG names — the terminal belongs to the interface — and free when off.

// NewDebugLog is the logger for w; nil w means no logging.
func NewDebugLog(w io.Writer) *log.Logger {
	if w == nil {
		return nil
	}
	return log.NewWithOptions(w, log.Options{
		Level: log.DebugLevel, ReportTimestamp: true, TimeFormat: "15:04:05.000",
		Prefix: "friday", Formatter: log.LogfmtFormatter,
	})
}

func (m *Model) debug(msg tea.Msg) {
	if m.opts.Debug == nil {
		return
	}
	switch msg := msg.(type) {
	case spinner.TickMsg, animTickMsg, scrollTickMsg:
		return // sixty a second; they say nothing
	case tea.KeyPressMsg:
		m.opts.Debug.Debug("key", "key", msg.String(), "overlay", fmt.Sprintf("%T", m.overlay), "approval", m.approval != nil, "phase", m.phase)
	case tea.WindowSizeMsg:
		m.opts.Debug.Debug("resize", "width", msg.Width, "height", msg.Height)
	case agentMsg:
		m.debugAgent(msg.msg)
	case promptDoneMsg:
		m.opts.Debug.Debug("prompt returned", "err", msg.err)
	case connectFailedMsg:
		m.opts.Debug.Error("agent did not start", "err", msg.err)
	case connectedMsg:
		m.opts.Debug.Info("session open", "id", msg.session.ID, "model", msg.session.Info.Model, "workspace", msg.session.Info.Workspace)
	default:
		m.opts.Debug.Debug("message", "type", fmt.Sprintf("%T", msg))
	}
}

func (m *Model) debugAgent(msg any) {
	l := m.opts.Debug
	switch msg := msg.(type) {
	case acp.TextChunk:
		l.Debug("agent text", "bytes", len(msg.Text))
	case acp.TurnEnded:
		l.Info("turn ended", "stop", msg.StopReason)
	case acp.PermissionRequest:
		l.Info("approval asked", "title", msg.ToolCall.Title, "options", len(msg.Options))
	case acp.AgentEvent:
		kind := msg.Event.Type
		if msg.Event.Event != nil {
			kind += "/" + msg.Event.Event.Type
		}
		l.Debug("agent event", "kind", kind)
	case acp.Exited:
		l.Error("agent exited", "err", msg.Err, "stderr", lastLines(msg.Stderr, 3))
	default:
		l.Debug("agent message", "type", fmt.Sprintf("%T", msg))
	}
}
