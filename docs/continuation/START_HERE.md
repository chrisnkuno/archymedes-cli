# Archymedes: continuation handoff

Updated: 2026-09-07. Read this before changing code. This is a working handoff, not a release certificate.

## User intent

Improve the routing intelligence, CLI capabilities, reliability, efficiency, and optimization as a coherent system. Prefer the changes with the largest end-user impact. Leave clear work for subsequent agents to continue. Preserve the public/private repository boundary.

## Read in order

1. This file: current state and immediate closeout. For active work and how it is verified, read
   [TRACKER.md](TRACKER.md) and [WORKFLOW.md](WORKFLOW.md) (`bun run recheck`).
2. [Architecture](ARCHITECTURE.md): responsibility and request flow.
3. [Priorities](PRIORITIES.md): next work, acceptance criteria, and optimization principles.
4. `docs/EXCHANGE_API.md`: public hosted client contract.
5. If authorized for private services, read the cloud repository's `docs/CONTINUATION.md`.

## Workspace and ownership

- Public checkout: this repository.
- Public code: `packages/archymedes-cli`, `packages/core`, `packages/archymedes-state`.
- Separate private checkouts exist under `.private/`; they are not part of the public repository's diff.
- Inspect `git status --short` in each checkout. Existing uncommitted work belongs to this effort; do not reset or overwrite it.
- Use Bun commands in TypeScript packages. Follow applicable AGENTS.md instructions.
- Do not publish private routing internals, telemetry, billing logic, credentials, or customer data in the public repository.

## Implemented in the first work pass

Public CLI and core:

- Parse both legacy `chosen` receipts and protocol receipts with `selectedProvider`, `selectedModel`, `estimated`, `actual`, and `attempts`.
- Preserve ranking utilities above one; do not pretend every score is a probability.
- Show attempt trails and policy identity; correctly distinguish providers hosting the same model.
- `/route summary` reports calls, retries, route switches, estimates, settled spend by currency, and missing settlements.

Separate private TypeScript routing package:

- Evidence-weighted task quality, observed latency, constraint-first normalization, optional outcome-per-cost objective.
- Explicit model selection, adapter availability before ranking/attempt limits, cancellation propagation without health penalties.
- Corrected bounded retry expectation and finite zero-cost utility; validate economic inputs.
- Compiled outcome module made visible to version control for direct package consumers.

Validation at the END OF THE FIRST PASS:

- Public: 171 test files, 2,798 passing tests and one skipped; typecheck and package builds passed.
- Private TypeScript router: 27 tests, typecheck and build passed.
- Packed CLI: clean consumer installation and startup passed.
- A temporary gateway-to-client parser check passed.

These results predate the next set of edits. Do not treat them as verification of the current working tree.

## Second pass: implemented and locally verified

Files to review first:

- `packages/core/src/agent-runtime.ts` and its tests.
- `packages/core/src/providers/archymedes-cloud-agent.ts` and its tests.
- `packages/core/src/providers/routing-receipt.ts` and its tests.
- `packages/archymedes-cli/src/render/routing-receipt.ts` and its tests.

Changes:

1. Add optional `AgentModelRequest.requestId`. The runtime generates one ID per logical model iteration and retains it across transport retries. A later iteration or a new execution gets a different ID.
2. The cloud adapter uses that ID for the idempotency header and task identity. Identical retries therefore send the same serialized body.
3. Retry classification accepts an adapter's explicit `retryable` boolean. Terminal hosted conflicts and spend-limit errors stop; processing responses remain retryable.
4. Retain Retry-After information. Runtime backoff honors finite server hints up to ten seconds, with cancellation-aware waiting and the existing attempt ceiling.
5. Expand recognized task categories to include the hosted vocabulary; reject misspelled configuration locally.
6. Parse and display expected total cost, predicted quality, economic factors, total latency, and separately evaluated final quality. Predictions must never be labeled as measured outcomes.

Current limitations:

- IDs are stable within a live runtime retry loop. They are not yet durably persisted for crash recovery.
- Direct users of the cloud provider must supply `requestId` if they want continuity across separate calls to `complete()`.
- `/route summary` now reads persisted receipts for the active session (see the September 9 update below), not account-wide balances.
- No live provider, production deployment, or payment flow was verified in this effort.

