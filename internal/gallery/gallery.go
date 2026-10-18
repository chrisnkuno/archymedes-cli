// Package gallery is the interface's photographs: Archimedes, the Greek world and mathematics, and
// isometric sci-fi renders, which take turns as the wallpaper; chosen from Unsplash and shipped inside the binary, so they show with no network, no account and
// no key. Each is under the Unsplash License (free to use, no permission needed) and is credited to
// its photographer wherever it is drawn anyway.
package gallery

import (
	"bytes"
	"embed"
	"fmt"
	"image"
	_ "image/jpeg" // the photos are JPEG
	"sync"
)

//go:embed photos/*.jpg
var files embed.FS

// Photo is one photograph and what to say about it.
type Photo struct {
	ID    string // Unsplash photo id; the file is photos/<ID>.jpg
	Title string // what it shows, short enough for a caption
	By    string // the photographer, as Unsplash credits them
	Theme string // "greek", "math", or "scifi" (the wallpapers)
	// CDN is the photo's address on Unsplash's image CDN, without parameters: where the Gallery
	// loads the full-resolution photo from (hotlinked, as Unsplash asks), sized by Full.
	CDN string
}

// Photos is every photograph, in the order the home screen shows them.
var Photos = []Photo{
	{"ORaUWw7Na5c", "Archimedes, marble · Rome", "Blaz Erzetic", "greek", "https://images.unsplash.com/photo-1575379972039-e4dcfa0539ca"},
	{"GlkROV0KsmE", "Alexander the Great, marble · Athens", "Alex Sanzio", "greek", "https://images.unsplash.com/photo-1705700585343-551cfa3a0c65"},
	{"gYrYa37fAKI", "E = mc² and friends, on a chalkboard", "Artturi Jalli", "math", "https://images.unsplash.com/photo-1636466497217-26a8cbeaf0aa"},
	{"TXWbwRlIdnY", "The Parthenon, Athens", "Amir Hanna", "greek", "https://images.unsplash.com/photo-1567748533376-a0598c1a6991"},
	{"y9H2d4m36pI", "Homer, bronze", "Birmingham Museums Trust", "greek", "https://images.unsplash.com/photo-1719257726973-60ce7f126f55"},
	{"8z2Q6XWLYa4", "A drawing compass", "Jeff Sheldon", "math", "https://images.unsplash.com/photo-1416339158484-9637228cc908"},
	{"KTQgb5lcAHw", "Equations, read slowly", "Vitaly Gariev", "math", "https://images.unsplash.com/photo-1758685734268-003e12ca57bc"},
	{"tVXHmtHhsIg", "The Parthenon in grey", "David Watkis", "greek", "https://images.unsplash.com/photo-1567870518898-40273c6d58a3"},
	{"4dXO2xAzRQk", "A proof in progress", "Vitaly Gariev", "math", "https://images.unsplash.com/photo-1758685734303-e85757067f28"},
	{"8TttTCQLUKw", "Data blocks in violet light · 3D", "Brecht Corbeel", "scifi", "https://images.unsplash.com/photo-1650954933593-6c9342ba0331"},
	{"tGGuWW28-5M", "A circuit city, lit from within · 3D", "A Chosen Soul", "scifi", "https://images.unsplash.com/photo-1735744583234-ff1829001965"},
	{"6XfBmLfaS-k", "A coder's room at night · isometric", "ANTIPOLYGON YOUTUBE", "scifi", "https://images.unsplash.com/photo-1661867011861-671e1cd85cc2"},
	{"KZzPoMs5eIQ", "Lift-off from the chip · isometric", "Omar:. Lopez-Rincon", "scifi", "https://images.unsplash.com/photo-1744470680770-7db82336ca27"},
	{"m5HRQlDWDx4", "The violet core · 3D", "LekoArts", "scifi", "https://images.unsplash.com/photo-1684395646154-19832d6265b3"},
	{"SZcLtU9NcBI", "The machine that mints · isometric", "Tran Mau Tri Tam ✪", "scifi", "https://images.unsplash.com/photo-1647331311387-9cca489b53f2"},
	{"M3T9qfa_kDQ", "Neon city, made in Blender", "Bojun Liu", "scifi", "https://images.unsplash.com/photo-1732631486925-8f7e9924f993"},
}

// URL is the photo's page on Unsplash, with the referral Unsplash asks apps to send.
func (p Photo) URL() string {
	return "https://unsplash.com/photos/" + p.ID + "?utm_source=archymedes&utm_medium=referral"
}

// Full is the photo at width pixels from Unsplash's CDN: a JPEG, never wider than the original.
func (p Photo) Full(width int) string {
	return fmt.Sprintf("%s?w=%d&q=80&fm=jpg&fit=max", p.CDN, width)
}

// Credit is the attribution line: the photographer, on Unsplash.
func (p Photo) Credit() string { return "Photo: " + p.By + " / Unsplash" }

var (
	decodeMu sync.Mutex
	decoded  = map[string]image.Image{}
)

// Image decodes the photo once and keeps it.
func (p Photo) Image() (image.Image, error) {
	decodeMu.Lock()
	defer decodeMu.Unlock()
	if img, ok := decoded[p.ID]; ok {
		return img, nil
	}
	data, err := files.ReadFile("photos/" + p.ID + ".jpg")
	if err != nil {
		return nil, err
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	decoded[p.ID] = img
	return img, nil
}

// Pick is the n-th photo, wrapping; a negative n counts back from the end.
func Pick(n int) Photo {
	n %= len(Photos)
	if n < 0 {
		n += len(Photos)
	}
	return Photos[n]
}

// Wallpaper is the n-th wallpaper (wrapping either way): the antiquity photos (Archimedes, Rome,
// Greece) and the sci-fi renders, taking turns, so the screen moves between the two worlds the
// name spans rather than staying in one.
func Wallpaper(n int) Photo {
	var greek, scifi []Photo
	for _, p := range Photos {
		switch p.Theme {
		case "greek":
			greek = append(greek, p)
		case "scifi":
			scifi = append(scifi, p)
		}
	}
	var turns []Photo
	for i := range max(len(greek), len(scifi)) {
		if i < len(greek) {
			turns = append(turns, greek[i])
		}
		if i < len(scifi) {
			turns = append(turns, scifi[i])
		}
	}
	if len(turns) == 0 {
		return Pick(n)
	}
	n %= len(turns)
	if n < 0 {
		n += len(turns)
	}
	return turns[n]
}

// ByID is the photo with id, and whether there is one.
func ByID(id string) (Photo, bool) {
	for _, p := range Photos {
		if p.ID == id {
			return p, true
		}
	}
	return Photo{}, false
}

// IndexOf is p's place in Photos, for Pick; 0 when it is not listed.
func IndexOf(p Photo) int {
	for i, q := range Photos {
		if q.ID == p.ID {
			return i
		}
	}
	return 0
}

// OfTheme is the n-th photo of a theme (wrapping), or Pick(n) when no photo has that theme.
func OfTheme(theme string, n int) Photo {
	var matching []Photo
	for _, p := range Photos {
		if p.Theme == theme {
			matching = append(matching, p)
		}
	}
	if len(matching) == 0 {
		return Pick(n)
	}
	n %= len(matching)
	if n < 0 {
		n += len(matching)
	}
	return matching[n]
}
