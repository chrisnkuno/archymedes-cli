package update

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// What an install must not do is replace files a running Friday still needs: the TypeScript agent
// loads its code in hashed chunks on demand, and the Go engine runs from the very binary an install
// rewrites. So an install waits for a moment when no Friday is running from this install, and that
// takes every running Friday to say it is there. Each one keeps a small file fresh while it lives
// (a heartbeat, not a pid, so it means the same on every platform and a crash simply stops it); a
// file nobody has touched for a while belongs to something that is gone.

const (
	// heartbeatEvery is how often a running Friday touches its file.
	heartbeatEvery = 30 * time.Second
	// sessionStale is how long without a touch before a file is taken to belong to nothing.
	sessionStale = 2 * time.Minute
	// lockStale is how long an install may hold the lock before it is taken to have died.
	lockStale = 20 * time.Minute
)

func updateDir(configDir string) string { return filepath.Join(configDir, "update") }

func sessionsDir(configDir string) string { return filepath.Join(updateDir(configDir), "sessions") }

func lockFile(configDir string) string { return filepath.Join(updateDir(configDir), "install.lock") }

// RegisterSession records that this process is a running Friday, and returns how to say it has
// ended. It never fails the caller: if the record cannot be kept, an install elsewhere simply
// cannot see this session, which is why the registry is written before anything is loaded.
func RegisterSession(configDir string) (release func()) {
	if configDir == "" {
		return func() {}
	}
	dir := sessionsDir(configDir)
	if os.MkdirAll(dir, 0o755) != nil {
		return func() {}
	}
	name := filepath.Join(dir, fmt.Sprintf("%d-%d", os.Getpid(), time.Now().UnixNano()))
	if os.WriteFile(name, []byte(strconv.Itoa(os.Getpid())), 0o644) != nil {
		return func() {}
	}
	stop, done := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(done)
		tick := time.NewTicker(heartbeatEvery)
		defer tick.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-tick.C:
				_ = os.Chtimes(name, now, now)
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() { // ending twice is harmless: a deferred release beside an explicit one
			close(stop)
			<-done
			_ = os.Remove(name)
		})
	}
}

// othersRunning counts the running sessions: files touched recently. A closing session has already
// released its own, so everything left is another Friday.
// Files that went stale are removed on the way: they belong to a Friday that crashed.
func othersRunning(configDir string, now time.Time) int {
	entries, _ := os.ReadDir(sessionsDir(configDir))
	n := 0
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		if now.Sub(info.ModTime()) > sessionStale {
			_ = os.Remove(filepath.Join(sessionsDir(configDir), e.Name()))
			continue
		}
		n++
	}
	return n
}

// acquireInstallLock takes the one lock an install runs under, so two Friday processes never run
// the package manager against the same install at once. A lock older than lockStale was left by an
// install that died, and is broken.
func acquireInstallLock(configDir string, now time.Time) (release func(), ok bool) {
	if configDir == "" || os.MkdirAll(updateDir(configDir), 0o755) != nil {
		return nil, false
	}
	path := lockFile(configDir)
	for attempt := 0; attempt < 2; attempt++ {
		f, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
		if err == nil {
			_, _ = fmt.Fprintf(f, "%d %d", os.Getpid(), now.UnixMilli())
			_ = f.Close()
			return func() { _ = os.Remove(path) }, true
		}
		info, serr := os.Stat(path)
		if serr != nil || now.Sub(info.ModTime()) <= lockStale {
			return nil, false
		}
		_ = os.Remove(path) // the holder is long gone
	}
	return nil, false
}