## Reproduce closeout

1. Read the private handoff for the completed hosted checks and remaining integration limitations.
2. Run targeted tests:

   ```sh
   bun run test -- packages/core/src/agent-runtime.test.ts packages/core/src/providers/archymedes-cloud-agent.test.ts packages/core/src/providers/routing-receipt.test.ts packages/archymedes-cli/src/render/routing-receipt.test.ts
   bun run typecheck
   ```

3. Resolve failures, then run `bun run check` and `bun run verify:package`.
4. Run `git diff --check` and inspect the final diff in every affected repository.
5. Record new results here with dates and exact scope. Never copy an old passing result forward as current proof.

Sandbox note: full tests need localhost listeners, subprocesses, and PTYs. A sandboxed run previously failed with EPERM; the first pass succeeded with the required execution access. Request appropriate tool escalation when necessary, not broad user reconfirmation of already-authorized development.

The user interrupted implementation to prioritize these handoff files, then requested continuation. Hosted closeout has since passed. Public full checks have since passed. Results are recorded below; inspect them before launching duplicate long-running checks.


## Second-pass validation recorded so far

- Public focused tests: 81 passed across runtime, cloud adapter, receipt parser and CLI receipt renderer; typecheck passed.
- Hosted runtime: full `bun run check` passed, including 29 unit/HTTP/SQLite tests, eight Workers-runtime tests and both Go packages.
- Hosted tests use an explicit pinned Node typings dev dependency, not an accidental parent dependency.
- Hosted SQL was tested against the real migrations, including sparse evidence and fractional latency conversion.
- Full public `bun run check` passed: 171 test files, 2,807 passing tests and one skipped, typecheck, and package builds.
- Clean package verification passed: `archymedes-cli-1.9.1.tgz`, 27 entries, isolated consumer installation, Node startup, provider exports and TUI dependencies. SHA256: `2551c6df86aaaba75ad96482a126d805df3c5d7080aeb5df4f00e232388d8254`.
- Public and hosted `git diff --check` passed.
- No deployment or live-provider verification is implied.

## September 9: session-owned routing history

- Removed the process-global CLI receipt list. `/route` reads the active daemon session, so tabs, `/clear`, and resume select the correct history.
- Session snapshots persist normalized receipts at turn completion. Runtime-generated request IDs identify receipts when the service omits identity; identified replayed calls are deduplicated.
- Legacy sessions without receipts remain readable; malformed optional receipt entries are ignored after integrity verification. Unidentified legacy calls are not deduplicated by model or price.
- Normalized receipt parsing retains attempt latency and economic factors. Partial replays preserve known settlement in the same currency.
- This is completed-turn observability persistence, not durable pending-request recovery. A crash before snapshot saving can still lose receipts. Compaction and delegated calls are not newly included in this change.
- Validation on 2026-09-09: `bun run check` passed (171 files, 2,813 tests passed, one skipped), including the PTY regression for tabs, `/clear`, and history resume; typecheck and package builds passed. `bun run verify:package` passed: 27 archive entries, clean consumer install, Node startup, provider exports, and TUI dependencies. SHA256: `197a513fe0260dd336b79a606769992d460ae19240cda8e59d25be5543cc7499`. `git diff --check` passed. No publication, deployment, or live provider/payment call was performed.


## September 9 (second entry): routing preflight

The hosted `/v1/routes/plan` endpoint existed with no client. `/route plan` is now that client.

- `packages/core/src/providers/routing-plan.ts`: defensive plan parser. An empty ranking parses as a
  real answer ("no capacity"); a route the exchange excluded can never come back marked eligible.
- `ArchymedesCloudTurnProvider.plan()`: posts to `/v1/routes/plan` with the profile the real turn
  would send, no idempotency key, and a 30s timeout. Planning commits nothing, so it needs neither.
- `ArchymedesAgent.planNextTurn()`: assembles the prospective request once and shares that assembly
  with `estimateNextTurn`, so the preflight and the turn cannot price different requests. A direct
  provider returns null rather than a locally invented ranking.
- `packages/archymedes-cli/src/render/routing-plan.ts`: renders forecasts as forecasts, says once that
  nothing was reserved, and prints an empty plan as an explicit "no route available" with the
  exclusion reasons — never as a quiet success. Route figures sit on their own row so a wordy reason
  cannot clip the cost off a narrow terminal.
