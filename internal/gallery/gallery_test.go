package gallery

import (
	"os"
	"strings"
	"testing"
)

func TestEveryPhotoIsShippedDecodesAndIsCredited(t *testing.T) {
	entries, err := os.ReadDir("photos")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != len(Photos) {
		t.Fatalf("%d files for %d photos: every file is listed and every listing has a file", len(entries), len(Photos))
	}
	seen := map[string]bool{}
	for _, p := range Photos {
		if seen[p.ID] {
			t.Fatalf("%s listed twice", p.ID)
		}
		seen[p.ID] = true
		img, err := p.Image()
		if err != nil {
			t.Fatalf("%s: %v", p.ID, err)
		}
		if b := img.Bounds(); b.Dx() < 100 || b.Dy() < 100 || max(b.Dx(), b.Dy()) > 400 {
			t.Fatalf("%s is %v: big enough to draw, small enough to ship", p.ID, b)
		}
		if !strings.HasPrefix(p.CDN, "https://images.unsplash.com/photo-") || strings.Contains(p.CDN, "?") || !strings.Contains(p.Full(960), "w=960") {
			t.Fatalf("%s has no CDN address: %q", p.ID, p.CDN)
		}
		if p.By == "" || p.Title == "" || !strings.Contains(p.Credit(), p.By) || !strings.Contains(p.URL(), p.ID) {
			t.Fatalf("%s is not credited: %+v", p.ID, p)
		}
		switch p.Theme {
		case "greek", "math":
		default:
			t.Fatalf("%s has theme %q", p.ID, p.Theme)
		}
	}
}

func TestPickAndThemeWrapBothWays(t *testing.T) {
	if Pick(len(Photos)) != Photos[0] || Pick(-1) != Photos[len(Photos)-1] {
		t.Fatal("Pick does not wrap")
	}
	if OfTheme("greek", 0).Theme != "greek" || OfTheme("math", 5).Theme != "math" {
		t.Fatal("OfTheme picked outside its theme")
	}
	if OfTheme("nothing", 2) != Pick(2) {
		t.Fatal("an unknown theme falls back to Pick")
	}
}
