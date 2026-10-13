// Package gallery is the interface's photographs: mathematics, the Greek world, science and code,
// chosen from Unsplash and shipped inside the binary, so they show with no network, no account and
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
	Theme string // "greek", "math", "science" or "code"
	// CDN is the photo's address on Unsplash's image CDN, without parameters: where the Gallery
	// loads the full-resolution photo from (hotlinked, as Unsplash asks), sized by Full.
	CDN string
}

// Photos is every photograph, in the order the home screen shows them.
var Photos = []Photo{
	{"GlkROV0KsmE", "Alexander the Great, marble · Athens", "Alex Sanzio", "greek", "https://images.unsplash.com/photo-1705700585343-551cfa3a0c65"},
	{"gYrYa37fAKI", "E = mc² and friends, on a chalkboard", "Artturi Jalli", "math", "https://images.unsplash.com/photo-1636466497217-26a8cbeaf0aa"},
	{"TXWbwRlIdnY", "The Parthenon, Athens", "Amir Hanna", "greek", "https://images.unsplash.com/photo-1567748533376-a0598c1a6991"},
	{"MgtHZ4zlC1U", "Code on a monitor", "Markus Spiske", "code", "https://images.unsplash.com/photo-1576836165612-8bc9b07e7778"},
	{"y9H2d4m36pI", "Homer, bronze", "Birmingham Museums Trust", "greek", "https://images.unsplash.com/photo-1719257726973-60ce7f126f55"},
	{"8z2Q6XWLYa4", "A drawing compass", "Jeff Sheldon", "math", "https://images.unsplash.com/photo-1416339158484-9637228cc908"},
	{"embsBhLrjPU", "At the microscope", "CDC", "science", "https://images.unsplash.com/photo-1631816290943-3d07fbb117a6"},
	{"KTQgb5lcAHw", "Equations, read slowly", "Vitaly Gariev", "math", "https://images.unsplash.com/photo-1758685734268-003e12ca57bc"},
	{"tVXHmtHhsIg", "The Parthenon in grey", "David Watkis", "greek", "https://images.unsplash.com/photo-1567870518898-40273c6d58a3"},
	{"4dXO2xAzRQk", "A proof in progress", "Vitaly Gariev", "math", "https://images.unsplash.com/photo-1758685734303-e85757067f28"},
	{"VkITYPupzSg", "A stereo microscope", "Pawel Czerwinski", "science", "https://images.unsplash.com/photo-1526930700683-86db0d6bab09"},
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
