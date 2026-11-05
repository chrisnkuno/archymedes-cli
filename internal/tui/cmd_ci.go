package tui

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"slices"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/chrisnkuno/friday-cli/internal/acp"
	"github.com/chrisnkuno/friday-cli/internal/project"
)

// Following CI after the person pushes. Friday never pushes or merges on its own; it notices a push
// the person made and follows that commit's CI run with gh, in the rail like a background command.
// A push is one of three things: a `git push` Friday ran with the person's approval, /push or /pr,
// or a new upstream commit for the current branch, seen by a light local poll while Friday is open
// (git's own record of the upstream, nothing fetched). On a failure Friday offers to fix it, and
// starts that turn only on a yes (/ci fix). Without gh, or outside GitHub, it says so once and
// does nothing more.

const (
	ciUpstreamEvery = 30 * time.Second // how often the upstream's commit is read, locally
	ciPollFirst     = 10 * time.Second // the first look at a pushed commit's runs, and the shortest wait
	ciPollMax       = time.Minute      // the longest wait between looks, however long the run takes
	ciNoRunPolls    = 8                // looks with no run for the commit before giving up on one
	ciErrorLimit    = 3                // gh calls failing in a row before following stops
	ciWatchLimit    = 3 * time.Hour    // the longest a commit's CI is followed
)

// ciState is CI-following for the session: how gh is reached, what the poll last saw, the watch.
type ciState struct {
	gh    ghRunner
	after func(time.Duration, tea.Msg) tea.Cmd // a timer; tests hold them
	// checked: gh was asked whether it sees this repository; why: why CI cannot be followed here,
	// said once (said).
	checked, said bool
	why           string
	// The upstream poll: running, whether it has a first reading, and the branch and commit seen.
	polling, baseline bool
	branch, upstream  string
	pushPending       bool // a git push Friday ran has landed; its commit is read after the events
	watch             *ciWatch
	seq               int
}

// ciWatch is one pushed commit's CI, as followed.
type ciWatch struct {
	seq           int
	sha, branch   string
	started       time.Time
	runs          []ciRun
	wait          time.Duration
	empty, errors int
	final         bool // every run ended
	stopped       bool // given up on, or /ci stop
	failedRun     ciRun
	failure       *ciFailure
	offered       bool // a fix is offered and not yet taken
}

func (w *ciWatch) following() bool { return w != nil && !w.final && !w.stopped }

func newCIState() ciState {
	return ciState{gh: execGh{}, after: func(d time.Duration, msg tea.Msg) tea.Cmd {
		return tea.Tick(d, func(time.Time) tea.Msg { return msg })
	}}
}

type (
	ciUpstreamTickMsg struct{}
	ciUpstreamMsg     struct {
		branch, sha string
		notRepo     bool
	}
	ciPushMsg    struct{ branch, sha string }
	ciCheckedMsg struct {
		push ciPushMsg
		err  error
	}
	ciTickMsg struct{ seq int }
	ciRunsMsg struct {
		seq  int
		runs []ciRun
		err  error
	}
	ciFailureMsg struct {
		seq     int
		run     ciRun
		failure ciFailure
	}
	ciLatestMsg struct {
		branch string
		runs   []ciRun
		err    error
	}
)

// ciMsg handles CI-following's messages; false for any other message.
func (m *Model) ciMsg(msg tea.Msg) (tea.Cmd, bool) {
	switch msg := msg.(type) {
	case ciUpstreamTickMsg:
		if m.ci.why != "" {
			m.ci.polling = false
			return nil, true
		}
		return m.readUpstream(), true
	case ciUpstreamMsg:
		return m.upstreamRead(msg), true
	case ciPushMsg:
		return m.pushSeen(msg), true
	case ciCheckedMsg:
		m.ci.checked = true
		if msg.err != nil {
			m.ciUnavailable("gh cannot see this repository on GitHub (" + msg.err.Error() + ")")
			return nil, true
		}
		return m.follow(msg.push), true
	case ciTickMsg:
		return m.ciPoll(msg), true
	case ciRunsMsg:
		return m.ciRuns(msg), true
	case ciFailureMsg:
		return m.ciFailed(msg), true
	case ciLatestMsg:
		return m.ciLatest(msg), true
	}
	return nil, false
}

// --- noticing a push ---

// ciStart starts the upstream poll, once a session and only where gh is installed.
func (m *Model) ciStart() tea.Cmd {
	if m.ci.polling || !m.ci.gh.installed() {
		return nil
	}
	m.ci.polling = true
	return m.readUpstream()
}

