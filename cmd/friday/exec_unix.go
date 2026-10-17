//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// execAgent replaces this process with the agent, so signals, the terminal and the exit status are
// the agent's own, exactly as if it had been run directly.
func execAgent(argv []string) int {
	path, err := exec.LookPath(argv[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, "archymedes:", err)
		return 127
	}
	err = syscall.Exec(path, argv, os.Environ())
	fmt.Fprintln(os.Stderr, "archymedes:", err)
	return 126
}
