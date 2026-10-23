package gallery

import (
	"image"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestEveryPhotoIsShippedDecodesAndIsCredited(t *testing.T) {
	entries, err := os.ReadDir("photos")
	if err != nil {
		t.Fatal(err)
	}
	photographs := 0
	seen := map[string]bool{}
	for _, p := range Photos {
		if seen[p.ID] {
			t.Fatalf("%s listed twice", p.ID)
		}
		seen[p.ID] = true
		if p.Title == "" || p.By == "" || p.Byline() == "" || p.Credit() == "" {
			t.Fatalf("%s is not described: %+v", p.ID, p)
		}
		switch p.Theme {
		case "greek", "math", "scifi", "abstract":
		default:
			t.Fatalf("%s has theme %q", p.ID, p.Theme)
		}
		img, err := p.Image()
		if err != nil {
			t.Fatalf("%s: %v", p.ID, err)
		}
		if b := img.Bounds(); b.Dx() < 100 || b.Dy() < 100 || max(b.Dx(), b.Dy()) > 400 {
			t.Fatalf("%s is %v: big enough to draw, small enough to ship", p.ID, b)
		}
		if p.Generated() {
			if p.CDN != "" || p.URL() != "" || !strings.HasPrefix(p.ID, "art-") || !strings.Contains(p.Byline(), "Friday") || strings.Contains(p.Byline(), "Unsplash") {
				t.Fatalf("%s is generated but described as a photograph: %+v", p.ID, p)
			}
			continue
		}
		photographs++
		if !strings.HasPrefix(p.CDN, "https://images.unsplash.com/photo-") || strings.Contains(p.CDN, "?") || !strings.Contains(p.Full(960), "w=960") {
			t.Fatalf("%s has no CDN address (or an Unsplash+ one): %q", p.ID, p.CDN)
		}
		if !strings.Contains(p.Credit(), p.By) || !strings.Contains(p.URL(), p.ID) || p.Byline() != "by "+p.By+" · Unsplash" {
			t.Fatalf("%s is not credited: %+v", p.ID, p)
		}
	}
	if len(entries) != photographs {
		t.Fatalf("%d files for %d photographs: every file is listed and every listing has a file", len(entries), photographs)
	}
}

func TestPickAndThemeWrapBothWays(t *testing.T) {
	if Pick(len(Photos)).ID != Photos[0].ID || Pick(-1).ID != Photos[len(Photos)-1].ID {
		t.Fatal("Pick does not wrap")
	}
	if OfTheme("greek", 0).Theme != "greek" || OfTheme("math", 5).Theme != "math" || OfTheme("scifi", -3).Theme != "scifi" || OfTheme("abstract", 40).Theme != "abstract" {
		t.Fatal("OfTheme picked outside its theme")
	}
	for i, p := range Photos {
		if IndexOf(p) != i || Pick(IndexOf(p)).ID != p.ID {
			t.Fatalf("IndexOf(%s) is not its place", p.ID)
		}
	}
	if IndexOf(Photo{ID: "missing"}) != 0 {
		t.Fatal("an unlisted photo has a place")
	}
	if OfTheme("nothing", 2).ID != Pick(2).ID {
		t.Fatal("an unknown theme falls back to Pick")
	}
}

func TestTheWallpaperTakesTheThemesInTurn(t *testing.T) {
	want := []string{"greek", "scifi", "abstract"}
	for n := range 30 {
		if got := Wallpaper(n).Theme; got != want[n%3] {
			t.Fatalf("wallpaper %d is %s, want %s", n, got, want[n%3])
		}
	}
	if Wallpaper(0).ID != "ORaUWw7Na5c" {
		t.Fatalf("the first wallpaper is %s, not Archimedes", Wallpaper(0).ID)
	}
	// Every abstract picture comes round before any repeats.
	seen := map[string]bool{}
	for n := 2; len(seen) < len(ofTheme("abstract")); n += 3 {
		id := Wallpaper(n).ID
		if seen[id] {
			t.Fatalf("%s came round again before every abstract one had", id)
		}
		seen[id] = true
	}
	if Wallpaper(-1).ID == "" || WallpaperOf("abstract", -1).Theme != "abstract" || WallpaperOf("nothing", 4).ID != Wallpaper(4).ID {
		t.Fatal("WallpaperOf does not wrap, or keep to its theme")
	}
}

func TestGeneratedPicturesDrawAtAnySizeTheSameEachTime(t *testing.T) {
	for _, p := range Photos {
		if !p.Generated() {
			continue
		}
		a, b := p.Art(64, 40), p.Art(64, 40)
		if a.Bounds() != image.Rect(0, 0, 64, 40) || p.Art(320, 200).Bounds().Dx() != 320 {
			t.Fatalf("%s drew the wrong size", p.ID)
		}
		lit := 0
		for y := range 40 {
			for x := range 64 {
				ra, ga, ba, _ := a.At(x, y).RGBA()
				rb, gb, bb, _ := b.At(x, y).RGBA()
				if ra != rb || ga != gb || ba != bb {
					t.Fatalf("%s is not deterministic at %d,%d", p.ID, x, y)
				}
				if ra+ga+ba > 3*0x2000 {
					lit++
				}
			}
		}
		if lit < 64*40/50 {
			t.Fatalf("%s is nearly black: %d lit pixels", p.ID, lit)
		}
	}
}

func TestTheArtSchemeServesAGeneratedPictureAsPNG(t *testing.T) {
	client := HTTPClient(0)
	p, _ := ByID("art-synthwave")
	resp, err := client.Get(p.Full(320))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	img, _, err := image.Decode(resp.Body)
	if err != nil || resp.Header.Get("Content-Type") != "image/png" || img.Bounds().Dx() != 320 || img.Bounds().Dy() != 200 {
		t.Fatalf("got %v, %v, %v", resp.Header, img, err)
	}
	for _, bad := range []string{ArtScheme + "://art-nothing?w=100", ArtScheme + "://ORaUWw7Na5c?w=100"} {
		resp, err := client.Get(bad)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Fatalf("%s: %d", bad, resp.StatusCode)
			}
		}
	}
	resp, err = client.Get(ArtScheme + "://art-synthwave?w=99999")
	if err != nil {
		t.Fatal(err)
	}
	img, _, _ = image.Decode(resp.Body)
	resp.Body.Close()
	if img == nil || img.Bounds().Dx() > maxArtWidth {
		t.Fatal("an enormous width was drawn as asked")
	}
}

func TestEveryPictureIsInTheCreditsFile(t *testing.T) {
	data, err := os.ReadFile("CREDITS.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range Photos {
		if !strings.Contains(string(data), p.ID) {
			t.Errorf("%s (%s) is not in CREDITS.md", p.ID, p.Title)
		}
	}
}
