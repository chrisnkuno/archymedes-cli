# Work tracker

Method: [WORKFLOW.md](WORKFLOW.md). Newest workstream first. Statuses: `todo`, `doing`, `done`, `blocked`.

Baseline at start (2026-09-14, after publishing 2.2.0): 92 theme leaks in 10 files; `archymedes.ts`
has 5,100 lines and `tui.ts` has 1,364.

## WS-1: Fixed workspace by default, proper scrolling, full theme coverage, code organization

User request (2026-09-14): make the fixed layout the default, implement proper scrolling, fix
incomplete theme application, and organize the CLI into sections with compartmentalization in mind.

| ID | Task | Status | Scope | Recheck | Evidence |
| --- | --- | --- | --- | --- | --- |
| WS-1.1 | Tracking method and `bun run recheck` with guards | done | `tooling/check/`, `docs/continuation/` | `bun run recheck` | Guard unit tests pass; baseline recorded. The first run caught a type error in its own script. `--pty` runs the whole PTY project, because `vitest related` cannot see process-spawned tests |
| WS-1.2 | Fixed layout is the default; `--layout scrollback` / `ARCHYMEDES_LAYOUT=scrollback` opt out | done | `layout-choice.ts` (new: layout resolution, `/layout` parsing, frame options), `archymedes.ts`, guide, help, READMEs | `bun run recheck --pty` | `--pin`/`ARCHYMEDES_PIN` and `TERM=dumb` imply scrollback. Scrollback-specific PTY tests now request that layout. Harness gained `flowText`/`paintContaining`, so waits ignore fixed-header repaints between streamed chunks. PTY test proves the default. `recheck --pty`: 19 PTY files / 104 tests pass; `archymedes.ts` 5,100 → 5,097 |
| WS-1.3 | Transcript scrolling in the fixed workspace: shared viewport model, line/half/page/top/bottom keys, mouse wheel, styled history, position indicator, new-output notice | done | `workspace-frame.ts`; new `transcript-rows.ts`, `transcript-keys.ts`, `wheel-input.ts` | `bun run recheck --pty` | Frame now uses `viewport.ts`. Keys: PgUp/PgDn, Alt/Ctrl+Up/Down, Ctrl+Home/End, Esc. Wheel via SGR mouse reporting, filtered before readline (`ARCHYMEDES_MOUSE=0` opts out). History keeps colour; scrollbar; `HISTORY n% +k new`. Fixed `--ascii` mode rail using `│`, and a tab switch no longer skips the repaint. 179 related unit tests pass |
| WS-1.4 | Theme coverage: route hardcoded colours through the palette | done | `theme.ts` (`roleCode`, `ANSI_PALETTE`, `EXTERNAL_MARK`), `sections.ts` (exported `toneCode`), `markdown.ts`, `tui.ts` (`MarkdownStream`, `box`, prompt bar), `code-view.ts`, `patch-view.ts`, `test-report.ts`, `pacing.ts`, `chat-history.ts`, `memory.ts`, `explain-view.ts`, `editor-screen.tsx`, `session-inspect.ts`, `archymedes.ts` | `bun run recheck --all` | Theme leaks 92 → 0; guard also catches widget `color: "red"` literals. Assistant markdown and `/cat` now follow `/theme`. Fixed the editor passing an escape code where TermUI needs a token value. `theme-coverage.test.ts` added. Full suite: 185/186 files, 2,935 tests pass. The one failure, `core/src/cli/job-store.test.ts`, is untouched and passes 3/3 alone (load flake) |
| WS-1.5 | Organize `src/` into section directories | blocked (use the new quality-pass prompt, WS-1.7) | all of `packages/archymedes-cli/src`, build tooling, tests | `bun run recheck --full` | Draft sections: terminal, theme, render, ui, commands, session, platform; entry points stay at root. No hidden path dependencies: only imports, `tooling/dev/*` and `baseline.json` point into `src/` |
| WS-1.6 | Split `archymedes.ts`: extract terminal-layout wiring and command handlers into modules | todo | `archymedes.ts` | size guard falls | |
| WS-1.7 | Reusable quality-pass prompt for sectioning, compartmentalizing and optimizing the project | done | `docs/continuation/prompts/QUALITY_PASS.md`, `.claude/commands/quality-pass.md` | Read-through; run it for WS-1.5 | |
