# Archymedes CLI release assessment

TUI and release readiness reviewed 2026-09-14; original product assessment 2026-09-06. Scope: public CLI, the runtime it bundles, terminal interfaces, and npm artifacts.
Private hosted services are separate products with separate release requirements.

## Product judgment

Archymedes has enough capability for a useful public release. The strongest proposition is an
inspectable coding workspace: guarded execution, recoverable edits, explicit cost, and durable
history. The next gains should come from making those properties easy to understand and dependable
in an installed package. A broad feature list alone does not establish category leadership.

The current code supports local/Docker/E2B workspaces, model selection, approval modes, checkpoints,
memory, resume, detached jobs, an editor protocol, and interactive file/workspace views. The runtime
already separates provider adapters from tools and session state. Many behaviors have unit and
pseudo-terminal coverage. Keep these foundations.

## Findings and changes in this release

| Finding | Change | Why it matters |
| --- | --- | --- |
| Startup used an independently colored starfield and awaited decorative animation | Static, symmetric graduated-ring identity in the selected palette; six rows or a three-row compact form; the reliability, currency and session-modifier lines collapsed into one dim context line | Recognizable identity with less startup chrome and no animation wait; the always-present metadata is one line, and only the lines that ask for a decision keep their own row |
| Composer and turn status line hardcoded cyan; inline border choice was captured at construction | Composer and `formatStatusLine`/`StatusBar` read the current palette, including mode colors and border style | `/theme` affects the input surface and the persistent activity line, not only transcript text |
| No named default connected the visual system directly to the product | `archymedes`: bronze, limestone, olive and charcoal; older themes retained | A distinctive default without losing customization or light-terminal support |
| Every result card said “turn complete” | Status-specific titles; failed checks use the error tone; green requires recorded passing checks | A failed or unverified task should not look successfully verified |
| Changed-file handoffs lacked nearby review actions | `/diff` and `/undo` in the result card | The next step is available at the point it is needed |
| Startup claimed ongoing improvement from a bundled historical score | Dated bundled-benchmark label, bounded width, non-finite score fallback | Evidence should say what was measured |
| Workspace tests did not establish tarball installability | Archive allowlist, isolated install, Node startup, external TUI import smoke, SHA256 | Validate the actual distributable |
| No checked-in CI workflow | Linux tests plus Linux/macOS/Windows build and package-smoke jobs | Repeatable checks for future releases; remote execution still needs proof |
| Package README contradicted its Apache license; attribution and language docs were omitted from the CLI archive | README corrected; existing NOTICE copied to distributable packages; CLI includes I18N.md | Package metadata and included documentation agree |
| Ignore rules still named Nova state paths only | Ignore Archymedes local session state, Rust target, release artifacts | Local state and build products stay outside source changes |
| The only journey evidence was a stale single-model reliability report | `bench:journeys` times five installed journeys under a real pty against a deterministic stub, small and large repos, into `benchmarks/journeys/latest.json`; a lean pass guards against regressions in the suite | A dependability claim needs a repeatable measurement of the product, not just of a model's answers |
| No acceptance coverage past node-pty, and no failure-recovery measurement | `pty/acceptance.test.ts` (tmux turn + clean exit, CJK/emoji to the model verbatim, bracketed-paste stripping) and `pty/recovery.test.ts` (mid-stream disconnect, SIGKILL with a tool applied, double Ctrl+C); stub gained a `disconnect` turn | Establishes what holds under a multiplexer and under an unclean failure — and surfaced two gaps: newline pastes split, and resuming an interrupted turn is best-effort (turn-atomic checkpoints) |
| No single view of where a task stands — request, plan, changes and verification were four separate commands | `/task` (`task-view.ts`) assembles all four plus the blockers, each row naming the command that acts on it | Review, not the last streamed paragraph, is where a turn is judged done |
| The REPL loop's ~40 command handlers all close over `main()`'s locals, so none can be moved or tested in isolation | `session-inspect.ts` lifts `/task` and `/todos` out behind an explicit snapshot; `pty/orchestration.test.ts` pins their read-only-ness | Opens the seam every later handler extraction hangs off, starting with the two that cannot have side effects |
| The hosted exchange returned a `routing_receipt` the client discarded, and sent a hardcoded `kind: "coding"` profile | `providers/routing-receipt.ts` parses the receipt (defensively — it is a network peer) and builds the task profile; the runtime carries receipts on `AgentRuntimeResult`; `/route` and a card under each hosted turn render chosen route, alternatives + why, policy, and est vs actual cost. `ARCHYMEDES_CLOUD_TASK_KIND` sets the profile kind | "Best completed outcome per dollar" is only a claim the user can check if the routing decision is visible |

## What would make it best in class

1. **Measure installed user journeys.** _Started._ `bun run bench:journeys` drives the real
   terminal binary under a pseudo-terminal against a deterministic SSE stub and times five
   journeys — time to first usable prompt, first edit applied, verified turn complete, cancel to
   usable prompt, cross-process resume — on a small (6-file) and a large (600-file) repository,
   writing `benchmarks/journeys/latest.json` with Node version, platform, sample count and a
   `model: "stub"` marker. A lean two-sample pass runs in the suite as a structural-regression
   guard (`packages/archymedes-cli/src/pty/journeys.test.ts`). Still to do: run it against a live
   provider for real latency, add an approval-latency journey, and record it per CI platform. The
   stub numbers are an Archymedes-only regression signal, not a comparison against other tools;
   the bundled 91/100 `reliability/latest.json` is a dated single-model six-case report and names
   a provider (`circuitnotion`) this build no longer ships.
