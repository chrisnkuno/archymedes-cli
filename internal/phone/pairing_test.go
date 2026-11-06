package phone

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// The pairing is kept where only its owner can read it, survives a restart, and goes when asked.

func TestAPairingIsKeptPrivatelyAndReadBack(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "config")
	if _, ok, err := LoadPairing(dir); ok || err != nil {
		t.Fatalf("a pairing before any was made: %v %v", ok, err)
	}
	s, _ := NewSecret()
	if err := SavePairing(dir, s); err != nil {
		t.Fatal(err)
	}
	got, ok, err := LoadPairing(dir)
	if err != nil || !ok || got != s {
		t.Fatalf("read back %v %v %v", got, ok, err)
	}
	if runtime.GOOS != "windows" {
		info, _ := os.Stat(filepath.Join(dir, "phone.json"))
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("phone.json is %v, want 0600", info.Mode().Perm())
		}
		d, _ := os.Stat(dir)
		if d.Mode().Perm()&0o077 != 0 {
			t.Fatalf("its folder is %v, open to others", d.Mode().Perm())
		}
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if e.Name() != "phone.json" {
			t.Fatalf("a stray file is left beside it: %s", e.Name())
		}
	}
}

func TestANewPairingReplacesTheOldAndDeletingRemovesIt(t *testing.T) {
	dir := t.TempDir()
	a, _ := NewSecret()
	b, _ := NewSecret()
	_ = SavePairing(dir, a)
	_ = SavePairing(dir, b)
	if got, _, _ := LoadPairing(dir); got != b {
		t.Fatal("the new pairing did not replace the old")
	}
	if err := DeletePairing(dir); err != nil {
		t.Fatal(err)
	}
	if _, ok, _ := LoadPairing(dir); ok {
		t.Fatal("a deleted pairing is still read")
	}
	if err := DeletePairing(dir); err != nil {
		t.Fatalf("deleting twice is not an error: %v", err)
	}
}

func TestADamagedPairingFileIsAnErrorNotAPairing(t *testing.T) {
	dir := t.TempDir()
	for _, junk := range []string{"", "{", `{"secret":"short"}`, `{"secret":42}`} {
		_ = os.WriteFile(filepath.Join(dir, "phone.json"), []byte(junk), 0o600)
		if _, ok, err := LoadPairing(dir); ok || err == nil {
			t.Fatalf("%q read as a pairing (ok=%v err=%v)", junk, ok, err)
		}
	}
}
