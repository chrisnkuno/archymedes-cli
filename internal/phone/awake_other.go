//go:build !windows

package phone

import "os/exec"

func holdWindows() (func(), error) { return nil, exec.ErrNotFound }
