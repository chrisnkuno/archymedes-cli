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

// terminateGroup asks a background command and everything it started to end (SIGTERM).
func terminateGroup(j *Job) { _ = syscall.Kill(-j.Pid, syscall.SIGTERM) }

// killGroup ends what is left of a process group (SIGKILL); a group already gone is no error.
func killGroup(pid int) {
	if pid > 0 {
		_ = syscall.Kill(-pid, syscall.SIGKILL)
	}
}
