package tui

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"time"

	"github.com/charmbracelet/x/ansi"
)

// What CI-following needs from the GitHub CLI, behind one small interface so the tests can give a
// fake: whether gh is there, and a gh command's output. Everything else here is reading that
// output: the runs of a commit, the failing job and step, and the failed job's log, trimmed.

// ghRunner runs the GitHub CLI.
type ghRunner interface {
	installed() bool
	run(ctx context.Context, dir string, args ...string) ([]byte, error)
}

// execGh is the real gh on PATH.
type execGh struct{}

func (execGh) installed() bool {
	_, err := exec.LookPath("gh")
	return err == nil
}

func (execGh) run(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "gh", args...)
	cmd.Dir = dir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		if line := firstLine(stderr.String()); line != "" {
			return out, errors.New(line)
		}
	}
	return out, err
}

// ciRunFields are the fields asked of gh for a run.
const ciRunFields = "databaseId,workflowName,status,conclusion,url,createdAt,updatedAt"

// ciRun is one workflow run, as gh reports it.
type ciRun struct {
	ID         int64     `json:"databaseId"`
	Workflow   string    `json:"workflowName"`
	Status     string    `json:"status"`     // queued, in_progress, waiting, completed…
	Conclusion string    `json:"conclusion"` // once completed: success, failure, cancelled…
	URL        string    `json:"url"`
	Created    time.Time `json:"createdAt"`
	Updated    time.Time `json:"updatedAt"`
}

func (r ciRun) done() bool { return r.Status == "completed" }

// failed is a completed run that did not pass: a failure, a timeout, or one that could not start.
func (r ciRun) failed() bool {
	return r.done() && (r.Conclusion == "failure" || r.Conclusion == "timed_out" || r.Conclusion == "startup_failure")
}

// state is the run's status in words: queued, in progress, passed, failed, cancelled…
func (r ciRun) state() string {
	switch {
	case r.failed():
		return "failed"
	case r.done() && (r.Conclusion == "success" || r.Conclusion == "skipped" || r.Conclusion == "neutral"):
		return "passed"
	case r.done() && r.Conclusion != "":
		return strings.ReplaceAll(r.Conclusion, "_", " ")
	case r.done():
		return "done"
	}
	return strings.ReplaceAll(r.Status, "_", " ")
}

// took is how long the run has run: to its last update once done, to now before.
func (r ciRun) took(now time.Time) time.Duration {
	if r.Created.IsZero() {
		return 0
	}
	end := now
	if r.done() && !r.Updated.IsZero() {
		end = r.Updated
	}
	return max(end.Sub(r.Created), 0)
}

// listRuns asks gh for runs: of a commit (--commit sha) or a branch's latest (--branch b --limit 1).
func listRuns(ctx context.Context, gh ghRunner, dir string, args ...string) ([]ciRun, error) {
	out, err := gh.run(ctx, dir, append(append([]string{"run", "list"}, args...), "--json", ciRunFields)...)
	if err != nil {
		return nil, err
	}
	var runs []ciRun
	if err := json.Unmarshal(out, &runs); err != nil {
		return nil, fmt.Errorf("gh run list answered something unreadable: %w", err)
	}
	return runs, nil
}

// ciFailure is what failed in a run, and the failed job's log, trimmed.
type ciFailure struct {
	job, step, log string
}

// readFailure asks gh which job and step failed, and for the failed jobs' log.
func readFailure(ctx context.Context, gh ghRunner, dir string, id int64) ciFailure {
	run := fmt.Sprint(id)
	var f ciFailure
	if out, err := gh.run(ctx, dir, "run", "view", run, "--json", "jobs"); err == nil {
		f.job, f.step = firstFailing(out)
	}
	if out, err := gh.run(ctx, dir, "run", "view", run, "--log-failed"); err == nil {
		f.log = trimCILog(string(out))
	}
	return f
}

// firstFailing is the first job that failed and its first failing step, from `gh run view --json jobs`.
func firstFailing(out []byte) (job, step string) {
	var view struct {
		Jobs []struct {
			Name       string `json:"name"`
			Conclusion string `json:"conclusion"`
			Steps      []struct {
				Name       string `json:"name"`
				Conclusion string `json:"conclusion"`
			} `json:"steps"`
		} `json:"jobs"`
	}
	if json.Unmarshal(out, &view) != nil {
		return "", ""
	}
	for _, j := range view.Jobs {
		if j.Conclusion != "failure" && j.Conclusion != "timed_out" {
			continue
		}
		for _, s := range j.Steps {
			if s.Conclusion == "failure" || s.Conclusion == "timed_out" {
				return j.Name, s.Name
			}
		}
		return j.Name, ""
	}
	return "", ""
}

// The failed log is kept to its end, where the error usually is: at most ciLogLines lines and
// ciLogBytes bytes, so a turn starts with the failure and not with the whole build.
const (
	ciLogLines = 80
	ciLogBytes = 8000
)

// ghLogStamp is the timestamp gh puts before each line of a job's log.
var ghLogStamp = regexp.MustCompile(`^\x{feff}?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z ?`)

// trimCILog is gh's failed log as plain lines: without its job and step columns, timestamps and
// colours, only the last ciLogLines lines, within ciLogBytes; "…" first when anything was cut.
func trimCILog(raw string) string {
	var lines []string
	for _, line := range strings.Split(strings.TrimRight(raw, "\n"), "\n") {
		if parts := strings.SplitN(line, "\t", 3); len(parts) == 3 {
			line = parts[2]
		}
		line = ghLogStamp.ReplaceAllString(ansi.Strip(strings.TrimRight(line, "\r")), "")
		lines = append(lines, line)
	}
	cut := false
	if len(lines) > ciLogLines {
		lines, cut = lines[len(lines)-ciLogLines:], true
	}
	// The most lines from the end that fit; a last line too long alone keeps its end.
	start, size := len(lines), 0
	for start > 0 && size+len(lines[start-1])+1 <= ciLogBytes {
		start--
		size += len(lines[start]) + 1
	}
	if start > 0 {
		cut = true
	}
	text := strings.Join(lines[start:], "\n")
	if start == len(lines) && len(lines) > 0 {
		last := lines[len(lines)-1]
		text = strings.ToValidUTF8(last[len(last)-ciLogBytes:], "")
	}
	if cut {
		text = "…\n" + text
	}
	return text
}

// ciFixPrompt is the turn a yes starts: what failed, where, and the log, with the one rule that
// matters: Friday fixes it here and does not push.
func ciFixPrompt(w *ciWatch, run ciRun, f ciFailure) string {
	var b strings.Builder
	fmt.Fprintf(&b, "CI failed on `%s` at %s: workflow %q", w.branch, shortSHA(w.sha), run.Workflow)
	if f.job != "" {
		fmt.Fprintf(&b, ", job %q", f.job)
	}
	if f.step != "" {
		fmt.Fprintf(&b, ", step %q", f.step)
	}
	if run.URL != "" {
		fmt.Fprintf(&b, " (%s)", run.URL)
	}
	b.WriteString(". Find the cause and fix it here, then run the failing check locally to show it passes. Do not push, commit or switch branches: I push when I have looked at the fix.")
	if f.log != "" {
		b.WriteString("\n\nThe failed job's log, trimmed to its end:\n```\n" + f.log + "\n```")
	} else {
		fmt.Fprintf(&b, "\n\nThe log could not be read here; `gh run view %d --log-failed` shows it.", run.ID)
	}
	return b.String()
}

func shortSHA(sha string) string { return sha[:min(len(sha), 7)] }
