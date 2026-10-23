package tools

import (
	"context"
	"embed"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/chrisnkuno/friday-cli/internal/core/tool"
)

// Defender mode's tools: the security playbooks (read_playbook) and the secret scan
// (scan_secrets), as in the TypeScript agent (defender-playbooks.ts, secret-scan.ts).

// The playbooks are written from the TypeScript catalog by tooling/build/export-playbooks.ts, one
// file each in the catalog's order; a test there fails when the two differ.
//
//go:embed playbooks/*.md
var playbookFS embed.FS

// Playbook is one security playbook: its id (from its title), title and full text.
type Playbook struct {
	ID, Title, Text string
}

var nonWord = regexp.MustCompile(`[^a-z0-9]+`)

// Playbooks are every playbook, in the order defender mode should generally work them.
var Playbooks = sync.OnceValue(func() []Playbook {
	entries, _ := playbookFS.ReadDir("playbooks")
	var out []Playbook
	for _, e := range entries {
		data, _ := playbookFS.ReadFile(path.Join("playbooks", e.Name()))
		text := strings.TrimSpace(string(data))
		first, _, _ := strings.Cut(text, "\n")
		title := strings.TrimSpace(strings.TrimLeft(first, "#"))
		id := strings.Trim(nonWord.ReplaceAllString(strings.ToLower(title), "-"), "-")
		out = append(out, Playbook{ID: id, Title: title, Text: text})
	}
	return out
})

// PlaybookIndex is the list that goes in defender mode's prompt: the ids read_playbook takes.
func PlaybookIndex() string {
	var lines []string
	for _, p := range Playbooks() {
		lines = append(lines, "- "+p.ID+" — "+p.Title)
	}
	return strings.Join(lines, "\n")
}

func playbookFor(id string) (Playbook, bool) {
	wanted := strings.ToLower(strings.TrimSpace(id))
	for _, p := range Playbooks() {
		if p.ID == wanted || strings.ToLower(p.Title) == wanted {
			return p, true
		}
	}
	return Playbook{}, false
}

func (w *Workspace) readPlaybook() *tool.Tool {
	return &tool.Tool{
		Name:        "read_playbook",
		Description: "Read one security playbook in full, by id from the index in your instructions. Pull the two or three categories this project actually has a surface for, rather than reciting all of them.",
		Schema:      tool.ObjectSchema(map[string]any{"id": map[string]any{"type": "string"}}, "id"),
		Capability:  tool.CapPlaybooks, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(_ context.Context, _ tool.Context, args tool.Args) tool.Result {
			id := tool.StringArg(args, "id")
			if strings.TrimSpace(id) == "" {
				return tool.Error("`id` is required")
			}
			p, ok := playbookFor(id)
			if !ok {
				var ids []string
				for _, p := range Playbooks() {
					ids = append(ids, p.ID)
				}
				return tool.Error(fmt.Sprintf("No playbook %q. Available: %s", id, strings.Join(ids, ", ")))
			}
			return tool.Result{Content: p.Text, Data: map[string]any{"id": p.ID, "title": p.Title}}
		},
	}
}

// secretPattern is one recognizable secret shape. Severity is how bad it is if the match is
// real: critical grants something broad or irreversible alone, high one service or account,
// medium is a shape that is often a false positive.
type secretPattern struct {
	name, severity string
	re             *regexp.Regexp
}

// secretPatterns are SECRET_PATTERNS in secret-scan.ts, in the same order.
var secretPatterns = []secretPattern{
	{"AWS access key", "critical", regexp.MustCompile(`AKIA[0-9A-Z]{16}`)},
	{"GitHub token", "critical", regexp.MustCompile(`gh[pousr]_[A-Za-z0-9]{36,255}`)},
	{"Google API key", "high", regexp.MustCompile(`AIza[0-9A-Za-z_-]{35}`)},
	{"Slack token", "high", regexp.MustCompile(`xox[baprs]-[0-9A-Za-z-]{10,}`)},
	{"Stripe key", "critical", regexp.MustCompile(`(?:sk|pk)_(?:live|test)_[0-9A-Za-z]{16,}`)},
	{"Anthropic/OpenAI-style API key", "high", regexp.MustCompile(`sk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`)},
	{"Private key block", "critical", regexp.MustCompile(`-----BEGIN (?:RSA |EC |OPENSSH |PGP |DSA )?PRIVATE KEY-----`)},
	{"JSON Web Token", "medium", regexp.MustCompile(`eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`)},
	{"credential-looking assignment", "medium", regexp.MustCompile(`(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"][A-Za-z0-9\-_.]{16,}['"]`)},
	{"credential-looking assignment", "medium", regexp.MustCompile(`(?:API[_-]?KEY|SECRET|PASSWORD|PASSWD|TOKEN)\s*[:=]\s*['"][A-Za-z0-9\-_.]{16,}['"]`)},
}

