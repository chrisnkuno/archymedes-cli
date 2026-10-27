package tui

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/config"
)

// Notifications: Friday says when it needs the person, when they are looking elsewhere. A turn
// that ended, an approval or a question waiting: the terminal's own notification (or its bell),
// and, when a push URL is set, one line to it, so a phone hears too. Only what happened and the
// project's folder name leave this computer, never the conversation.

// notifier holds whether the terminal has focus and the notifications waiting to be sent.
type notifier struct {
	// blurred is set only when the terminal said it lost focus: a terminal that never reports
	// focus is taken to be looked at, so "auto" never interrupts anyone it cannot see.
	blurred bool
	pending []tea.Cmd
	// failed is set once the push URL refused, so the notice is shown once a session.
	failed bool
}

// notifyFailedMsg is the push URL refusing a notification.
type notifyFailedMsg struct{ err string }

// notifyMode is ARCHYMEDES_NOTIFY: auto (only when the terminal is not focused), always or off.
func (m *Model) notifyMode() string {
	mode := strings.ToLower(strings.TrimSpace(firstNonEmpty(os.Getenv("ARCHYMEDES_NOTIFY"), config.Setting(m.opts.ConfigDir, "ARCHYMEDES_NOTIFY"))))
	if mode != "always" && mode != "off" {
		mode = "auto"
	}
	return mode
}

// notify queues a notification. local is what the terminal shows; push is the line for the push
// URL, which names no command, file or reply.
func (m *Model) notify(local, push string) {
	switch m.notifyMode() {
	case "off":
		return
	case "auto":
		if !m.notifier.blurred {
			return
		}
	}
	m.notifier.pending = append(m.notifier.pending, tea.Raw(notificationSequence(os.Getenv, local)))
	if url := strings.TrimSpace(firstNonEmpty(os.Getenv("ARCHYMEDES_NOTIFY_URL"), config.Setting(m.opts.ConfigDir, "ARCHYMEDES_NOTIFY_URL"))); url != "" {
		m.notifier.pending = append(m.notifier.pending, pushNotification(url, push))
	}
}

// flushNotifications hands over the notifications queued since the last message.
func (m *Model) flushNotifications() tea.Cmd {
	if len(m.notifier.pending) == 0 {
		return nil
	}
	cmds := m.notifier.pending
	m.notifier.pending = nil
	return tea.Batch(cmds...)
}

// projectName is the project's folder name, which is all a notification says of where.
func (m *Model) projectName() string {
	where := firstNonEmpty(m.session.Info.Root, m.opts.Cwd)
	if name := filepath.Base(where); where != "" && name != "." && name != string(filepath.Separator) {
		return name
	}
	return "your project"
}

// notifyTurnEnded says a turn is over, unless the person stopped it themselves.
func (m *Model) notifyTurnEnded(msg promptDoneMsg) {
	switch {
	case msg.stop == "cancelled":
		return
	case msg.err != nil:
		m.notify("Friday stopped in "+m.projectName()+": "+msg.err.Error(), "Friday stopped in "+m.projectName())
	default:
		m.notify("Friday finished in "+m.projectName(), "Friday finished in "+m.projectName())
	}
}

// notifyWaiting says an approval or a question is waiting for the person.
func (m *Model) notifyWaiting(a *approval) {
	if a.ask != nil {
		m.notify("Friday has a question in "+m.projectName()+": "+a.ask.Question, "Friday has a question in "+m.projectName())
		return
	}
	m.notify("Friday needs your approval in "+m.projectName()+": "+a.req.ToolCall.Title, "Friday needs your approval in "+m.projectName())
}

// notificationSequence is how this terminal shows a notification: its own escape where it has
// one (iTerm2, WezTerm and Ghostty read OSC 9, kitty OSC 99, foot and rxvt OSC 777), else the bell,
// which every terminal turns into something (a sound, a flash, a mark on the tab). Inside tmux the
// bell, which tmux passes on as activity. Never two, so no terminal shows it twice.
func notificationSequence(getenv func(string) string, text string) string {
	text = notificationText(text)
	program := getenv("TERM_PROGRAM")
	term := getenv("TERM")
	switch {
	case getenv("TMUX") != "":
		return "\a"
	case program == "iTerm.app" || program == "WezTerm" || program == "ghostty":
		return "\x1b]9;" + text + "\a"
	case getenv("KITTY_WINDOW_ID") != "" || term == "xterm-kitty":
		return "\x1b]99;;" + text + "\x1b\\"
	case strings.HasPrefix(term, "foot") || strings.HasPrefix(term, "rxvt"):
		return "\x1b]777;notify;Friday;" + strings.ReplaceAll(text, ";", ",") + "\a"
	}
	return "\a"
}

// notificationText is one short line with nothing a terminal could read as a control.
func notificationText(text string) string {
	text = strings.Map(func(r rune) rune {
		if r < 0x20 || r == 0x7f || (r >= 0x80 && r < 0xa0) {
			return ' '
		}
		return r
	}, text)
	text = strings.Join(strings.Fields(text), " ")
	if r := []rune(text); len(r) > 120 {
		text = string(r[:119]) + "…"
	}
	return text
}

// pushNotification posts the line to an ntfy-style URL (the body is the message, Title the title).
func pushNotification(url, text string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(notificationText(text)))
		if err != nil {
			return notifyFailedMsg{err: err.Error()}
		}
		req.Header.Set("Title", "Friday")
		req.Header.Set("Content-Type", "text/plain; charset=utf-8")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			return notifyFailedMsg{err: err.Error()}
		}
		resp.Body.Close()
		if resp.StatusCode >= 300 {
			return notifyFailedMsg{err: resp.Status}
		}
		return nil
	}
}
