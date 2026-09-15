# Restructuring and code quality

This is the repository entry point requested on 2026-09-15. The existing detailed instructions
are [QUALITY_PASS.md](docs/continuation/prompts/QUALITY_PASS.md); use that workflow rather than
maintaining a second competing set of rules here.

## Read before editing

1. [START_HERE.md](docs/continuation/START_HERE.md): repository boundaries and handoff.
2. [WORKFLOW.md](docs/continuation/WORKFLOW.md): task tracking and rechecks.
3. [TRACKER.md](docs/continuation/TRACKER.md): active work, ownership and evidence.
4. [ARCHITECTURE.md](docs/continuation/ARCHITECTURE.md) and
   [MODULE_MAP.md](docs/continuation/MODULE_MAP.md): responsibilities and dependency directions.
5. [QUALITY_PASS.md](docs/continuation/prompts/QUALITY_PASS.md): execution procedure.

## Design rules

- Place behavior in its owning module. Keep `archymedes.ts` as application wiring; extract a
  focused handler with explicit inputs when touching a large inline block.
- Keep parsing, validation, selection and rendering pure. Inject network, filesystem, clock and
  terminal dependencies at their edges. Importing model metadata must not construct a client.
- Follow `tooling/check/sections.json`. Commands may depend on UI; UI must not depend on commands.
  Core must not import CLI presentation modules. Shared state belongs to its owning session.
- Prefer one responsibility per module, aiming below 400 lines. Preserve the existing 800-line
  ratchet; never increase a baseline to make a new feature pass.
- Use existing adapters, wire translators, settings storage and retry machinery where their
  contracts fit. Provider-specific policy belongs in its adapter, not the general agent loop.
- Separate structural changes from behavior changes in tracked tasks. Preserve concurrent work.
- Measure startup, bundle size or a realistic hot path before claiming an optimization. Avoid
  extra startup requests and repeated catalog parsing; cache with bounded lifetime and size.
- Keep tests focused on observable contracts, including malformed data, cancellation and failure
  paths. Do not weaken assertions or bypass guards to get a passing result.

## Verification and handoff

Track scope before changes. Run `bun run recheck` after each batch; include `--pty` for entry,
terminal, layout or input changes. Run `--full` before closing an implemented workstream.
Record pre-existing failures separately from new failures, with exact commands and counts.
Only ratchet improved counts after verifying the changes that produced them.

## Current work

WS-2.11 continues handler extraction. Free mode is a separate behavioral workstream, WS-4;
its module plan, access contract and acceptance criteria are in
[FREE_MODE.md](docs/continuation/FREE_MODE.md). It is implemented and verified live (WS-4.4).
