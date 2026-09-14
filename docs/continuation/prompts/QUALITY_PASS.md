# Quality pass: section, compartmentalize, optimize

A reusable prompt for improving the structure and quality of this repository without changing what
it does. Run it with a scope (a section, a directory, a monolith file, or `whole project`). In Claude
Code: `/quality-pass <scope>`. Elsewhere, paste this file and fill in **Scope** and **Goal**.

---

## Role and outcome

You are the engineer responsible for making this codebase easy to change safely. Your job in this
pass is to leave the scope **organized into clear sections, split into focused modules with explicit
dependencies, and measurably faster or lighter where it matters**. User-visible behaviour stays the
same unless the goal says otherwise.

A pass succeeds when every change is recorded in the tracker, every task has passed its recheck, and
the guard counts in `tooling/check/baseline.json` have fallen or held steady.

- **Scope:** `$SCOPE` (default: `packages/archymedes-cli`)
- **Goal:** `$GOAL` (default: sections + compartmentalization + measured optimization)
- **Budget:** stop at a clean checkpoint after the tasks you can fully verify. Never leave a task half-moved.

## Non-negotiable rules

1. **Behaviour-preserving by default.** Separate structural changes (moves, extractions, renames)
   from behavioural ones, in different tasks. If a structural step needs a behaviour change, stop
   and record it as its own task.
2. **Track before touching.** Add the workstream and tasks to `docs/continuation/TRACKER.md` before
   editing code. Follow `docs/continuation/WORKFLOW.md`, with one task `doing` at a time.
3. **Verify every task.** Run `bun run recheck` after each edit batch, and `bun run recheck --pty`
   for anything that touches terminal I/O, layout, input or the entry point. Run
   `bun run recheck --full` before closing a workstream. Record the numbers as evidence.
4. **Never weaken a test to get green.** A test changes only when its *intent* still holds and the
   old assertion was checking an incidental detail. Write the reason in the tracker evidence. If you
   cannot state the intent, the code is wrong, not the test.
5. **Ratchets only move down.** Never raise a guard count to pass. If growth is truly unavoidable,
   compensate in the same task, for example by extracting an equal amount from the same file.
6. **No big-bang rewrites.** Work seam by seam. Each task should be reviewable in one sitting and
   revertible on its own.
7. **Ask the user before** changing public CLI flags, commands, environment variables or output
   formats; adding, removing or upgrading dependencies; deleting files that are not provably dead;
   committing, pushing, publishing, or touching `.private/` or other repositories.
8. **Match the repository's conventions** (naming, comment style, Bun, Vitest, colocated tests). Read
   neighbouring code before writing new code.

## Phase 0: Orient (read-only)

1. Read `docs/continuation/START_HERE.md`, `WORKFLOW.md`, `TRACKER.md` and `ARCHITECTURE.md`.
2. Run `git status --short`. Existing uncommitted work belongs to someone: do not overwrite it. If
   it overlaps the scope, ask whether to build on it.
3. Run `bun run recheck` and record the starting guard counts, test counts and any pre-existing
   failures. Rerun a failure alone before calling it flaky, and do not fix unrelated flakes silently.

## Phase 1: Map the scope (read-only)

Regenerate the module map with `python3 tooling/check/module_map.py`, which writes
`docs/continuation/MODULE_MAP.md` from the real import graph and `tooling/check/sections.json`.
For a scope outside the CLI source, produce the same table by hand. For every module record:

| Column | How to get it |
| --- | --- |
| Path, lines | `wc -l` |
| One-line responsibility | Its header comment or first export; flag modules needing "and" to describe |
| Section (proposed) | See the section model below |
| Imports in / out | `grep -rn 'from "\./'`; note the most depended-on modules |
| Smells | Mixed I/O and logic, hidden global state, duplicated helpers, raw colours, cycles, dead exports |

Then find, with evidence:

- **Cycles** between modules and between proposed sections.
- **Duplicated helpers**, such as several private copies of `paint`, `RESET`, `visibleWidth`, clipping or wrapping.
- **Monolith seams:** groups of closures or handlers in a large file that share a small, nameable
  set of inputs. Those inputs become an explicit context type.
- **Hot paths:** code that runs per keystroke, per streamed chunk, per redraw or per line of output.
- **Dead code:** exports with no importers outside their own test (confirm with grep before claiming).

## Phase 2: Design the sections

Group modules into sections with **one direction of dependency**. The current design for the CLI
is in `tooling/check/sections.json` (the enforced import matrix) and `docs/continuation/MODULE_MAP.md`
(purpose and members of each section):

`text` ← `platform` ← `catalog`/`theme` ← `terminal` ← `render` ← `ui` ← `commands` ← root entry points,
with `session` depending only on `theme`, `platform` and `text`.

Place new modules by their dependencies, not by their name. A module that fits two sections is
usually two modules: split it, or place it by its dominant dependency and note why. Change the
matrix only with reasons recorded in the tracker, and regenerate the map afterwards. For scopes
outside the CLI, design the same kind of matrix first.

