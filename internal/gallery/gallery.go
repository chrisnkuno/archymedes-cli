// Package gallery is the interface's pictures: Archimedes, the Greek world and mathematics;
// isometric sci-fi renders; and abstract, future-themed work, which take turns as the wallpaper.
//
// Two kinds. Photographs are chosen from Unsplash and shipped inside the binary, so they show with
// no network, no account and no key; each is under the Unsplash License (free to use, no
// permission needed) and is credited to its photographer wherever it is drawn anyway. Generated
// pictures (art.go) are Friday's own, drawn by code at whatever size is asked.
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

// Photo is one picture and what to say about it.
type Photo struct {
	ID    string // Unsplash photo id (the file is photos/<ID>.jpg), or art-<name> for a generated one
	Title string // what it shows, short enough for a caption
	By    string // the photographer, as Unsplash credits them; "Friday" for a generated one
	Theme string // "greek", "math", "scifi" or "abstract"
	// CDN is the photo's address on Unsplash's image CDN, without parameters: where the Gallery
	// loads the full-resolution photo from (hotlinked, as Unsplash asks), sized by Full. Empty for
	// a generated picture.
	CDN string
	// Art draws a generated picture at w×h; nil for a photograph.
	Art func(w, h int) image.Image
}

// Themes are the kinds of picture, in the order the wallpaper takes them.
var Themes = []string{"greek", "scifi", "abstract"}

// ThemeLabel is a theme in words.
func ThemeLabel(theme string) string {
	switch theme {
	case "greek":
		return "antiquity"
	case "scifi":
		return "sci-fi"
	}
	return theme
}

