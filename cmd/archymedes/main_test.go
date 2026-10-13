package main

import (
	"reflect"
	"testing"
)

func TestAgentCommandAcceptsAJSONArraySoPathsMayHoldSpaces(t *testing.T) {
	got, err := agentCommand(`["C:\\Program Files\\nodejs\\node.exe","C:\\npm\\archymedes-cli\\dist\\archymedes.mjs"]`, "")
	if err != nil || !reflect.DeepEqual(got, []string{`C:\Program Files\nodejs\node.exe`, `C:\npm\archymedes-cli\dist\archymedes.mjs`}) {
		t.Fatalf("%q %v", got, err)
	}
	if got, _ := agentCommand("bun run x.ts", ""); !reflect.DeepEqual(got, []string{"bun", "run", "x.ts"}) {
		t.Fatalf("%q", got)
	}
	if _, err := agentCommand(`["unterminated`, ""); err == nil {
		t.Fatal("a malformed array is an error, not a command")
	}
}
