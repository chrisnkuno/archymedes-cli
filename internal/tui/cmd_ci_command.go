package tui

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/project"
)

// /ci: the latest run of the branch, or the one followed after a push (cmd_ci.go); stop following
// it; or say yes to the fix offered for a failure.

func (m *Model) cmdCI(arg string) tea.Cmd {
	w := m.ci.watch
	switch strings.ToLower(arg) {
	case "fix":
		if w == nil || !w.offered || w.failure == nil {
			return m.toast(toastWarn, "No CI failure to fix; /ci shows the latest run")
		}
		w.offered = false
		m.nextSteps = slices.DeleteFunc(m.nextSteps, func(s acp.Suggestion) bool { return s.Text == "/ci fix" })
		return m.sendPrompt(ciFixPrompt(w, w.failedRun, *w.failure))
	case "stop":
		if !w.following() {
			return m.toast(toastWarn, "Not following any CI run; /ci shows the latest one")
		}
		w.stopped = true
		return m.toast(toastInfo, "Stopped following CI for "+shortSHA(w.sha))
	case "":
	default:
		return m.toast(toastWarn, "/ci takes stop or fix; /ci alone shows the latest run")
	}
	if w.following() {
		m.notice(noticeInfo, ciSummary(w, time.Now()))
		return nil
	}
	if !m.ci.gh.installed() {
		return m.toast(toastWarn, "/ci needs the GitHub CLI (gh): https://cli.github.com")
	}
	gh, root := m.ci.gh, m.projectRoot()
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		branch, err := project.CurrentBranch(ctx, root)
		if err != nil || branch == "" {
			return ciLatestMsg{err: errors.New("HEAD is not on a branch here")}
		}
		runs, err := listRuns(ctx, gh, root, "--branch", branch, "--limit", "1")
		return ciLatestMsg{branch: branch, runs: runs, err: err}
	}
}

func (m *Model) ciLatest(msg ciLatestMsg) tea.Cmd {
	switch {
	case msg.err != nil:
		return m.toast(toastWarn, "/ci: "+msg.err.Error())
	case len(msg.runs) == 0:
		m.notice(noticeInfo, fmt.Sprintf("No CI runs for %s yet", msg.branch))
		return nil
	}
	r := msg.runs[0]
	m.notice(noticeInfo, fmt.Sprintf("Latest CI on %s: %s · %s · %s · %s", msg.branch, r.Workflow, r.state(), elapsed(r.took(time.Now())), r.URL))
	return nil
}

// ciSummary is the followed commit's CI in one line.
func ciSummary(w *ciWatch, now time.Time) string {
	head := fmt.Sprintf("CI for %s on %s: ", shortSHA(w.sha), w.branch)
	if len(w.runs) == 0 {
		return head + "waiting for a run to appear"
	}
	var parts []string
	for _, r := range w.runs {
		parts = append(parts, r.Workflow+" · "+r.state()+" · "+elapsed(r.took(now)))
	}
	return head + strings.Join(parts, "; ")
}
