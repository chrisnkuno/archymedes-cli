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

func TestPhotosAreOnUnlessSaidOtherwise(t *testing.T) {
	for value, off := range map[string]bool{"": false, "on": false, "off": true, "OFF": true, "0": true, "false": true, "no": true, " off ": true} {
		if photosOff(value) != off {
			t.Errorf("ARCHYMEDES_PHOTOS=%q: off=%v", value, !off)
		}
	}
}