// Photos is every photograph, in the order the home screen shows them.
var Photos = []Photo{
	{"ORaUWw7Na5c", "Archimedes, marble · Rome", "Blaz Erzetic", "greek", "https://images.unsplash.com/photo-1575379972039-e4dcfa0539ca", nil},
	{"GlkROV0KsmE", "Alexander the Great, marble · Athens", "Alex Sanzio", "greek", "https://images.unsplash.com/photo-1705700585343-551cfa3a0c65", nil},
	{"gYrYa37fAKI", "E = mc² and friends, on a chalkboard", "Artturi Jalli", "math", "https://images.unsplash.com/photo-1636466497217-26a8cbeaf0aa", nil},
	{"TXWbwRlIdnY", "The Parthenon, Athens", "Amir Hanna", "greek", "https://images.unsplash.com/photo-1567748533376-a0598c1a6991", nil},
	{"y9H2d4m36pI", "Homer, bronze", "Birmingham Museums Trust", "greek", "https://images.unsplash.com/photo-1719257726973-60ce7f126f55", nil},
	{"8z2Q6XWLYa4", "A drawing compass", "Jeff Sheldon", "math", "https://images.unsplash.com/photo-1416339158484-9637228cc908", nil},
	{"KTQgb5lcAHw", "Equations, read slowly", "Vitaly Gariev", "math", "https://images.unsplash.com/photo-1758685734268-003e12ca57bc", nil},
	{"tVXHmtHhsIg", "The Parthenon in grey", "David Watkis", "greek", "https://images.unsplash.com/photo-1567870518898-40273c6d58a3", nil},
	{"4dXO2xAzRQk", "A proof in progress", "Vitaly Gariev", "math", "https://images.unsplash.com/photo-1758685734303-e85757067f28", nil},
	{"8TttTCQLUKw", "Data blocks in violet light · 3D", "Brecht Corbeel", "scifi", "https://images.unsplash.com/photo-1650954933593-6c9342ba0331", nil},
	{"tGGuWW28-5M", "A circuit city, lit from within · 3D", "A Chosen Soul", "scifi", "https://images.unsplash.com/photo-1735744583234-ff1829001965", nil},
	{"6XfBmLfaS-k", "A coder's room at night · isometric", "ANTIPOLYGON YOUTUBE", "scifi", "https://images.unsplash.com/photo-1661867011861-671e1cd85cc2", nil},
	{"KZzPoMs5eIQ", "Lift-off from the chip · isometric", "Omar:. Lopez-Rincon", "scifi", "https://images.unsplash.com/photo-1744470680770-7db82336ca27", nil},
	{"m5HRQlDWDx4", "The violet core · 3D", "LekoArts", "scifi", "https://images.unsplash.com/photo-1684395646154-19832d6265b3", nil},
	{"SZcLtU9NcBI", "The machine that mints · isometric", "Tran Mau Tri Tam ✪", "scifi", "https://images.unsplash.com/photo-1647331311387-9cca489b53f2", nil},
	{"M3T9qfa_kDQ", "Neon city, made in Blender", "Bojun Liu", "scifi", "https://images.unsplash.com/photo-1732631486925-8f7e9924f993", nil},
	// Abstract, future-themed: 3D renders and light, chosen for how they sit behind the screen.
	{"ERcQ81KaX9g", "Teal glass, folding · 3D", "Pawel Czerwinski", "abstract", "https://images.unsplash.com/photo-1669295384050-a1d4357bd1d7", nil},
	{"E8Ufcyxz514", "Violet and blue tides · 3D", "Milad Fakurian", "abstract", "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe", nil},
	{"_nWaeTF6qo0", "Blue fluid, lit from within · 3D", "Richard Horvath", "abstract", "https://images.unsplash.com/photo-1620121692029-d088224ddc74", nil},
	{"EnmaBpSJOLY", "Golden dunes of points · 3D", "Zach M", "abstract", "https://images.unsplash.com/photo-1784229131433-8e8e0a243284", nil},
	{"qCYKtOov--s", "An ember on a dark curve · 3D", "Milad Fakurian", "abstract", "https://images.unsplash.com/photo-1668450433152-e56d7e8fe4ee", nil},
	{"NPDRGf0w1lw", "A mesh of points, rising · 3D", "jonakoh _", "abstract", "https://images.unsplash.com/photo-1757898023680-df17835d6b18", nil},
	{"seA-FPPXL-M", "A violet wave in the dark · 3D", "Milad Fakurian", "abstract", "https://images.unsplash.com/photo-1637825891028-564f672aa42c", nil},
	{"FAlYVtV1kRg", "Dusk on glass ribbons · 3D", "Pawel Czerwinski", "abstract", "https://images.unsplash.com/photo-1668681919287-7367677cdc4c", nil},
	{"nY14Fs8pxT8", "A pink flare in violet · 3D", "Milad Fakurian", "abstract", "https://images.unsplash.com/photo-1620641788421-7a1c342ea42e", nil},
	{"Wa-3T6d0rBo", "Neon diamonds, nested", "Martin Martz", "abstract", "https://images.unsplash.com/photo-1689443111130-6e9c7dfd8f9e", nil},
	{"56xiC0jUiQ0", "A tunnel of orange light · 3D", "MJH SHIKDER", "abstract", "https://images.unsplash.com/photo-1634834300387-8015d9fb7550", nil},
	{"2JQedxaCSrY", "Rings of blue light", "Egor Komarov", "abstract", "https://images.unsplash.com/photo-1676068646516-5eda1745a641", nil},
	{"EqmpRHOBVak", "Crystal city, violet and cyan · 3D", "Risto Kokkonen", "abstract", "https://images.unsplash.com/photo-1648291308119-ec5a5df0bed8", nil},
	{"2yClsTFXIcE", "Iridescent prisms in a grid · 3D", "and machines", "abstract", "https://images.unsplash.com/photo-1660165458059-57cfb6cc87e5", nil},
	{"ua-hS7JRu2g", "A violet planet at dawn", "Wisnu Amaludin", "abstract", "https://images.unsplash.com/photo-1679210208332-a58e411412ab", nil},
	{"ecG_8SmdOK8", "Green and red light, crossing", "Rostislav Uzunov", "abstract", "https://images.unsplash.com/photo-1739588589478-928d9f1f0f8c", nil},
	{"9XngoIpxcEo", "Pink and violet particles", "Jr Korpa", "abstract", "https://images.unsplash.com/photo-1563089145-599997674d42", nil},
	{"tJQlnPt1YuQ", "Light at warp speed", "Zoha Gohar", "abstract", "https://images.unsplash.com/photo-1769762831308-bd5e5248de3b", nil},
	{"u8Jn2rzYIps", "Pink and violet silk · 3D", "Milad Fakurian", "abstract", "https://images.unsplash.com/photo-1620207418302-439b387441b0", nil},
	{"jy6BJNpEPHI", "Red smoke in the dark", "Jr Korpa", "abstract", "https://images.unsplash.com/photo-1568781269551-3e3baf5ec909", nil},
	{"S5iAZrTM3Lg", "Night glass, folding · 3D", "Pawel Czerwinski", "abstract", "https://images.unsplash.com/photo-1658660854207-8886b1d69bb8", nil},
	{"iSaDQdcPozk", "Liquid colour · 3D", "vackground.com", "abstract", "https://images.unsplash.com/photo-1636955779321-819753cd1741", nil},
	{"V558Lx_ji6I", "A green curve on black · 3D", "Pawel Czerwinski", "abstract", "https://images.unsplash.com/photo-1710438399422-2fca27686bcd", nil},
	{"7og8GybWcZw", "Black ribbons, lit at the edge · 3D", "Andrew Kliatskyi", "abstract", "https://images.unsplash.com/photo-1678366633407-7f49da199a42", nil},
	{"Li56AhRlcI8", "Amber curves at night · 3D", "Pawel Czerwinski", "abstract", "https://images.unsplash.com/photo-1709377195538-5522ed0f9e10", nil},
	{"6-rgE3WSEio", "A golden wave of points · 3D", "BoliviaInteligente", "abstract", "https://images.unsplash.com/photo-1760978631985-590e3b5f4057", nil},
	{"V887IwnwgQI", "Lightning in neon · 3D", "Enis Can Ceyhan", "abstract", "https://images.unsplash.com/photo-1653549892920-8c333905ca3b", nil},
	// Generated by Friday (art.go): no file, no licence, any size.
	{"art-synthwave", "Synthwave horizon", "Friday", "abstract", "", artSynthwave},
	{"art-aurora", "Aurora over the hills", "Friday", "abstract", "", artAurora},
	{"art-horizon", "Event horizon", "Friday", "abstract", "", artEventHorizon},
	{"art-lattice", "A lattice of points, waving", "Friday", "abstract", "", artLattice},
	{"art-nebula", "Nebula", "Friday", "abstract", "", artNebula},
	{"art-silk", "Glass ribbons", "Friday", "abstract", "", artSilk},
	{"art-tunnel", "Neon tunnel", "Friday", "abstract", "", artTunnel},
	{"art-neon", "Liquid neon", "Friday", "abstract", "", artChrome},
}

