//go:build linux

package tools

import (
	"os"
	"strconv"
	"strings"
)

// groupCPUTicks is the CPU a command's process tree has used, in clock ticks: every live process
// in its process group (a background or foreground command leads its own), each with what its
// finished children used. It reads /proc; false when the leader is gone or /proc cannot be read.
func groupCPUTicks(pgid int) (uint64, bool) {
	if pgid <= 0 {
		return 0, false
	}
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0, false
	}
	var total uint64
	found := false
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		data, err := os.ReadFile("/proc/" + e.Name() + "/stat")
		if err != nil {
			continue // it ended while we looked
		}
		group, ticks, ok := parseStat(string(data))
		if !ok || group != pgid {
			continue
		}
		total += ticks
		if pid == pgid {
			found = true
		}
	}
	return total, found
}

// parseStat reads a /proc/<pid>/stat line: its process group, and utime + stime + cutime + cstime.
// The command name, in parentheses, may hold spaces and parentheses, so fields count from the last ')'.
func parseStat(line string) (pgrp int, ticks uint64, ok bool) {
	i := strings.LastIndexByte(line, ')')
	if i < 0 {
		return 0, 0, false
	}
	f := strings.Fields(line[i+1:])
	// After the name: state ppid pgrp session tty tpgid flags minflt cminflt majflt cmajflt utime stime cutime cstime
	if len(f) < 15 {
		return 0, 0, false
	}
	pgrp, err := strconv.Atoi(f[2])
	if err != nil {
		return 0, 0, false
	}
	for _, k := range []int{11, 12, 13, 14} {
		n, err := strconv.ParseInt(f[k], 10, 64)
		if err != nil {
			return 0, 0, false
		}
		if n > 0 {
			ticks += uint64(n)
		}
	}
	return pgrp, ticks, true
}