- Ctrl+C now cancels a read-only command that is waiting on the network (`pendingReadAbort`);
  previously only a turn was interruptible and this would have fallen through to the prompt.
- `docs/EXCHANGE_API.md` documents the endpoint; the README documents the command.

Contract change, private `archymedes-cloud`: the plan request accepts
`archymedes.estimated_input_tokens` as an alternative to `messages`. Ranking only ever reads the
prompt's size, so a preflight no longer uploads the conversation to ask what it would cost.
`messages` remains accepted; a request with neither is rejected. Completions are unchanged.

Validation on 2026-09-09:

- Public `bun run check` passed: 173 test files, 2,833 passing, one skipped; typecheck; package builds.
- `bun run verify:package` passed: 27 entries, clean consumer install, Node startup, provider exports,
  TUI dependencies. SHA256 `2e9c3436c333171526445f4da582b2060c381da986f2b550990f293734b58929`.
- Hosted `infra/cloudflare` `bun run check` passed: typecheck, 32 unit/HTTP/SQLite tests (three new
  planning tests), eight Workers-runtime tests, both Go packages.
- Private `archymedes-protocol` (5), `archymedes-routing-intelligence` (27), `archymedes-billing`
  (19) and `archymedes-cloud` (9) test suites all passed on their current working trees.
- `git diff --check` clean in both changed checkouts.
- No deployment, no live provider call, no payment. The plan path has never been exercised against a
  deployed exchange — only against the real handler with mocked infrastructure.

Note: `archymedes-billing` had no `node_modules` in this checkout; `bun install` was run there. Its
tree is otherwise unchanged.

Next smallest task: `/route plan` currently plans the *empty* next objective. Let it take the text
the user has typed (`/route plan <objective>`), so the preflight prices the work actually about to
be sent. Acceptance: the estimate rises with the objective, the conversation is untouched, and an
objective containing a slash is not parsed as a subcommand.


## September 9 (third entry): the hosted credit balance

Closes the limitation this README had stated since the beginning: the balance was a figure the user
typed, and the exchange's real ledger was unreachable from the CLI.

- `packages/core/src/providers/credit-balance.ts`: parses `GET /v1/credits/balance`. A response
  carrying no currency or no amount parses to null — rendering "0 available" for a 401 or a
  malformed body would tell someone they are out of money when they are out of a working token. A
  stated zero is kept, because that is a fact.
- `ArchymedesCloudTurnProvider.creditBalance()`: a plain authenticated read, no idempotency key,
  asking for the currency this provider reserves in so the figure shown is the figure the next turn
  draws against.
- `renderHostedBalance` in `packages/archymedes-cli/src/commands/balance.ts`, and `/balance` now prefers it
  whenever the provider can answer.

Three distinctions the tests pin, because each is a way to misstate someone's money:

1. Available, reserved and spent are three figures, never one total. Reserving moves credit out of
   available into reserved; it is held, not spent, and the unused part returns.
2. The hosted ledger and the local tracked figure are never summed. When both exist both are shown,
   labelled. One is money; the other is a pacing limit the user chose.
3. The balance is shown in the ledger's own currency, never converted into the display currency —
   no reservation is denominated in the converted number.

The panel also states every time that credits are closed-loop: for Archymedes services, not
transferable, not withdrawable.

Validation on 2026-09-09:

- Public `bun run check` passed: 175 test files, 2,850 passing, one skipped; typecheck; package builds.
- `bun run verify:package` passed: 27 entries, clean consumer install, Node startup, provider exports,
  TUI dependencies. SHA256 `506c7f6b5953652439822a4a95b951f00355756c10123f53588be7679df523eb`.
- `git diff --check` clean.
- No deployment, no live provider call, no payment, and no balance has ever been read from a
  deployed exchange — every check is the client against a stubbed response.

Next smallest task: `/balance` reads, but there is still no way to add credit from the terminal. The
hosted `POST /v1/credits/checkout` and `GET /v1/credits/checkouts/:id` exist and have no client.
Acceptance: the CLI can open a checkout and poll its status without ever handling card details
itself, a cancelled or abandoned checkout leaves no phantom credit, and the command refuses to run
on a direct provider.
