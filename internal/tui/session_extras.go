package tui

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
)

// The small session commands that need nothing from the agent but the transcript already on screen.

// lastUserMessage is the newest thing the person sent, for /retry.
func (m *Model) lastUserMessage() string {
	for i := len(m.tr.items) - 1; i >= 0; i-- {
		if u, ok := m.tr.items[i].(*userItem); ok {
			return u.text
		}
	}
	return ""
}

func (m *Model) cmdRetry(string) tea.Cmd {
	if m.phase == busy {
		return m.toast(toastWarn, "A turn is running; esc stops it, then /retry")
	}
	text := m.lastUserMessage()
	if text == "" {
		return m.toast(toastWarn, "Nothing to retry yet")
	}
	return m.sendPrompt(text)
}

func (m *Model) cmdContinue(string) tea.Cmd {
	if m.phase == busy {
		return m.toast(toastWarn, "A turn is running already")
	}
	return m.sendPrompt("Continue from where you stopped.")
}

// transcriptMarkdown is the session as a Markdown document: what was asked, what was said, and
// which tools ran (with whether they failed), in order.
func (m *Model) transcriptMarkdown() string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Archymedes session %s\n\n", m.session.ID)
	fmt.Fprintf(&b, "- Model: %s\n- Mode: %s\n- Project: %s\n- Exported: %s\n\n", m.session.Info.Model, m.mode, m.projectRoot(), time.Now().Format(time.RFC3339))
	for _, it := range m.tr.items {
		switch v := it.(type) {
		case *userItem:
			fmt.Fprintf(&b, "## You\n\n%s\n\n", v.text)
		case *assistantItem:
			if text := strings.TrimSpace(v.text.String()); text != "" {
				fmt.Fprintf(&b, "## Archymedes\n\n%s\n\n", text)
			}
		case *toolItem:
			status := "ok"
			if v.isError {
				status = "failed"
			} else if !v.done {
				status = "no result"
			}
			fmt.Fprintf(&b, "- tool `%s`: %s\n\n", v.name, status)
		}
	}
	return b.String()
}

// cmdExport writes the transcript into the project (or to the path given) and says where.
func (m *Model) cmdExport(arg string) tea.Cmd {
	if len(m.tr.items) == 0 {
		return m.toast(toastWarn, "Nothing to export yet")
	}
	name := strings.TrimSpace(arg)
	if name == "" {
		name = fmt.Sprintf("archymedes-session-%s.md", time.Now().Format("20060102-150405"))
	}
	path := name
	if !filepath.IsAbs(path) {
		path = filepath.Join(m.projectRoot(), name)
	}
	// Never over an existing file: "/export README.md" must not replace the project's README.
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if errors.Is(err, os.ErrExist) {
		return m.toast(toastWarn, path+" already exists; /export <another name>")
	}
	if err != nil {
		return m.toast(toastWarn, "Could not write "+path+": "+err.Error())
	}
	_, err = file.WriteString(m.transcriptMarkdown())
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return m.toast(toastWarn, "Could not write "+path+": "+err.Error())
	}
	return m.toast(toastInfo, "Exported to "+path)
}

// cmdWhere answers "which session, model and folder is this?" without leaving the chat.
func (m *Model) cmdWhere(string) tea.Cmd {
	return m.toast(toastInfo, fmt.Sprintf("%s · %s/%s · %s mode · session %s", m.projectRoot(), m.session.Info.Provider, m.session.Info.Model, m.mode, m.session.ID))
}

type editedMsg struct {
	path string
	err  error
}

// cmdEdit writes the composer's text to a file, opens $VISUAL/$EDITOR on it, and puts the result
// back — the way to write a long prompt with a real editor.
func (m *Model) cmdEdit(string) tea.Cmd {
	editor := firstNonEmpty(os.Getenv("VISUAL"), os.Getenv("EDITOR"))
	if editor == "" {
		return m.toast(toastWarn, "Set $EDITOR (or $VISUAL) to use /edit")
	}
	file, err := os.CreateTemp("", "archymedes-prompt-*.md")
	if err != nil {
		return m.toast(toastWarn, "Could not create a temp file: "+err.Error())
	}
	_, _ = file.WriteString(m.input.value())
	_ = file.Close()
	parts := strings.Fields(editor)
	cmd := exec.Command(parts[0], append(parts[1:], file.Name())...)
	return tea.ExecProcess(cmd, func(err error) tea.Msg { return editedMsg{path: file.Name(), err: err} })
}

func (m *Model) edited(msg editedMsg) tea.Cmd {
	defer os.Remove(msg.path)
	if msg.err != nil {
		return m.toast(toastWarn, "The editor failed: "+msg.err.Error())
	}
	raw, err := os.ReadFile(msg.path)
	if err != nil {
		return m.toast(toastWarn, "Could not read the edited prompt: "+err.Error())
	}
	m.input.area.SetValue(strings.TrimRight(string(raw), "\n"))
	m.input.area.MoveToEnd()
	m.input.refreshCompletions()
	return nil
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}
