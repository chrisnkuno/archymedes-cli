# Picture credits

The photographs in `photos/` are from [Unsplash](https://unsplash.com) and are used under the
[Unsplash License](https://unsplash.com/license): free to use, with no permission needed. Attribution
is not required by the license; the interface credits each photographer wherever a photo is drawn
anyway, linked to the photo's page. Each was checked to be under the free Unsplash License (not
Unsplash+) on 2026-10-14, and resized to at most 360 px for shipping in the binary. The Gallery
loads the full-resolution photo from Unsplash's image CDN (`images.unsplash.com`, hotlinked as
Unsplash asks, never re-hosted) unless `ARCHYMEDES_PHOTOS=local`.

| Photo | What it shows | Photographer | Theme |
| --- | --- | --- | --- |
| [ORaUWw7Na5c](https://unsplash.com/photos/ORaUWw7Na5c) | Archimedes, marble · Rome | Blaz Erzetic | greek |
| [GlkROV0KsmE](https://unsplash.com/photos/GlkROV0KsmE) | Alexander the Great, marble · Athens | Alex Sanzio | greek |
| [gYrYa37fAKI](https://unsplash.com/photos/gYrYa37fAKI) | E = mc² and friends, on a chalkboard | Artturi Jalli | math |
| [TXWbwRlIdnY](https://unsplash.com/photos/TXWbwRlIdnY) | The Parthenon, Athens | Amir Hanna | greek |
| [y9H2d4m36pI](https://unsplash.com/photos/y9H2d4m36pI) | Homer, bronze | Birmingham Museums Trust | greek |
| [8z2Q6XWLYa4](https://unsplash.com/photos/8z2Q6XWLYa4) | A drawing compass | Jeff Sheldon | math |
| [KTQgb5lcAHw](https://unsplash.com/photos/KTQgb5lcAHw) | Equations, read slowly | Vitaly Gariev | math |
| [tVXHmtHhsIg](https://unsplash.com/photos/tVXHmtHhsIg) | The Parthenon in grey | David Watkis | greek |
| [4dXO2xAzRQk](https://unsplash.com/photos/4dXO2xAzRQk) | A proof in progress | Vitaly Gariev | math |

The Archimedes bust (`ORaUWw7Na5c`) is cropped to the head and its inscription, the drawing compass
(`8z2Q6XWLYa4`) to the compass. To add one: put the resized
JPEG in `photos/`, add it to `Photos` in `gallery.go` and here; `go test ./internal/gallery` checks
that every file is listed, decodes, and is credited.
| [8TttTCQLUKw](https://unsplash.com/photos/8TttTCQLUKw) | Data blocks in violet light · 3D | Brecht Corbeel | scifi |
| [tGGuWW28-5M](https://unsplash.com/photos/tGGuWW28-5M) | A circuit city, lit from within · 3D | A Chosen Soul | scifi |
| [6XfBmLfaS-k](https://unsplash.com/photos/6XfBmLfaS-k) | A coder's room at night · isometric | ANTIPOLYGON YOUTUBE | scifi |
| [KZzPoMs5eIQ](https://unsplash.com/photos/KZzPoMs5eIQ) | Lift-off from the chip · isometric | Omar:. Lopez-Rincon | scifi |
| [m5HRQlDWDx4](https://unsplash.com/photos/m5HRQlDWDx4) | The violet core · 3D | LekoArts | scifi |
| [SZcLtU9NcBI](https://unsplash.com/photos/SZcLtU9NcBI) | The machine that mints · isometric | Tran Mau Tri Tam ✪ | scifi |
| [M3T9qfa_kDQ](https://unsplash.com/photos/M3T9qfa_kDQ) | Neon city, made in Blender | Bojun Liu | scifi |

The `greek` photos, the `scifi` renders and the `abstract` pictures take turns as the wallpaper
(behind the whole screen, `internal/tui/desk_wallpaper.go`); `/wallpaper` can also keep to one
theme, or one picture.
Each was checked to be under the free Unsplash License, not Unsplash+, on 2026-10-15, and shipped
at at most 400 px: the wallpaper is drawn two pixels to a cell, so even a 250-column window needs
no more. Artwork from ArtStation or Behance is not included: it is all rights reserved unless its
artist says otherwise, and a credit line is not a licence.


## Abstract, future-themed

Chosen on 2026-10-23 for how they sit dimmed behind text: dark, saturated 3D renders, light and
glass. Each photo's own page was checked that day and says "Free to use under the Unsplash License"
(all are on the free CDN, `images.unsplash.com/photo-…`; Unsplash+ pictures are served from
`plus.unsplash.com/premium_…` and none is used). Shipped at at most 400 px on either side.

| Photo | What it shows | Photographer | Theme |
| --- | --- | --- | --- |
| [ERcQ81KaX9g](https://unsplash.com/photos/ERcQ81KaX9g) | Teal glass, folding · 3D | Pawel Czerwinski | abstract |
| [E8Ufcyxz514](https://unsplash.com/photos/E8Ufcyxz514) | Violet and blue tides · 3D | Milad Fakurian | abstract |
| [_nWaeTF6qo0](https://unsplash.com/photos/_nWaeTF6qo0) | Blue fluid, lit from within · 3D | Richard Horvath | abstract |
| [EnmaBpSJOLY](https://unsplash.com/photos/EnmaBpSJOLY) | Golden dunes of points · 3D | Zach M | abstract |
| [qCYKtOov--s](https://unsplash.com/photos/qCYKtOov--s) | An ember on a dark curve · 3D | Milad Fakurian | abstract |
| [NPDRGf0w1lw](https://unsplash.com/photos/NPDRGf0w1lw) | A mesh of points, rising · 3D | jonakoh _ | abstract |
| [seA-FPPXL-M](https://unsplash.com/photos/seA-FPPXL-M) | A violet wave in the dark · 3D | Milad Fakurian | abstract |
| [FAlYVtV1kRg](https://unsplash.com/photos/FAlYVtV1kRg) | Dusk on glass ribbons · 3D | Pawel Czerwinski | abstract |
| [nY14Fs8pxT8](https://unsplash.com/photos/nY14Fs8pxT8) | A pink flare in violet · 3D | Milad Fakurian | abstract |
| [Wa-3T6d0rBo](https://unsplash.com/photos/Wa-3T6d0rBo) | Neon diamonds, nested | Martin Martz | abstract |
| [56xiC0jUiQ0](https://unsplash.com/photos/56xiC0jUiQ0) | A tunnel of orange light · 3D | MJH SHIKDER | abstract |
| [2JQedxaCSrY](https://unsplash.com/photos/2JQedxaCSrY) | Rings of blue light | Egor Komarov | abstract |
| [EqmpRHOBVak](https://unsplash.com/photos/EqmpRHOBVak) | Crystal city, violet and cyan · 3D | Risto Kokkonen | abstract |
| [2yClsTFXIcE](https://unsplash.com/photos/2yClsTFXIcE) | Iridescent prisms in a grid · 3D | and machines | abstract |
| [ua-hS7JRu2g](https://unsplash.com/photos/ua-hS7JRu2g) | A violet planet at dawn | Wisnu Amaludin | abstract |
| [ecG_8SmdOK8](https://unsplash.com/photos/ecG_8SmdOK8) | Green and red light, crossing | Rostislav Uzunov | abstract |
| [9XngoIpxcEo](https://unsplash.com/photos/9XngoIpxcEo) | Pink and violet particles | Jr Korpa | abstract |
| [tJQlnPt1YuQ](https://unsplash.com/photos/tJQlnPt1YuQ) | Light at warp speed | Zoha Gohar | abstract |
| [u8Jn2rzYIps](https://unsplash.com/photos/u8Jn2rzYIps) | Pink and violet silk · 3D | Milad Fakurian | abstract |
| [jy6BJNpEPHI](https://unsplash.com/photos/jy6BJNpEPHI) | Red smoke in the dark | Jr Korpa | abstract |
| [S5iAZrTM3Lg](https://unsplash.com/photos/S5iAZrTM3Lg) | Night glass, folding · 3D | Pawel Czerwinski | abstract |
| [iSaDQdcPozk](https://unsplash.com/photos/iSaDQdcPozk) | Liquid colour · 3D | vackground.com | abstract |
| [V558Lx_ji6I](https://unsplash.com/photos/V558Lx_ji6I) | A green curve on black · 3D | Pawel Czerwinski | abstract |
| [7og8GybWcZw](https://unsplash.com/photos/7og8GybWcZw) | Black ribbons, lit at the edge · 3D | Andrew Kliatskyi | abstract |
| [Li56AhRlcI8](https://unsplash.com/photos/Li56AhRlcI8) | Amber curves at night · 3D | Pawel Czerwinski | abstract |
| [6-rgE3WSEio](https://unsplash.com/photos/6-rgE3WSEio) | A golden wave of points · 3D | BoliviaInteligente | abstract |
| [V887IwnwgQI](https://unsplash.com/photos/V887IwnwgQI) | Lightning in neon · 3D | Enis Can Ceyhan | abstract |

## Drawn by Friday

Eight abstract pictures are not photographs: they are drawn by code (`art.go`), are Friday's own,
and need no credit or licence. They are drawn at 400×250 for the wallpaper and at full size in the
Gallery, which fetches them from `friday-art://<id>?w=<width>` (answered in process by
`gallery.HTTPClient`, with no network).

| Id | Title | How it is drawn |
| --- | --- | --- |
| `art-synthwave` | Synthwave horizon | a slit sun over a perspective grid |
| `art-aurora` | Aurora over the hills | curtains of fbm-streaked light above a horizon of hills |
| `art-horizon` | Event horizon | an accretion disc, nearly edge on, around a shadow ringed by bent light |
| `art-lattice` | A lattice of points, waving | rows of dots on layered waves, nearer rows larger |
| `art-nebula` | Nebula | domain-warped fbm through a cosine palette, with stars |
| `art-silk` | Glass ribbons | bands between sweeping curves, lit by their slope |
| `art-tunnel` | Neon tunnel | rings and rails in polar coordinates, falling away |
| `art-neon` | Liquid neon | warped ridges through a shifting iridescent palette |

Artwork from Behance, ArtStation or Dribbble is not included: it is all rights reserved unless its
artist says otherwise, and a credit line is not a licence.