2. **Unify task state across surfaces.** _Started._ The seam is open: `session-inspect.ts` holds
   the first two handlers lifted out of the REPL loop (`/task`, `/todos`) as pure functions over an
   explicit `InspectContext` snapshot — no closure state, no output, no side effects. The two
   chosen first are read-only by construction, and `pty/orchestration.test.ts` pins that (no model
   call, no file write, idempotent, session still takes the next turn) so a later extraction that
   introduces a side effect fails. Next: lift the read-only commands that touch the ledger
   (`/cost`, `/diff`) behind the same context, then the mutating ones (`/undo`, `/retry`,
   `/model`) once integration tests pin the approval, cost and checkpoint invariants they depend
   on. `archymedes.ts` is still ~4,800 lines; this is a multi-release path, not a single change.
3. **Make review the center of the workspace.** _Started._ `/task` (`task-view.ts`) is a pure
   renderer that assembles the session's request, the agent's plan (`/todos`), every file changed
   with its line delta, every verification outcome, and the blockers between here and a finished
   task — each row naming the command that produced it or acts on it (`/diff`, `/undo`, `/retry`).
   It reads session-cumulative state accumulated alongside the per-turn completion-card state.
   Still to do: surface it as a pane in `/workspace` rather than only as a transcript command, and
   pull plan/verification straight from structured runtime events rather than the CLI's own tallies.
4. **Expand terminal acceptance testing.** _Started._ `pty/acceptance.test.ts` runs the installed
   binary through tmux for a whole turn and a clean exit, sends CJK/emoji input and asserts it
   reaches the model byte-for-byte, and checks bracketed-paste markers are stripped before the
   model sees them. Findings to act on: a paste containing newlines is submitted line by line
   rather than held as one message, and the CLI does not put the terminal into bracketed-paste
   mode itself. Still to do: run on Windows Terminal and macOS Terminal (the CI matrix is the
   vehicle), an SSH hop, a screen-reader pass, and a long-session memory-growth guard.
5. **Prove recovery under failure.** _Started._ `pty/recovery.test.ts` measures three unclean
   failures against the local stub: a mid-stream connection drop (bounded in-turn retry, partial
   answer not doubled, session usable after), a SIGKILL with a tool call already applied (the file
   write lands exactly once, always), and a double Ctrl+C mid-turn (no hang). Finding: the tool
   effect is exactly-once and durable, but conversation-state recovery is not — session records
   are turn-atomic, so whether `--resume` finds the interrupted session depends on whether the
   turn had been checkpointed at the instant the process died. Deciding whether to checkpoint
   mid-turn is the open design question. Interrupted-payment belongs with the hosted
   service (item 6), not the local CLI. Still to do: run these against a production-like remote
   deployment rather than a stub.
6. **Keep hosted promises precise.** A public exchange client is not proof of live credits,
   settlement or provider routing. Release the BYOK/local CLI on its own merits; validate the hosted
   service separately before advertising an end-to-end managed offering.

## Fixed workspace review (2026-09-14)

- Page Up on a short transcript and enlarging the terminal while browsing now release the history
  snapshot when the view returns to live output. New output remains visible on subsequent redraws.
- Transcript and intro redraws respect rows reserved for command suggestions. Closing suggestions
  restores the retained transcript rather than leaving a blank gap.
- Partial output retires the opening identity immediately; frame text removes cursor-moving controls
  and incomplete escape characters while retaining styling and whole graphemes.
- `/cat` appears in grouped help and the guide. Regression coverage includes short history, resize,
  suggestion boundaries, partial output, control characters, and resizing/dismissing an open mode menu.

## Release procedure

Validation for 2.2.0 passed on 2026-09-14 after the fixed-workspace corrections:
180 test files / 2,906 passing tests and one skipped (including PTY scenarios), TypeScript checking,
core and CLI package builds, and `git diff --check`. The final 28-entry CLI archive passed isolated
Bun installation under Node 22.22.0, version/help/provider-listing checks, and external TUI dependency
imports. The named-session test now captures the requested record ID directly instead of assuming
wall-clock timestamp order identifies the first thread. This validation did not call a live model
provider. The archive checksum is stored beside it in `artifacts/archymedes-cli-2.2.0.tgz.sha256`.

```sh
bun install --frozen-lockfile
bun run release:check
# Publish the same archive that the isolated consumer test inspected:
bun publish ./artifacts/archymedes-cli-2.2.0.tgz --access public
```

`verify:package` installs the archive with Bun. The final 2.2.0 archive was also installed with npm
in a separate temporary consumer on 2026-09-14; installation and Node version/help/provider-listing
checks passed. Unavailable optional native sidecars do not block this CLI installation. Publishing
those sidecar packages remains a separate release with its own artifacts.

The archive path follows the CLI package version. Update it if the manifest version changes.
The root package stays private. Publishing a reviewed archive avoids rerunning a build between
verification and upload. Bun documents this workflow at https://bun.sh/docs/pm/cli/publish.

Before announcing availability, verify registry metadata and install the published version in a
fresh project. The local archive check does not prove registry publication, real provider access,
native optional sidecar availability, hosted billing, or that GitHub's OS matrix has executed.

2.2.0 was published to the npm registry on 2026-09-14 (`bun publish ./artifacts/archymedes-cli-2.2.0.tgz --access public`,
browser-based auth). A clean `npm install archymedes-cli@2.2.0` in a fresh directory afterward resolved
and ran `--version`/`--help` correctly, confirming registry availability.
