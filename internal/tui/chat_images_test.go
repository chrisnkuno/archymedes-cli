package tui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPicturesNamedInARequestAreSentWithIt(t *testing.T) {
	dir := t.TempDir()
	png := []byte("\x89PNG\r\n\x1a\nfake")
	os.WriteFile(filepath.Join(dir, "shot.png"), png, 0o644)
	os.MkdirAll(filepath.Join(dir, "my pics"), 0o755)
	os.WriteFile(filepath.Join(dir, "my pics", "a b.jpg"), []byte("jpg"), 0o644)
	os.WriteFile(filepath.Join(dir, "huge.gif"), make([]byte, maxAttachedImage+1), 0o644)
	text := `why is @shot.png blurry? compare my\ pics/a\ b.jpg and "my pics/a b.jpg" and huge.gif and missing.png and notes.txt`
	images, skipped := attachedImages(text, dir)
	if len(images) != 2 || images[0].MimeType != "image/png" || string(images[0].Data) != string(png) || images[1].MimeType != "image/jpeg" {
		t.Fatalf("images = %+v", images)
	}
	if !strings.HasSuffix(images[1].URI, "my pics/a b.jpg") {
		t.Errorf("uri %q", images[1].URI)
	}
	if len(skipped) != 1 || !strings.Contains(skipped[0], "huge.gif is over 5 MB") {
		t.Fatalf("skipped %v", skipped)
	}
}

func TestARequestWithAPictureSendsIt(t *testing.T) {
	m, agent := newTestModel(t)
	dir := t.TempDir()
	m.opts.Cwd = dir
	os.WriteFile(filepath.Join(dir, "bug.png"), []byte("png"), 0o644)
	run(m, m.send("what is wrong in bug.png"))
	if len(agent.images) != 1 || agent.images[0].MimeType != "image/png" || !strings.Contains(screen(m), "Sent 1 image with the request") {
		t.Fatalf("images %+v\n%s", agent.images, screen(m))
	}
}