func (m *Model) readUpstream() tea.Cmd {
	root := m.projectRoot()
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		branch, err := project.CurrentBranch(ctx, root)
		if errors.Is(err, project.ErrNotRepository) {
			return ciUpstreamMsg{notRepo: true}
		}
		return ciUpstreamMsg{branch: branch, sha: project.Upstream(ctx, root, branch)}
	}
}

// upstreamRead compares the upstream with the last reading: a new commit on the same branch is a
// push. The first reading is a baseline, and a branch switch is not a push.
func (m *Model) upstreamRead(msg ciUpstreamMsg) tea.Cmd {
	if msg.notRepo {
		m.ci.polling = false
		return nil
	}
	var push tea.Cmd
	if m.ci.baseline && msg.sha != "" && msg.branch == m.ci.branch && msg.sha != m.ci.upstream {
		push = m.pushSeen(ciPushMsg{branch: msg.branch, sha: msg.sha})
	}
	m.ci.baseline, m.ci.branch, m.ci.upstream = true, msg.branch, msg.sha
	return tea.Batch(push, m.ci.after(ciUpstreamEvery, ciUpstreamTickMsg{}))
}

// gitPush matches a command that runs git push; a dry run pushes nothing.
var (
	gitPush    = regexp.MustCompile(`\bgit\b[^;&|\n]*?\bpush\b`)
	gitDryPush = regexp.MustCompile(`\bpush\b.*(--dry-run|\s-n\b)`)
)

// noteGitPush marks a git push Friday ran (the person approved it) that succeeded; its commit is
// read once the events are handled (ciAfterEvents).
func (m *Model) noteGitPush(tool string, args map[string]any, result string, isError bool) {
	if tool != "run_command" || isError || !isCommand(tool, args) {
		return
	}
	command := commandText(args)
	if !gitPush.MatchString(command) || gitDryPush.MatchString(command) {
		return
	}
	if strings.HasPrefix(result, "exit ") && !strings.HasPrefix(result, "exit 0") {
		return
	}
	m.ci.pushPending = true
}

// ciAfterEvents reads the commit of a push Friday ran, once.
func (m *Model) ciAfterEvents() tea.Cmd {
	if !m.ci.pushPending {
		return nil
	}
	m.ci.pushPending = false
	return m.readPush("")
}

// readPush reads the commit a push sent: the branch's upstream (HEAD's branch when none is named).
func (m *Model) readPush(branch string) tea.Cmd {
	root := m.projectRoot()
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if branch == "" {
			branch, _ = project.CurrentBranch(ctx, root)
		}
		return ciPushMsg{branch: branch, sha: project.Upstream(ctx, root, branch)}
	}
}

// pushSeen follows a pushed commit, once: after asking gh, the first time, whether it sees this
// repository on GitHub.
func (m *Model) pushSeen(push ciPushMsg) tea.Cmd {
	if push.sha == "" {
		return nil
	}
	m.ci.branch, m.ci.upstream = push.branch, push.sha // the poll knows this commit now
	if w := m.ci.watch; w != nil && w.sha == push.sha {
		return nil
	}
	if !m.ci.gh.installed() {
		m.ciUnavailable("the GitHub CLI (gh) is not installed; https://cli.github.com has it")
		return nil
	}
	if m.ci.why != "" {
		return nil
	}
	if m.ci.checked {
		return m.follow(push)
	}
	gh, root := m.ci.gh, m.projectRoot()
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		_, err := gh.run(ctx, root, "repo", "view", "--json", "nameWithOwner")
		return ciCheckedMsg{push: push, err: err}
	}
}

// ciUnavailable says once, plainly, why CI cannot be followed here, and stops the poll.
func (m *Model) ciUnavailable(why string) {
	m.ci.why = why
	if !m.ci.said {
		m.ci.said = true
		m.notice(noticeInfo, "CI is not followed: "+why)
	}
}

// --- following a commit's runs ---

// follow starts following a pushed commit; a newer push replaces the one followed before.
func (m *Model) follow(push ciPushMsg) tea.Cmd {
	m.ci.seq++
	w := &ciWatch{seq: m.ci.seq, sha: push.sha, branch: push.branch, started: time.Now(), wait: ciPollFirst}
	m.ci.watch = w
	m.notice(noticeFaint, fmt.Sprintf("Following CI for %s on %s; /ci stop stops following it", shortSHA(w.sha), w.branch))
	return m.ci.after(w.wait, ciTickMsg{w.seq})
}

