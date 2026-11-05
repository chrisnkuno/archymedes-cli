//go:build linux

package tools

import (
	"testing"
	"time"
)

func TestParseStatCountsTheTreeAndSurvivesOddNames(t *testing.T) {
	line := "4242 (my (odd) prog) S 1 4240 4240 0 -1 4194560 100 0 0 0 30 12 5 3 20 0 1 0 100 0 0"
	pgrp, ticks, ok := parseStat(line)
	if !ok || pgrp != 4240 || ticks != 30+12+5+3 {
		t.Fatalf("pgrp %d ticks %d ok %v", pgrp, ticks, ok)
	}
	if _, _, ok := parseStat("garbage"); ok {
		t.Fatal("a line without a name is refused")
	}
}

func TestABusyCommandShowsItsCPUAndAnIdleOneNone(t *testing.T) {
	w, tools := bg(t)
	busy := start(t, w, tools, "sh -c 'while :; do :; done'")
	idle := start(t, w, tools, "sleep 30")
	w.jobs.Activity() // the first look sets the baseline
	time.Sleep(time.Second)
	byID := map[string]Activity{}
	for _, a := range w.jobs.Activity() {
		byID[a.ID] = a
	}
	if a := byID[busy.ID]; !a.CPUKnown || a.CPU < 5 {
		t.Fatalf("a spinning child should show its CPU: %+v", a)
	}
	if a := byID[idle.ID]; !a.CPUKnown || a.CPU > 2 {
		t.Fatalf("sleep should show next to none: %+v", a)
	}
}
