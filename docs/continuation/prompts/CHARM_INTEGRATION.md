# Charm ecosystem integration pass

Reusable prompt for widening what the Go interface takes from the Charm ecosystem. Written
2026-10-13 after reading, at source: `charmbracelet/bubbletea` (README, "Libraries we use with
Bubble Tea"), `bubbles` v2.2.1 (every component directory, including the undocumented `tree`),
`lipgloss` v2.0.6 (README: colours, underline styles, hyperlinks, compositing, blending, `table`,
`list`, `tree`), `glow` v3 (its `ui/pager.go`, stash and config), `glamour` v2, `huh` v2,
`harmonica`, `log` v2, and the community libraries Bubble Tea names: `lrstanley/bubblezone` (v2,
Bubble Tea v2) and `NimbleMarkets/ntcharts` (still Bubble Tea v1). Track it as WS-8 in
[TRACKER.md](../TRACKER.md) before coding, and keep [GO_DESIGN_PASS.md](GO_DESIGN_PASS.md)'s
invariants: every frame exactly fits, colours only from theme roles, files under 400 lines.

You are making Archymedes's Go interface use the parts of the Charm stack that turn it from a chat
window into a workspace, and you are choosing them by what a person doing coding work needs, not by
what is available. The interface already uses Bubble Tea v2's declarative view (alt screen, program
status, progress bar), Bubbles' `textarea`, `textinput`, `spinner`, `help` and `key`, Lip Gloss's
compositor, gradients and borders, and Glamour for replies. The gaps that matter are the ones the
terminal CLI had and this interface dropped: reading a long session back and searching it (`/pager`,
`/find`), looking around the project and handing a file to the agent (`/files`, `/cat`), and seeing
tool output that is too long for its card without flipping every card open at once. Each of those has
a component built for it, and the work is to use that component in this interface's idiom — one
top-level model, components as plain structs it calls, overlays placed by a `lipgloss.NewCompositor`
— rather than nesting Bubble Tea programs inside each other.

Build the pager on Glow's design with Bubbles' `viewport`. Glow's pager is a viewport over rendered
markdown with a status bar, help, and copy; this one is a full-screen view over the transcript as it
is drawn (same widths, same colours), opened with `/pager` or ctrl+f, with a line-number gutter from
`viewport.LeftGutterFunc` and `SoftWrap` on. Search is `/` inside it (and `/find <text>` from the
composer): matches are found on the escape-stripped lines, the view jumps with `EnsureVisible`,
`n`/`N` move between them, and a status line says "3 of 17". Do not hand styled content to
`viewport.SetHighlights`: in v2.2.1 its ranges are offsets into stripped text while its line counting
reads the styled string, so on coloured content it marks the wrong place. Highlight matched lines
yourself, from their stripped text, with a theme tint. `c` copies the whole transcript as plain text
through OSC 52 (`tea.SetClipboard`), which works over SSH where a native clipboard does not.

Build the project view on Bubbles' `tree`, which is new in v2 and wraps Lip Gloss's `tree` with
cursor, open/close and scrolling. `/files` opens it over the project the agent works in: directories
open and close in place, files are leaves, and anything `git` ignores is left out (ask `git ls-files
--cached --others --exclude-standard`, and fall back to a bounded walk that skips `.git`,
`node_modules` and dot-directories outside a repository). Enter on a file opens it in the pager's
viewport with Glamour's code rendering for its language; `@` inserts `@path` into the composer, which
is how the agent is given a file, and closes the view. `/cat <path>` opens that file straight in the
viewer. Long listings from the `list_files` tool are drawn with `lipgloss/tree` instead of as raw
lines, so a directory reads as one.

Use the Lip Gloss features that make the transcript act like a document. File paths in tool cards and
URLs anywhere become OSC 8 hyperlinks (`Style.Hyperlink`) — clickable in terminals that support it,
plain text where not. Errors under a tool card get `UnderlineCurly` in the error colour only where
the terminal can draw it (colour profile above ANSI), never as the only signal. The agent's plan
(`/todos`) is a `lipgloss/list` with a custom enumerator (✓ ◐ ○) so wrapped items indent under their
text. The cost report and the model list keep their data but the model picker's rows align through
fixed columns; do not adopt `bubbles/table` where the content is a filterable picker, because table's
navigation and the picker's fuzzy filter fight over the same keys.

Make the mouse precise rather than merely scrollable, and make motion physical. With the mouse on,
a click on a tool card's header toggles that card's output (per card, not the global ctrl+o), a click
on a toast dismisses it, and a click on a palette, model, resume or file row chooses it. BubbleZone v2
was considered and rejected for this: its zone positions are stored asynchronously by a worker after
`Scan`, so a click right after a redraw can hit the previous layout, and its markers do not survive
the compositor. The transcript already knows which item drew which row, so a row-to-item map built
during `window()` is exact; overlays map rows from their own layout. Scrolling with PgUp/PgDn, the
wheel and search jumps is animated with Harmonica's critically damped spring (`harmonica.NewSpring
(harmonica.FPS(60), 6, 1)`): fast, no overshoot, and finished in about a fifth of a second. The tick
runs only while the spring moves, and `ARCHYMEDES_REDUCE_MOTION=1` (and the absence of a terminal
that draws smoothly, such as under CI) jumps instead.

Use the rest only where it carries its weight. `charm.land/log/v2` writes a structured debug log when
`ARCHYMEDES_DEBUG_LOG=<file>` is set — screen changes, agent messages, key routing — never to the
terminal, which belongs to the interface. Bubbles `progress` shows a provider retry's countdown, the
one place the interface knows a fraction. `huh` is the right tool for a multi-field form, but the
first-run setup is a choice and one secret, already accessible through plain keys; adopt `huh` when a
real form arrives (native settings), not to replace working code. `ntcharts` is out: it is built on
Bubble Tea v1 and would pull a second Lip Gloss into the binary; Lip Gloss's canvas and `Blend1D`
draw anything the interface needs to chart. Verify every addition the way the interface is verified:
unit tests on the component in isolation, the frame-fit invariant extended to each new view at every
size, PTY tests through the real agent for `/files` → `@path` → a turn that reads the file and for
`/pager` search, a look at real screens at 100x30 and 50x16, and `bun run release:check` before
committing. Record what each integration does, and what was rejected and why, in the tracker.
