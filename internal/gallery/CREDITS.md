# Photo credits

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

The `greek` photos and the `scifi` renders take turns as the wallpaper (behind the whole screen,
`internal/tui/wallpaper.go`).
Each was checked to be under the free Unsplash License, not Unsplash+, on 2026-10-15, and shipped
at at most 400 px: the wallpaper is drawn two pixels to a cell, so even a 250-column window needs
no more. Artwork from ArtStation or Behance is not included: it is all rights reserved unless its
artist says otherwise, and a credit line is not a licence.
