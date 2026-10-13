# A desktop for the agent

Reusable prompt for the Go interface's shell. Written 2026-10-13 from the user's request: "things
should be close at hand, easy to reach … not heavily configured and even so let it be easy to set
the keys … create a whole new interface, think OS like interface, intuitive". Track it as WS-9 in
[TRACKER.md](../TRACKER.md); [GO_DESIGN_PASS.md](GO_DESIGN_PASS.md)'s invariants still hold (every
frame exactly fits, colours only from theme roles, files under 400 lines, tested at every size).

Turn the interface from a chat with hidden extras into a desktop whose every tool is one key or one
click away, without anything to configure first. The model is an operating system's, because people
already know it: a bar along the top that says where you are and what is open, a dock along the
bottom that shows what you can open, windows for the things you work in, dialogs for the things you
answer, and a start menu that finds anything by typing. Nothing is discovered by reading help: if a
thing can be done, it is drawn somewhere with its key beside it.

The top bar is the menu bar and the system tray. On the left, a `◇` start button and one tab per
open window (Chat always first; then Files, a reader per file or search, Keys…), the focused one
filled. On the right, the tray: mode, model, and while a turn runs, the spinner with its elapsed
time; idle, the session's tokens. The dock is the bottom row: Chat, Files, Search, Sessions, Models,
Themes, Keys, Help — each an icon, a word and its key (F1–F8 by default), dimmed to icon-and-key when
the row is narrow, every one clickable. Windows are full-width (a terminal is too small for overlap):
alt+←/→ (and a click on a tab) switch, ctrl+w closes, and Chat cannot be closed. Dialogs — approval,
model and session pickers, themes, first-run setup — float over the focused window as they do now.

The start menu replaces the palette and is the one place to find anything: ctrl+space (and ctrl+p,
and a click on `◇`) opens it with the input focused; typing filters across sections — Apps (the
dock's windows), Actions (every command, with its key), Recent sessions, and Files once the project
has been listed — with fuzzy ranking, arrows to move, enter to open. It is how someone who knows no
keys still reaches everything, and each row teaches the key that would have reached it directly.

Keys are a window, not a file. The Keys app lists every action by group with its current key; enter
on a row says "press the new key", the next key pressed becomes the binding, a key already used
elsewhere is named and the change refused until resolved, `r` resets one action and `R` all of them,
and every change applies at once — the dock, the help, the start menu and dispatch all read the same
table. Bindings persist in `keys.json` beside the TS CLI's `settings.json` in the same config
directory (`ARCHYMEDES_CONFIG_DIR`, else the platform's: `~/.config/archymedes`, Application
Support, `%APPDATA%`), holding only what was changed; a missing or broken file means the defaults.
Line editing keys (ctrl+a/e/k/u/w, arrows in the input) and esc/enter are not rebindable, so a bad
binding can never lock someone out of typing or out of the Keys app.

Prove it the way this interface is proved: a model with no configuration shows the bar, dock and
landing; every dock item and tab responds to its key and to a click; windows open, switch, close and
keep their state; the start menu finds an app, an action, a session and a file; a rebinding in the
Keys app changes dispatch, the dock label and the saved file, survives a restart, refuses a conflict
and resets; the frame-fit invariant holds for the shell at every size with every window and dialog.
Then the PTY suite through the real agent, real screens at 120x32, 100x30 and 50x16, and
`bun run release:check`.