## Phase 3: Plan the tasks

Add a workstream to the tracker. Order tasks from safest to riskiest:

1. **Guards first.** Extend `tooling/check/guards.ts` so the design is enforced before code moves.
   Add a layering guard (imports that break the section matrix, counted per file and ratcheted), and
   any other ratchets the map suggests, such as duplicate-helper counts. Unit-test the guard.
2. **Mechanical moves.** Use `python3 tooling/check/rewrite_imports.py move-files <mapping.json>`
   (or `move-symbols` to repoint named exports). It runs `git mv` (so history follows) and rewrites every
   relative import, including dynamic `import()` and `vi.mock()` specifiers, `tooling/dev` imports,
   package scripts and `baseline.json` paths. Moves only, no edits in the same task. Then run
   `bun run recheck --full`.
3. **Deduplicate helpers** into the owning section, one helper family per task.
4. **Extract seams from monoliths**, one seam per task:
   - Name the inputs as an explicit context type, as `session-inspect.ts` does with `InspectContext`.
   - Move pure logic into a tested module, and leave a thin call site behind.
   - Prefer parsers and renderers that return data or strings, with I/O kept at the edge.
   - Every extraction must reduce the monolith's line count, which the size guard checks.
5. **Optimize measured hot paths.** Measure before and after, and keep a change only if the numbers improve.
6. **Remove dead code** with grep evidence in the tracker.
7. **Documentation:** update `ARCHITECTURE.md`, `MODULE_MAP.md`, `START_HERE.md` and the guard baseline.

## Phase 4: Execute a task (repeat)

1. Mark the task `doing`.
2. Make the smallest change that completes it.
3. Run the recheck level the task names. On failure, find the root cause:
   - Your bug: fix the code.
   - A test asserting an incidental detail: adjust it only per rule 4, and record why.
   - A pre-existing flake: rerun it alone, record it, move on.
4. Mark it `done` with evidence: test counts, guard deltas, measurements.
5. Lock improved guard counts with `bun run recheck --update-baseline`.

## What good looks like here

- **One responsibility per module.** It is describable without "and". Aim for under 400 lines; 800
  is the guard line.
- **Pure core, thin shell.** State machines, layout arithmetic, parsing and rendering are pure and
  unit-tested. Terminal writes, key reading, timers and process hooks live in small adapters.
- **Explicit dependencies.** Pass what a module needs, as the `sectionStyle()` and `InspectContext`
  patterns do. New code does not read mutable module-level state from another module.
- **Theme through roles.** Colours come from `Palette` via `roleCode`, `toneCode` or `palette.tokens`
  (for TermUI widgets). There are no raw ANSI colours outside `theme.ts` and `ansi.ts`.
- **Terminal safety.** Every mode entered is left on every exit path (alternate screen, mouse
  reporting, scroll regions, raw mode). Input filters restore what they patch.
- **Tests at the right level.** Pure logic gets unit tests. Real terminal behaviour gets PTY tests,
  using `flowText`/`paintContaining` when repaints interleave with streamed output.

## Optimization playbook

Measure first, with the cheapest tool that answers the question:

| Question | Measure with |
| --- | --- |
| Startup and journey latency | `bun run bench:journeys` (compare `benchmarks/journeys/latest.json`) |
| Bundle size | `bun run build:packages` output size; check which modules the entry imports eagerly |
| Redraw and stream cost | A micro-benchmark over the pure function (projection, wrap, highlight) with realistic input sizes |
| Test time | Vitest duration per file; slow unit tests usually hide I/O |

Common wins in this codebase:

- Hoist per-call allocations out of hot loops, for example one shared `Intl.Segmenter`.
- Cache projections by an explicit key (log identity, size, width) instead of recomputing per redraw.
- Lazy-load full-screen views and rarely used commands with dynamic `import()`.
- Avoid O(n²) string building on long transcripts, and bound buffers.

Do not micro-optimize code that is not on a measured hot path.

## Known pitfalls (learned the hard way)

- `vitest related` follows imports, and PTY tests spawn the CLI as a process, so they are never
  selected. Use `bun run recheck --pty`.
- The fixed workspace repaints its header between streamed chunks, so raw PTY output is not
  contiguous. Match with `flowText`, or inspect the repaint with `paintContaining`.
- TermUI widgets take colour **token values** (`#e5a58c`, `cyan`), not escape codes. Passing
  `palette.accent` (an escape code) silently breaks colour.
- The size guard counts `archymedes.ts`. New imports there cost lines, so pay for them by extracting.
- A moved file keeps its tests green only if `vi.mock()` and dynamic `import()` paths moved with it.

## Report at the end of the pass

Reply with at most 15 lines:

- Tasks done, with IDs and one line each.
- Guard counts before and after (theme leaks, large files, layering violations).
- Test counts, PTY status, and any flakes observed.
- Measurements for optimization tasks.
- Blocked items and decisions needed from the user.
- The next task to run.
