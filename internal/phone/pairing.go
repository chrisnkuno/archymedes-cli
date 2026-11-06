package phone

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// The pairing on disk: <config>/phone.json, readable by its owner alone.

func pairingPath(configDir string) string { return filepath.Join(configDir, "phone.json") }

type pairingFile struct {
	Secret string `json:"secret"`
}

// LoadPairing is the pairing kept in configDir; ok is false when there is none. A damaged file is an
// error, never a pairing.
func LoadPairing(configDir string) (s Secret, ok bool, err error) {
	data, err := os.ReadFile(pairingPath(configDir))
	if errors.Is(err, os.ErrNotExist) {
		return s, false, nil
	}
	if err != nil {
		return s, false, err
	}
	var f pairingFile
	if err := json.Unmarshal(data, &f); err != nil {
		return s, false, fmt.Errorf("phone.json is damaged: %w", err)
	}
	s, err = ParseSecret(f.Secret)
	if err != nil {
		return s, false, fmt.Errorf("phone.json is damaged: %w", err)
	}
	return s, true, nil
}

// SavePairing keeps a pairing, replacing any before it: written beside and renamed into place.
func SavePairing(configDir string, s Secret) error {
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return err
	}
	_ = os.Chmod(configDir, 0o700)
	data, _ := json.Marshal(pairingFile{Secret: s.Encode()})
	tmp, err := os.CreateTemp(configDir, ".phone-*.json")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if err := tmp.Chmod(0o600); err != nil && !errors.Is(err, errors.ErrUnsupported) {
		tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), pairingPath(configDir))
}

// DeletePairing forgets the pairing; none is not an error.
func DeletePairing(configDir string) error {
	err := os.Remove(pairingPath(configDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}
