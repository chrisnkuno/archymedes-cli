# Charts and mouse zones

Reusable prompt for the Go interface's charts (`NimbleMarkets/ntcharts/v2`) and mouse zones
(`lrstanley/bubblezone/v2`). Written 2026-10-13 after the user asked to "integrate well the graphs"
and to adopt the two libraries [CHARM_INTEGRATION.md](CHARM_INTEGRATION.md) had left out. That
prompt's reasons were checked again at source and one was wrong: ntcharts has a v2 module
(v2.8.0, `charm.land/bubbletea/v2` and `lipgloss/v2` v2.0.6 — the same stack), only its `main`
branch is v1. Track it as WS-10 in [TRACKER.md](../TRACKER.md); the design invariants still hold.

Give the session a Stats app: one more window on the dock (F9, `▥ Stats`), drawn with ntcharts,
about the things a person watching an agent actually asks — how much is this turn costing in tokens,
is it getting slower, what is it spending its time on. Tokens per turn are a stacked bar chart (input
under output, one bar per turn, the last ones that fit), so a turn that read a huge file stands out at
a glance. Each model call's output tokens are a sparkline, which shows whether the agent is producing
or mostly reading. Turn durations are a time-series line chart (braille, so it has resolution in a
small box). Tool use is a horizontal bar chart by tool, so "it ran the tests nine times" is visible.
Every chart is coloured from theme roles, resizes with the window, and says plainly when there is no
data yet rather than drawing an empty axis. The data is what the interface already receives: usage
on each `model_turn` event, each `tool_call`, each turn's start and end; nothing new is asked of the
agent.

Put the most useful chart where it is seen without opening anything: while a turn runs, the tray
carries a small sparkline of the reply's streaming rate (characters per quarter second, the last few
seconds), so "is it still doing something" is answered by motion, not by a timer. It stops and
disappears when the turn ends; nothing animates while idle.

Adopt BubbleZone for every click target, in place of the hand-kept rectangles: the start button,
tabs and dock apps, each tool card's header, toasts, and the rows of every picker and the start menu.
Zones are marked where the thing is drawn, so a click target can never drift from what is on screen.
Two properties of the library shape how: each `Scan` clears the zones of any earlier scan on the same
manager, and a layer placed by the compositor is scanned on its own string. So use one manager per
layer — the frame, the dialog, the toasts — and scan each layer at its screen position (pad it with
its offset before scanning, so its zones come out in screen coordinates). Zones are stored by a
worker goroutine after `Scan`; a person's click arrives long after that, and tests wait for the zone
rather than assume it. Pass the frame's manager to the charts (`WithZoneManager`) so a click on a bar
selects that turn and shows its numbers. Close the managers when the program ends.

Prove it: unit tests that charts render the data they are given (a heavy turn's bar is the tallest;
tool counts in order), say "no data yet" when empty, and fit every window size; the frame-fit
invariant over the Stats window; clicks through zones on every target the old tests covered, plus a
bar; a PTY run through the real agent that opens Stats after turns and finds the turns there; real
screens at 120x32 and 50x16; `bun run release:check`.