// Generated reports whether the picture is drawn by code rather than a photograph.
func (p Photo) Generated() bool { return p.Art != nil }

// URL is the photo's page on Unsplash, with the referral Unsplash asks apps to send; empty for a
// generated picture, which has no page.
func (p Photo) URL() string {
	if p.Generated() {
		return ""
	}
	return "https://unsplash.com/photos/" + p.ID + "?utm_source=archymedes&utm_medium=referral"
}

// ArtScheme is the URL scheme a generated picture is fetched by (see HTTPClient).
const ArtScheme = "friday-art"

// Full is the picture at width pixels: a JPEG from Unsplash's CDN, never wider than the original;
// for a generated picture, a friday-art:// address that HTTPClient answers by drawing it.
func (p Photo) Full(width int) string {
	if p.Generated() {
		return fmt.Sprintf("%s://%s?w=%d", ArtScheme, p.ID, width)
	}
	return fmt.Sprintf("%s?w=%d&q=80&fm=jpg&fit=max", p.CDN, width)
}

// Credit is the attribution line: the photographer, on Unsplash; or that Friday drew it.
func (p Photo) Credit() string {
	if p.Generated() {
		return "Generated by Friday"
	}
	return "Photo: " + p.By + " / Unsplash"
}

// Byline is the short credit under a picture: "by <photographer> · Unsplash", or "drawn by Friday".
func (p Photo) Byline() string {
	if p.Generated() {
		return "drawn by Friday"
	}
	return "by " + p.By + " · Unsplash"
}

// builtInSize is the size a generated picture is drawn at for the wallpaper and previews: about
// the shipped photos' size, enough for two pixels a cell in a wide terminal.
const builtInWidth, builtInHeight = 400, 250

var (
	decodeMu sync.Mutex
	decoded  = map[string]image.Image{}
)

// Image is the built-in copy: the shipped photo decoded, or the generated picture drawn; once each.
func (p Photo) Image() (image.Image, error) {
	decodeMu.Lock()
	defer decodeMu.Unlock()
	if img, ok := decoded[p.ID]; ok {
		return img, nil
	}
	var img image.Image
	if p.Generated() {
		img = p.Art(builtInWidth, builtInHeight)
	} else {
		data, err := files.ReadFile("photos/" + p.ID + ".jpg")
		if err != nil {
			return nil, err
		}
		if img, _, err = image.Decode(bytes.NewReader(data)); err != nil {
			return nil, err
		}
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

// Wallpaper is the n-th wallpaper (wrapping either way): antiquity, sci-fi and abstract taking
// turns, so the screen keeps moving between the worlds the name spans rather than staying in one.
// The shorter themes repeat while the longest runs through, so every theme comes round every
// third turn.
func Wallpaper(n int) Photo {
	var lists [][]Photo
	longest := 0
	for _, theme := range Themes {
		if list := ofTheme(theme); len(list) > 0 {
			lists = append(lists, list)
			longest = max(longest, len(list))
		}
	}
	if len(lists) == 0 {
		return Pick(n)
	}
	turns := len(lists) * longest
	n %= turns
	if n < 0 {
		n += turns
	}
	list := lists[n%len(lists)]
	return list[(n/len(lists))%len(list)]
}

// WallpaperOf is the n-th wallpaper of one theme (wrapping either way); Wallpaper(n) when the
// theme has none.
func WallpaperOf(theme string, n int) Photo {
	list := ofTheme(theme)
	if len(list) == 0 {
		return Wallpaper(n)
	}
	n %= len(list)
	if n < 0 {
		n += len(list)
	}
	return list[n]
}

func ofTheme(theme string) []Photo {
	var out []Photo
	for _, p := range Photos {
		if p.Theme == theme {
			out = append(out, p)
		}
	}
	return out
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
