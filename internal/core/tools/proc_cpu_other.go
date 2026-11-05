//go:build !linux

package tools

// groupCPUTicks has no reading outside Linux: the view says the CPU is unknown on this system, and
// the stall rule calls nothing stuck.
func groupCPUTicks(int) (uint64, bool) { return 0, false }