// ciNextPoll is the wait after d: half as long again, between ciPollFirst and ciPollMax.
func ciNextPoll(d time.Duration) time.Duration {
	if d < ciPollFirst {
		return ciPollFirst
	}
	return min(d*3/2, ciPollMax)
}

// ciWatching is the watch a message is about, while it is still followed; nil otherwise.
func (m *Model) ciWatching(seq int) *ciWatch {
	if w := m.ci.watch; w.following() && w.seq == seq {
		return w
	}
	return nil
}

func (m *Model) ciPoll(msg ciTickMsg) tea.Cmd {
	w := m.ciWatching(msg.seq)
	if w == nil {
		return nil
	}
	if time.Since(w.started) > ciWatchLimit {
		w.stopped = true
		m.notice(noticeFaint, fmt.Sprintf("Stopped following CI for %s after %d hours; /ci shows the latest run", shortSHA(w.sha), int(ciWatchLimit/time.Hour)))
		return nil
	}
	gh, root, seq, sha := m.ci.gh, m.projectRoot(), w.seq, w.sha
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		runs, err := listRuns(ctx, gh, root, "--commit", sha, "--limit", "20")
		return ciRunsMsg{seq: seq, runs: runs, err: err}
	}
}

func (m *Model) ciRuns(msg ciRunsMsg) tea.Cmd {
	w := m.ciWatching(msg.seq)
	if w == nil {
		return nil
	}
	next := func() tea.Cmd {
		w.wait = ciNextPoll(w.wait)
		return m.ci.after(w.wait, ciTickMsg{w.seq})
	}
	switch {
	case msg.err != nil:
		if w.errors++; w.errors >= ciErrorLimit {
			w.stopped = true
			m.notice(noticeWarn, fmt.Sprintf("Stopped following CI: gh failed %d times (%s); /ci looks again", w.errors, msg.err))
			return nil
		}
		return next()
	case len(msg.runs) == 0:
		w.errors = 0
		if w.empty++; w.empty >= ciNoRunPolls {
			w.stopped = true
			m.notice(noticeFaint, fmt.Sprintf("No CI run appeared for %s; /ci looks again later", shortSHA(w.sha)))
			return nil
		}
		return next()
	}
	w.errors, w.runs = 0, msg.runs
	if slices.ContainsFunc(w.runs, func(r ciRun) bool { return !r.done() }) {
		return next()
	}
	w.final = true
	if i := slices.IndexFunc(w.runs, ciRun.failed); i >= 0 {
		gh, root, run, seq := m.ci.gh, m.projectRoot(), w.runs[i], w.seq
		return func() tea.Msg {
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			return ciFailureMsg{seq: seq, run: run, failure: readFailure(ctx, gh, root, run.ID)}
		}
	}
	var names []string
	passed := true
	for _, r := range w.runs {
		names = append(names, r.Workflow+" "+r.state())
		passed = passed && r.state() == "passed"
	}
	if !passed {
		m.notice(noticeFaint, fmt.Sprintf("CI ended without passing: %s · %s; /ci shows the latest run", strings.Join(names, ", "), shortSHA(w.sha)))
		return nil
	}
	m.notice(noticeFaint, fmt.Sprintf("CI passed: %s · %s", strings.Join(names, ", "), shortSHA(w.sha)))
	m.notify("CI passed in "+m.projectName(), "CI passed in "+m.projectName())
	return nil // ciMsg sends the notification
}

// ciFailed offers the fix: a line in the conversation, /ci fix first among the next steps, and a
// notification when the person looks elsewhere. Nothing is sent until they say yes.
func (m *Model) ciFailed(msg ciFailureMsg) tea.Cmd {
	w := m.ci.watch
	if w == nil || w.seq != msg.seq || w.stopped {
		return nil
	}
	f := msg.failure
	w.failedRun, w.failure, w.offered = msg.run, &f, true
	job := firstNonEmpty(f.job, msg.run.Workflow)
	if f.step != "" {
		m.notice(noticeWarn, fmt.Sprintf("CI failed: %s · %s. Fix it? /ci fix sends the failed job's log to Friday; tab puts it in the input", job, f.step))
	} else {
		m.notice(noticeWarn, fmt.Sprintf("CI failed: %s. Fix it? /ci fix sends the failed job's log to Friday; tab puts it in the input", job))
	}
	if m.phase != busy {
		m.nextSteps = append([]acp.Suggestion{{Text: "/ci fix", Why: "send the failed CI log to Friday", Source: "ci"}}, m.nextSteps...)
	}
	m.notify("CI failed in "+m.projectName()+": "+job, "CI failed in "+m.projectName())
	return nil // ciMsg sends the notification
}
