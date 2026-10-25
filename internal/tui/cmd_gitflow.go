package tui

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"github.com/charmbracelet/x/ansi"

	"github.com/chrisnkuno/friday-cli/internal/project"
)

// /push and /pr: the branch goes to the remote, and /pr then has the agent write the pull request
// (title and body from the commits) and open it with the GitHub CLI. The git steps are done here,
// not by the agent, so the one rule that matters is kept every time: pushing the default branch is
// never silent — on it, the person is offered a new branch first (T3 Code asks the same).

type pushPlanMsg struct {
	intent, guidance              string // "push" or "pr"
	branch, defaultBranch, remote string
	uncommitted                   int
	err                           error
}

type pushedMsg struct {
	intent, guidance, branch, defaultBranch, remote string
	uncommitted                                     int
	err                                             error
}

func (m *Model) cmdPush(arg string) tea.Cmd { return m.planPush("push", arg) }

func (m *Model) cmdPR(arg string) tea.Cmd {
	if _, err := exec.LookPath("gh"); err != nil {
		return m.toast(toastWarn, "/pr needs the GitHub CLI (gh): https://cli.github.com")
	}
	return m.planPush("pr", arg)
}

func (m *Model) planPush(intent, guidance string) tea.Cmd {
	if m.phase == busy {
		return m.toast(toastWarn, "/"+intent+" between turns; esc stops this one")
	}
	root := m.projectRoot()
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		branch, err := project.CurrentBranch(ctx, root)
		if err != nil {
			return pushPlanMsg{intent: intent, err: err}
		}
		changes, _ := project.Changes(ctx, root)
		return pushPlanMsg{intent: intent, guidance: strings.TrimSpace(guidance), branch: branch, defaultBranch: project.DefaultBranch(ctx, root), remote: project.PushRemote(ctx, root), uncommitted: len(changes)}
	}
}

func (m *Model) pushPlanned(msg pushPlanMsg) tea.Cmd {
	switch {
	case msg.err == project.ErrNotRepository:
		return m.toast(toastWarn, "/"+msg.intent+": this folder is not a git repository")
	case msg.err != nil:
		return m.toast(toastWarn, "/"+msg.intent+": "+msg.err.Error())
	case msg.remote == "":
		return m.toast(toastWarn, "Nowhere to push: this repository has no remote (git remote add origin <url>)")
	case msg.branch == "":
		return m.toast(toastWarn, "HEAD is not on a branch: switch to one (or create one) first")
	case msg.branch == msg.defaultBranch:
		m.openOverlay(newDefaultBranchGuard(m, msg))
		return nil
	}
	return m.push(msg, "")
}

// push pushes msg.branch, after creating newBranch from HEAD when one is given.
func (m *Model) push(plan pushPlanMsg, newBranch string) tea.Cmd {
	root := m.projectRoot()
	return tea.Batch(m.toast(toastInfo, "Pushing…"), func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		branch := plan.branch
		if newBranch != "" {
			if err := project.NewBranch(ctx, root, newBranch); err != nil {
				return pushedMsg{intent: plan.intent, err: err}
			}
			branch = newBranch
		}
		remote, err := project.Push(ctx, root, branch)
		return pushedMsg{plan.intent, plan.guidance, branch, plan.defaultBranch, remote, plan.uncommitted, err}
	})
}

func (m *Model) pushed(msg pushedMsg) tea.Cmd {
	if msg.err != nil {
		m.notice(noticeError, "Push failed: "+msg.err.Error())
		return nil
	}
	text := fmt.Sprintf("Pushed %s to %s.", msg.branch, msg.remote)
	if msg.uncommitted > 0 {
		text += fmt.Sprintf(" %s uncommitted, so not pushed: /commit first.", plural(msg.uncommitted, "change"))
	}
	m.notice(noticeInfo, text)
	if c := m.changesWindow(); c != nil {
		c.br.loaded = false // the branch's upstream changed
	}
	if msg.intent != "pr" {
		return nil
	}
	return m.sendPrompt(prPrompt(msg.branch, msg.defaultBranch, msg.guidance))
}

