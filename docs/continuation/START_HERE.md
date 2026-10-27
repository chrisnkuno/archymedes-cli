# Start here

Updated 2026-10-27 (WS-50). The one entry point for anyone, person or agent, about to change this
repository. It replaces `restructure.md` and the September handoff (now in
[history/](history/HANDOFF_2026-09.md)).

## What this is

Friday is a coding agent in one Go binary, `friday`: a desktop-like terminal interface
(`internal/tui`) talking ACP to Friday's engine (`internal/core`). It ships on npm as a launcher
plus six static binaries.

**One engine: Go.** The TypeScript engine (`packages/core`, `packages/friday-cli/src`) is being
ported and then deleted (WS-50 in [TRACKER.md](TRACKER.md)). Until its part is ported it still
answers what the Go engine forwards. The rules that follow from that:

- New behaviour goes into Go only.
- TypeScript changes only to keep it working, or to capture a fixture for a port.
- A port is tested against a JSON fixture of what the TypeScript side returned, kept under
  `internal/core/<pkg>/testdata/`, so the contract outlives the TypeScript code.
- Not ported, by decision: the phone bridge and accounts, Docker/E2B sandboxes, Archymedes Cloud.
- `packages/free-gateway` stays: it is a deployed server, not part of the engine.

## Read in order

1. [CODEBASE.md](CODEBASE.md): every section, what it owns, what it may import, where new code goes.
2. [WORKFLOW.md](WORKFLOW.md): track, change, recheck.
3. [TRACKER.md](TRACKER.md): the work, newest first. WS-50 is the current plan.
4. [GO_ENGINE.md](GO_ENGINE.md) and [docs/engine](../engine/README.md): the engine's design and its documentation.
5. [docs/mechanisms](../mechanisms/README.md): the standard every command, flag, setting, tool and message is held to.
6. [prompts/QUALITY_PASS.md](prompts/QUALITY_PASS.md): the procedure for a structural pass (`/quality-pass <scope>`).

Contracts for single features: [FREE_MODE.md](FREE_MODE.md), [JEV_VERDICT.md](JEV_VERDICT.md),
[LANGUAGES.md](LANGUAGES.md). [ARCHITECTURE.md](ARCHITECTURE.md) and [MODULE_MAP.md](MODULE_MAP.md)
describe the TypeScript side and go with it.

## Design rules

- Put behaviour in the package that owns it ([CODEBASE.md](CODEBASE.md)); the import matrices in
  `tooling/check/go-sections.json` and `sections.json` are enforced. `internal/core/*` imports only
  other `core/*` packages; what the interface owns (themes, words) is passed in by `cmd/friday`.
- Keep parsing, validation, selection and drawing pure. Network, files, clock and terminal are
  injected at the edges, so a unit test can call the logic.
- One responsibility per file, aiming under 400 lines; the 800-line ratchet never rises.
- A protocol method, session command or setting is a row in its registry, with a conformance test
  beside the registry.
- Separate structural changes from behaviour changes, one task each. Keep other people's
  uncommitted work.
- Measure before claiming an optimization (startup, binary size, a realistic hot path).
- Test observable contracts, including malformed input, cancellation and failure. Never weaken an
  assertion or a guard to get a pass.

## Verification and handoff

Add the task to the tracker before the code. `bun run recheck` after each batch (`--pty` for
terminal work), `--full` before closing a workstream. Record failures that were there before
separately from new ones, with the exact command. Commit only when the user asks; one task, one
commit, the task id in the message.

## Repository boundary

Private services (the cloud router, the site's Workers in `~/archymedes-site`) live in their own
checkouts. Keep routing internals, billing, credentials and customer data out of this repository.
