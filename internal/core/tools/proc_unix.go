//go:build !windows

package tools

import (
	"os/exec"
	"syscall"
)

// setProcessGroup puts the command in its own group and kills the whole group on cancel, so a
// test runner's children do not outlive the call.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
