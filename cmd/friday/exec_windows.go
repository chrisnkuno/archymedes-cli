//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
)

// execAgent runs the agent as a child with this process's console and returns its exit status.
// Windows has no exec; Ctrl+C reaches both processes through the shared console, so this one only
// ignores it and waits for the agent to decide.
func execAgent(argv []string) int {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	signal.Ignore(os.Interrupt)
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return exit.ExitCode()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "archymedes:", err)
		return 127
	}
	return 0
}
