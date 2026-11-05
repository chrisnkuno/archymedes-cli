package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/chrisnkuno/friday-cli/internal/core/tools"
)

func TestTheActivityAnswerCarriesWhatTheViewNeeds(t *testing.T) {
	at := time.UnixMilli(1793092237461)
	data, err := json.Marshal(activityAnswer([]tools.Activity{
		{ID: "fg1", CallID: "c7", Command: "go test ./...", Dir: "/repo", Pid: 42, Status: "running", Started: at,
			Elapsed: 6 * time.Minute, LastOutput: at.Add(time.Second), Quiet: 5*time.Minute + time.Second, CPU: 0.04, CPUKnown: true, Stuck: true, Tail: []string{"ok a"}},
		{ID: "cmd1", Command: "true", Background: true, Status: "exited 0", Started: at},
	}))
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	for _, want := range []string{`"kind":"activity"`, `"id":"fg1"`, `"callId":"c7"`, `"pid":42`, `"elapsedMs":360000`, `"lastOutputAt":1793092238461`,
		`"quietMs":301000`, `"cpu":0`, `"cpuKnown":true`, `"stuck":true`, `"tail":["ok a"]`, `"background":true`, `"status":"exited 0"`, `"lastOutputAt":0`, `"tail":[]`} {
		if !strings.Contains(got, want) {
			t.Errorf("answer lacks %s: %s", want, got)
		}
	}
}
