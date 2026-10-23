package gallery

import (
	"image"
	"image/png"
	"os"
	"path/filepath"
	"testing"
)

// TestPreviewArt writes every generated picture as a PNG when ARCHYMEDES_ART_PREVIEW names a
// folder: for looking at them while tuning, not for CI.
func TestPreviewArt(t *testing.T) {
	dir := os.Getenv("ARCHYMEDES_ART_PREVIEW")
	if dir == "" {
		t.Skip("set ARCHYMEDES_ART_PREVIEW to a folder")
	}
	for name, fn := range map[string]func(int, int) image.Image{
		"aurora": artAurora, "synthwave": artSynthwave, "nebula": artNebula, "chrome": artChrome,
		"horizon": artEventHorizon, "lattice": artLattice, "tunnel": artTunnel, "silk": artSilk,
	} {
		f, err := os.Create(filepath.Join(dir, name+".png"))
		if err != nil {
			t.Fatal(err)
		}
		if err := png.Encode(f, fn(640, 400)); err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
}