var severityRank = map[string]int{"critical": 0, "high": 1, "medium": 2}

// combinedSecrets is every pattern in one, so a scan is one search of the tree.
var combinedSecrets = func() string {
	var parts []string
	for _, p := range secretPatterns {
		parts = append(parts, "(?:"+p.re.String()+")")
	}
	return strings.Join(parts, "|")
}()

// maskSecret keeps the first and last four characters, enough to tell which secret to rotate,
// so the scan's output never becomes a new place the secret is written in full.
func maskSecret(value string) string {
	value = strings.TrimSpace(value)
	if len(value) <= 10 {
		return "[redacted]"
	}
	return fmt.Sprintf("%s…%s (%d chars)", value[:4], value[len(value)-4:], len(value))
}

// SecretFinding is one likely secret, masked, where it was found.
type SecretFinding struct {
	Path     string `json:"path"`
	Line     int    `json:"line"`
	Kind     string `json:"kind"`
	Masked   string `json:"masked"`
	Severity string `json:"severity"`
}

// secretsInLine is every pattern that matches one line, each masked.
func secretsInLine(text string) []SecretFinding {
	var out []SecretFinding
	for _, p := range secretPatterns {
		if m := p.re.FindString(text); m != "" {
			out = append(out, SecretFinding{Kind: p.name, Masked: maskSecret(m), Severity: p.severity})
		}
	}
	return out
}

// secretScanMax is how many matching lines a scan reads.
const secretScanMax = 2000

// ScanSecrets finds likely secrets under the workspace, worst first.
func (w *Workspace) ScanSecrets(ctx context.Context, include string) ([]SecretFinding, error) {
	lines, err := w.grep(ctx, w.Root, grepQuery{query: combinedSecrets, include: include, output: "content", regex: true, limit: secretScanMax})
	if err != nil {
		return nil, err
	}
	var out []SecretFinding
	for _, line := range lines {
		// path:line:text, as grep prints a match.
		file, rest, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		num, text, ok := strings.Cut(rest, ":")
		n, err := strconv.Atoi(num)
		if !ok || err != nil {
			continue
		}
		for _, f := range secretsInLine(text) {
			f.Path, f.Line = file, n
			out = append(out, f)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return severityRank[out[i].Severity] < severityRank[out[j].Severity] })
	return out, nil
}

func (w *Workspace) scanSecrets() *tool.Tool {
	return &tool.Tool{
		Name:        "scan_secrets",
		Description: "Scan files for likely hardcoded credentials (keys, tokens, passwords). Values are masked in the output.",
		Schema: tool.ObjectSchema(map[string]any{
			"include": map[string]any{"type": "string", "description": "Glob limiting which files are scanned, e.g. 'src/**'."},
		}),
		Capability: tool.CapRead, Effect: tool.EffectNone, ParallelSafe: true,
		Run: func(ctx context.Context, _ tool.Context, args tool.Args) tool.Result {
			findings, err := w.ScanSecrets(ctx, tool.StringArg(args, "include"))
			if err != nil {
				return tool.Error(err.Error())
			}
			if len(findings) == 0 {
				return tool.Result{Content: "No likely secrets found by pattern in the scanned files.", Data: map[string]any{"findings": []SecretFinding{}}}
			}
			rows := make([]string, len(findings))
			for i, f := range findings {
				rows[i] = fmt.Sprintf("%s:%d: [%s] %s — %s", f.Path, f.Line, f.Severity, f.Kind, f.Masked)
			}
			plural := "s"
			if len(findings) == 1 {
				plural = ""
			}
			head := fmt.Sprintf("%d possible secret%s found by pattern, worst first — verify each; a pattern match is a lead, not proof.", len(findings), plural)
			return tool.Result{Content: head + "\n" + strings.Join(rows, "\n"), Data: map[string]any{"findings": findings}}
		},
	}
}