func prPrompt(branch, base, guidance string) string {
	if base == "" {
		base = "the repository's default branch"
	}
	prompt := fmt.Sprintf("Open a pull request from `%s` into `%s` with the GitHub CLI. Read the commits (`git log %s..%s`) and the diff first; write a short title and a body saying what changed, why, and how it was tested; then run `gh pr create --base %s --head %s --title … --body …`. The branch is already pushed: do not push, commit or switch branches. Report the pull request's URL.", branch, base, base, branch, base, branch)
	if guidance != "" {
		prompt += " Guidance from me: " + guidance
	}
	return prompt
}

// --- on the default branch: a new branch first, or this one knowingly ---

type defaultBranchGuard struct {
	plan   pushPlanMsg
	cursor int // 0 new branch, 1 push the default branch, 2 cancel
	name   textinput.Model
}

func newDefaultBranchGuard(m *Model, plan pushPlanMsg) *defaultBranchGuard {
	in := textinput.New()
	in.Prompt = ""
	in.SetValue("archy/" + branchSlug(m.lastUserMessage(), time.Now()))
	s := textinput.DefaultStyles(!m.th.Light)
	s.Focused.Text, s.Blurred.Text = m.th.Body, m.th.Faint
	in.SetStyles(s)
	in.Focus()
	return &defaultBranchGuard{plan: plan, name: in}
}

func (g *defaultBranchGuard) handle(m *Model, msg tea.KeyPressMsg) (bool, tea.Cmd) {
	switch msg.String() {
	case "esc", "ctrl+c":
		return true, nil
	case "up", "shift+tab":
		g.cursor = (g.cursor + 2) % 3
	case "down", "tab":
		g.cursor = (g.cursor + 1) % 3
	case "enter":
		switch g.cursor {
		case 0:
			name := strings.TrimSpace(g.name.Value())
			if name == "" || strings.HasPrefix(name, "-") || strings.ContainsAny(name, " ~^:?*[\\") {
				return false, m.toast(toastWarn, "Not a branch name: "+name)
			}
			return true, m.push(g.plan, name)
		case 1:
			return true, m.push(g.plan, "")
		}
		return true, nil
	default:
		if g.cursor == 0 {
			var cmd tea.Cmd
			g.name, cmd = g.name.Update(msg)
			return false, cmd
		}
	}
	return false, nil
}

// rowCount and choose make the three choices clickable: a click picks one, a second click on it goes.
func (g *defaultBranchGuard) rowCount() int { return 3 }
func (g *defaultBranchGuard) choose(m *Model, i int) tea.Cmd {
	if g.cursor != i {
		g.cursor = i
		return nil
	}
	closed, cmd := g.handle(m, keyPress("enter"))
	if closed && m.overlay == g {
		m.overlay = nil
	}
	return cmd
}

func (g *defaultBranchGuard) view(m *Model) string {
	th := m.th
	width := overlayWidth(m, 72)
	inner := max(width-4, 8)
	g.name.SetWidth(max(inner-16, 4))
	row := func(i int, text string) string {
		if i == g.cursor {
			text = selectedBar(m, padRight("› "+ansi.Strip(text), inner))
		} else {
			text = "  " + text
		}
		return mark(m.zones.dialog, rowID(i), text)
	}
	verb := "Push"
	if g.plan.intent == "pr" {
		verb = "Open a pull request from"
	}
	body := th.Body.Render(ansi.Wrap(fmt.Sprintf("This is %s, the default branch. %s a new branch instead?", g.plan.branch, verb), inner, "")) + "\n\n" +
		row(0, "New branch: ") + g.name.View() + "\n" +
		row(1, "Push "+g.plan.branch+" itself") + "\n" +
		row(2, "Cancel") + "\n\n" +
		m.dialogHintBar(inner, button{"enter", "go"}, button{"esc", "cancel"})
	return frame(th, "On the default branch", body, width)
}

// branchSlug is a branch name from what was asked: its first few words, or a dated one.
func branchSlug(text string, now time.Time) string {
	words := strings.Fields(text)
	return project.WorktreeName(strings.Join(words[:min(len(words), 5)], " "), now)
}
