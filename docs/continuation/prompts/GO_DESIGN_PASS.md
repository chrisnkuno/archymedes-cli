# Go front end design pass

Reusable prompt for raising the design of the Go terminal UI (`internal/tui`, `internal/render`,
`internal/theme`) on the Charm v2 stack. Written 2026-10-13 from the official docs and the module
sources (`charm.land/bubbletea/v2` v2.1.0, `bubbles/v2` v2.2.1, `lipgloss/v2` v2.0.6, `glamour/v2`)
and Charm's Crush. Track the work in [TRACKER.md](../TRACKER.md) (WS-6) before coding.

You are raising the Archymedes Go front end from correct to distinctive, using what the Charm v2
stack actually offers rather than hand-rolled equivalents. The UI is one Bubble Tea model with
plain-struct components (the Crush pattern: no nested `Update`s, imperative methods, render caches
keyed by width and version), drawing fixed regions on the alt screen: header, transcript, completion
list, input box, status bar. Keep that architecture. Every colour comes from a theme role in
`internal/theme`; the seven built-in palettes match the TypeScript ones and `archymedes-blue` is the
default. The identity is Archymedes's own, not Charm's: the nested-tetrahedra mark from
`packages/friday-cli/src/render/identity.ts`, a calm Solarized ground, and type that reads at a
glance. Port that mark rather than inventing a new logo, and keep a version of every view that
works on a 16-colour terminal and in a light theme (`parchment`).

Use Bubble Tea v2's declarative `tea.View` for every terminal feature, never an escape written by
hand. `View.ProgramStatus` (the OSC 7501 Program Status Protocol, new in v2.1) reports `Working`
while a turn runs, `Blocked` with `ProgramStatusKindPermission` while an approval waits, `Done` or
`Error` when a turn ends, and `Idle` otherwise, so a supporting terminal or multiplexer can show
the agent's state in a tab; `View.ProgressBar` with `ProgressBarIndeterminate` does the same for
terminals with a native progress indicator. `View.WindowTitle` carries the project name and state.
Ask for the background with `tea.RequestBackgroundColor` and use `BackgroundColorMsg.IsDark()` to
choose light or dark component styles, since the `DefaultStyles(isDark)` constructors in Bubbles v2
expect it. Unsupported terminals ignore all of these, so none of them may carry information that is
not also on screen.

Prefer Bubbles components wherever one fits. Use `spinner` (driven by its own `TickMsg`, styled from
the theme) for the working and thinking states. Use `key.Binding` for every shortcut and `help` to
render them, a context-sensitive one-line hint in the status bar (`ShortHelp`) and a full grouped
overlay (`FullHelp`) on `?` or `/help`, so keys are declared once and documented by construction.
Use `textinput` for the filter in a command palette (ctrl+p) and `textarea` for the composer.
Use `progress` with `WithColors` from the theme for things with a known fraction, such as a provider
retry's countdown. Do not swap the transcript for `viewport`: the cached item list scales with screen
height rather than session length, and that matters more than the convenience.

Build the design system in Lip Gloss v2. Gradients come from `lipgloss.Blend1D` across theme roles
(the wordmark, the rotating mark on the landing screen, a rule closing each turn). State is shown as
pills: a coloured mode badge, a provider and model chip, and status chips for tool calls (running,
done, failed). Messages get structure from borders rather than prose: the person's message behind a
thick accent left border, tool calls as cards whose output sits behind a muted rule, and diffs drawn
with tinted added and removed rows (`Blend1D` between the ground and success or error). Overlays —
approval, help, palette, theme picker with a live preview that `esc` reverts, transient toasts for
mode and theme changes — are layers placed by a `lipgloss.NewCompositor` on a `Canvas`; a bare
`Layer` ignores its own X and Y. Toasts replace transcript notices for anything that is not part of
the conversation.

Hold the invariants and prove them. Every frame is exactly the terminal's height and no row is wider
than its width, at any size from 12x3 up, with any overlay open; extend
`TestEveryFrameFitsTheTerminal` to cover each new view rather than clipping the final frame, which
would hide the bug. Tool output stays escape-stripped. Width math uses `x/ansi`, never byte length.
Animation runs only while something animates (the landing mark while the transcript is empty, the
spinner during a turn), so an idle session does not repaint. Keep files under 400 lines and pure
renderers in `internal/render`. Verify with `go test -race ./...`, the PTY test
`packages/friday-cli/src/pty/go-frontend.test.ts`, and a look at real screens at 100x30 and
50x16, then record the evidence in the tracker. Features that need the agent to do something new
(switching models, resuming from a list) are out of scope for a design pass; note them, do not fake them.
