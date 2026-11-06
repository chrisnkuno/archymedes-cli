//go:build windows

package phone

import "syscall"

const (
	esContinuous     = 0x80000000
	esSystemRequired = 0x00000001
)

var setThreadExecutionState = syscall.NewLazyDLL("kernel32.dll").NewProc("SetThreadExecutionState")

// holdWindows asks Windows to stay awake until the returned stop.
func holdWindows() (func(), error) {
	if r, _, err := setThreadExecutionState.Call(esContinuous | esSystemRequired); r == 0 {
		return nil, err
	}
	return func() { setThreadExecutionState.Call(esContinuous) }, nil
}
