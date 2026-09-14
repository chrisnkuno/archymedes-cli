# Working method: track, change, recheck

This is how work on Archymedes is planned, recorded and verified, so any contributor or agent can
pick up where the last one stopped and re-verify it cheaply.

## 1. Track before changing

Every piece of work lives in [TRACKER.md](TRACKER.md) as a **workstream** (`WS-n`) with numbered
**tasks** (`WS-n.m`). Each task records:

- **Status:** `todo`, `doing`, `done`, or `blocked (reason)`. Only one task should be `doing` at a time.
- **Scope:** the files or modules it touches. Keep it narrow enough to review in one sitting.
- **Recheck:** the exact command that proves the task, usually `bun run recheck` plus any PTY test.
- **Evidence:** filled in when done, such as the test counts, guard numbers or commit hash.

Add the task before writing the code, and update the status as you go, not at the end.

## 2. Change in compartments

- New behaviour goes in a focused module with explicit inputs, not into `archymedes.ts`.
- Touching code in a large file? Extract the part you touch when that is practical.
- Rendering takes colours from the `Palette` (`theme.ts`). Never use raw ANSI colour constants.
- Pure logic (state, layout math, parsing) is separate from terminal I/O, so it can be unit-tested.
- One task, one commit. The commit message names the task ID.

## 3. Recheck at three levels

| Level | Command | When | Covers |
| --- | --- | --- | --- |
| Quick | `bun run recheck` | After each edit batch | Guards, typecheck, unit tests related to changed files |
| Terminal | `bun run recheck --pty` | After UI, input or layout changes | Adds the whole PTY project (about 4 minutes). PTY tests spawn the CLI, so the import graph cannot pick out related ones |
| Release | `bun run recheck --full` | Before a commit that closes a workstream, and before publishing | `release:check`: full suite, build, package verification |

`bun run recheck --all` runs the whole suite without packaging.

### Guards (ratchets)

`tooling/check/baseline.json` stores two counts. Each may fall but must never rise:

- **Theme leaks:** hardcoded foreground colours (`CYAN`, `\x1b[33m`, and so on) outside `ansi.ts` and
  `theme.ts`. These ignore `/theme`.
- **Large files:** source files over 800 lines, with their line counts.

After you reduce a count, run `bun run recheck --update-baseline` to lock it in. Raising a count
needs a written reason in the tracker entry.

## Structural work

For sectioning, compartmentalizing or optimizing a scope, follow the reusable prompt
[prompts/QUALITY_PASS.md](prompts/QUALITY_PASS.md). In Claude Code, run `/quality-pass <scope>`.

## 4. Close out

A task is `done` only when its recheck passed and the evidence is recorded. Once every task in a
workstream is done, run the release-level recheck and record the workstream summary in the tracker.
