package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"charm.land/fantasy"

	"github.com/chrisnkuno/friday-cli/internal/core/llm"
	"github.com/chrisnkuno/friday-cli/internal/core/policy"
	"github.com/chrisnkuno/friday-cli/internal/core/server"
)

func scriptedOptions(t *testing.T, root string, mode policy.Mode, turns func(fantasy.Call) (string, [][2]string)) server.Options {
	var n atomic.Int64
	return server.Options{
		Cwd: root, ConfigDir: t.TempDir(), Environ: []string{"GROQ_API_KEY=test", "ARCHYMEDES_TEST_FIRST=off", "ARCHYMEDES_TITLES=off", "ARCHYMEDES_SUGGEST=off"},
		Provider: "groq", Mode: mode,
		Open: func(_ context.Context, _ llm.Selection, _ llm.Env, id string) (fantasy.LanguageModel, error) {
			return scriptedModel{id: id, turns: turns, n: &n}, nil
		},
	}
}

// writesThenAnswers asks to write a file, then answers with what it was told.
func writesThenAnswers(call fantasy.Call) (string, [][2]string) {
	role, text := lastMessage(call)
	if role == fantasy.MessageRoleUser && text == "make out.json" {
		return "", [][2]string{{"write_file", `{"path":"out.json","content":"{}"}`}}
	}
	if strings.Contains(text, "declined") {
		return "I could not write it: nobody approved.", nil
	}
	return "Wrote out.json.", nil
}

func TestAScriptedRunPrintsTheAnswerAndRefusesWhatWouldAsk(t *testing.T) {
	root := t.TempDir()
	var stdout, stderr bytes.Buffer
	inv, asJSON, ok := scriptedRun([]string{"--print", "make out.json"}, true)
	if !ok || asJSON {
		t.Fatalf("scriptedRun = %+v %v %v", inv, asJSON, ok)
	}
	code := runScripted(inv, false, scriptedOptions(t, root, policy.Build, writesThenAnswers), nil, nil, &stdout, &stderr)
	if code != 0 || strings.TrimSpace(stdout.String()) != "I could not write it: nobody approved." {
		t.Fatalf("exit %d, stdout %q, stderr %q", code, stdout.String(), stderr.String())
	}
	if !strings.Contains(stderr.String(), "refused (nobody to approve)") || !strings.Contains(stderr.String(), "· write file out.json") {
		t.Fatalf("stderr %q", stderr.String())
	}
	if _, err := os.Stat(filepath.Join(root, "out.json")); !os.IsNotExist(err) {
		t.Fatal("a refused write happened")
	}
}

func TestAJSONRunWritesOneObjectPerLine(t *testing.T) {
	root := t.TempDir()
	var stdout, stderr bytes.Buffer
	inv, asJSON, ok := scriptedRun([]string{"--json", "--auto", "make out.json"}, false)
	if !ok || !asJSON {
		t.Fatalf("scriptedRun = %v %v", asJSON, ok)
	}
	code := runScripted(inv, true, scriptedOptions(t, root, policy.Auto, writesThenAnswers), nil, nil, &stdout, &stderr)
	if code != 0 {
		t.Fatalf("exit %d: %s %s", code, stdout.String(), stderr.String())
	}
	var types []string
	var last map[string]any
	for _, line := range strings.Split(strings.TrimSpace(stdout.String()), "\n") {
		var v map[string]any
		if err := json.Unmarshal([]byte(line), &v); err != nil {
			t.Fatalf("not JSON: %q", line)
		}
		types = append(types, v["type"].(string))
		last = v
	}
	joined := strings.Join(types, ",")
	if !strings.HasPrefix(joined, "session,") || !strings.Contains(joined, "tool_call,tool_result") || last["type"] != "result" || last["status"] != "completed" || last["text"] != "Wrote out.json." {
		t.Fatalf("types %s, last %v", joined, last)
	}
	if _, err := os.Stat(filepath.Join(root, "out.json")); err != nil {
		t.Fatal("auto did not write")
	}
	if stderr.Len() != 0 {
		t.Fatalf("a JSON run wrote to stderr: %q", stderr.String())
	}
}

func TestTheRequestCanComeFromStdinAndMustComeFromSomewhere(t *testing.T) {
	answer := func(call fantasy.Call) (string, [][2]string) {
		_, text := lastMessage(call)
		return "you said: " + text, nil
	}
	var stdout, stderr bytes.Buffer
	inv, _, _ := scriptedRun(nil, false)
	if code := runScripted(inv, false, scriptedOptions(t, t.TempDir(), policy.Build, answer), nil, strings.NewReader("summarize README\n"), &stdout, &stderr); code != 0 || strings.TrimSpace(stdout.String()) != "you said: summarize README" {
		t.Fatalf("exit %d, %q %q", code, stdout.String(), stderr.String())
	}
	stdout.Reset()
	stderr.Reset()
	if code := runScripted(inv, false, scriptedOptions(t, t.TempDir(), policy.Build, answer), nil, strings.NewReader(""), &stdout, &stderr); code != 2 || !strings.Contains(stderr.String(), "no request") {
		t.Fatalf("exit %d, %q", code, stderr.String())
	}
}

func TestWhatCountsAsAScriptedRun(t *testing.T) {
	for _, c := range []struct {
		args        []string
		interactive bool
		ok, json    bool
		prompt      string
	}{
		{[]string{"fix it"}, false, true, false, "fix it"},
		{[]string{"fix it"}, true, false, false, ""},
		{[]string{"--print", "-p", "fix it"}, true, true, false, "fix it"},
		{[]string{"--headless", "fix it"}, true, true, true, "fix it"},
		{[]string{"doctor"}, false, false, false, ""},
		{[]string{"--sessions"}, false, false, false, ""},
		{[]string{"--json", "--providers"}, false, false, false, ""},
	} {
		inv, asJSON, ok := scriptedRun(c.args, c.interactive)
		if ok != c.ok || asJSON != c.json || (ok && inv.Prompt != c.prompt) {
			t.Errorf("%v (terminal %v): ok %v json %v prompt %q", c.args, c.interactive, ok, asJSON, inv.Prompt)
		}
	}
	if inv, _, _ := scriptedRun([]string{"--print", "-p", "x"}, true); !strings.Contains(strings.Join(inv.Args, " "), "-p") {
		t.Errorf("plan mode lost: %v", inv.Args)
	}
}
