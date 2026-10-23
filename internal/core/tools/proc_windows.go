//go:build windows

package tools

import "os/exec"

// setProcessGroup leaves the default on Windows: exec.CommandContext kills the process itself.
func setProcessGroup(cmd *exec.Cmd) {}
