//go:build windows

package tools

import "os/exec"

// setProcessGroup leaves the default on Windows: exec.CommandContext kills the process itself.
func setProcessGroup(cmd *exec.Cmd) {}

// terminateGroup has no SIGTERM to send on Windows: it kills the process through its context.
func terminateGroup(j *Job) { j.cancel() }

// killGroup has no group to sweep on Windows; a process is killed through its context.
func killGroup(pid int) {}
