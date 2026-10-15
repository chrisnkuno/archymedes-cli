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
		case "greek", "math", "scifi":
		default:
			t.Fatalf("%s has theme %q", p.ID, p.Theme)
		}
	}
}

func TestPickAndThemeWrapBothWays(t *testing.T) {
	if Pick(len(Photos)) != Photos[0] || Pick(-1) != Photos[len(Photos)-1] {
		t.Fatal("Pick does not wrap")
	}
	if OfTheme("greek", 0).Theme != "greek" || OfTheme("math", 5).Theme != "math" || OfTheme("scifi", -3).Theme != "scifi" {
		t.Fatal("OfTheme picked outside its theme")
	}
	for i, p := range Photos {
		if IndexOf(p) != i || Pick(IndexOf(p)) != p {
			t.Fatalf("IndexOf(%s) is not its place", p.ID)
		}
	}
	if IndexOf(Photo{ID: "missing"}) != 0 {
		t.Fatal("an unlisted photo has a place")
	}
	if OfTheme("nothing", 2) != Pick(2) {
		t.Fatal("an unknown theme falls back to Pick")
	}
}

func TestTheWallpaperAlternatesAntiquityAndSciFi(t *testing.T) {
	for n := range 8 {
		a, b := Wallpaper(n), Wallpaper(n+1)
		if a.Theme == b.Theme || (a.Theme != "greek" && a.Theme != "scifi") {
			t.Fatalf("wallpapers %d and %d: %s then %s", n, n+1, a.Theme, b.Theme)
		}
	}
	if Wallpaper(-1) == (Photo{}) || Wallpaper(0).ID != "ORaUWw7Na5c" {
		t.Fatalf("the first wallpaper is %s, not Archimedes", Wallpaper(0).ID)
	}
}
