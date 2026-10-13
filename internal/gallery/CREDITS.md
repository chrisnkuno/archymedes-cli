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
| [GlkROV0KsmE](https://unsplash.com/photos/GlkROV0KsmE) | Alexander the Great, marble · Athens | Alex Sanzio | greek |
| [gYrYa37fAKI](https://unsplash.com/photos/gYrYa37fAKI) | E = mc² and friends, on a chalkboard | Artturi Jalli | math |
| [TXWbwRlIdnY](https://unsplash.com/photos/TXWbwRlIdnY) | The Parthenon, Athens | Amir Hanna | greek |
| [MgtHZ4zlC1U](https://unsplash.com/photos/MgtHZ4zlC1U) | Code on a monitor | Markus Spiske | code |
| [y9H2d4m36pI](https://unsplash.com/photos/y9H2d4m36pI) | Homer, bronze | Birmingham Museums Trust | greek |
| [8z2Q6XWLYa4](https://unsplash.com/photos/8z2Q6XWLYa4) | A drawing compass | Jeff Sheldon | math |
| [embsBhLrjPU](https://unsplash.com/photos/embsBhLrjPU) | At the microscope | CDC | science |
| [KTQgb5lcAHw](https://unsplash.com/photos/KTQgb5lcAHw) | Equations, read slowly | Vitaly Gariev | math |
| [tVXHmtHhsIg](https://unsplash.com/photos/tVXHmtHhsIg) | The Parthenon in grey | David Watkis | greek |
| [4dXO2xAzRQk](https://unsplash.com/photos/4dXO2xAzRQk) | A proof in progress | Vitaly Gariev | math |
| [VkITYPupzSg](https://unsplash.com/photos/VkITYPupzSg) | A stereo microscope | Pawel Czerwinski | science |

The drawing compass photo (`8z2Q6XWLYa4`) is cropped to the compass. To add one: put the resized
JPEG in `photos/`, add it to `Photos` in `gallery.go` and here; `go test ./internal/gallery` checks
that every file is listed, decodes, and is credited.
