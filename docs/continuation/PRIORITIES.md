# High-impact continuation roadmap

Treat these as candidate work packages, not authorization to deploy, publish, or contact anyone. Re-evaluate against the current code and measured behavior before implementation.

## P0: preserve the verified baseline

Read START_HERE.md for the latest completed checks. Preserve that baseline while making further changes: rerun affected tests, builds, package installation, and public/private diff checks. The current change spans the public runtime and separate private services. A passing unit suite in one checkout is insufficient proof of compatibility.

Acceptance: all affected checks pass; limitations are explicit; no private implementation is included in public artifacts.

## P1: durable hosted recovery

Problem: live retries now retain identity, but a process crash can lose the identity and receipt of work already paid for.

Approach:

- Persist the logical hosted request identity before dispatch.
- Define pending/completed/failed/ambiguous recovery states.
- Bind identity to immutable request content and the relevant account/session.
- Recover or replay through a documented hosted contract before generating replacement work.
- Store only the minimum metadata needed; do not add raw prompts to telemetry or receipts.

Acceptance:

- Kill the process after the service settles but before the client receives the response.
- Resume and recover the response without a second provider invocation or charge.
- Changed payload under the same identity is rejected.
- Cancellation and timeout remain distinguishable from confirmed provider failure.

Measure: duplicate provider calls, duplicate settlement attempts, recovery time, unresolved pending operations.

## P1: routing preflight in the CLI

Problem: the user can inspect completed decisions but cannot easily compare constraints before spending.

Approach: implement a small typed planning client and a read-only `/route plan` flow. Reuse actual profile construction and defensive parsing. Clearly label estimates and unavailable providers. Do not call a completion endpoint to simulate planning.

Acceptance: planning invokes no model, reserves no credits, preserves the active conversation, supports cancellation, and renders at narrow terminal widths. Pinning a model and privacy constraints must match actual execution semantics.

## P1: persist routing observability across resume

September 9 implementation: active-session receipts now persist in canonical snapshots and are deduplicated on read/merge. Tab, clear, handoff and resume isolation are covered. Pending-request crash recovery remains separate.

Original problem: `/route summary` saw only this process's receipts.

Approach: persist normalized receipts with stable call identity in canonical session records; rebuild a deduplicated view on resume. Keep forecasts, actual charges, currency, and missing settlements distinct.

Acceptance: resume does not lose or double-count receipts; malformed older records do not break history; partial settlements remain explicit.

## P2: request construction and context efficiency

Investigate repeated prompt construction, large tool schemas, oversized results, and cold cache transfers using real traces before changing behavior.

Acceptance: compare prompt tokens, completed-task cost, latency, and verification success on the same deterministic task set. Token reduction that causes extra retries or weaker verification is not an improvement.

Avoid heuristic automatic model switching without evidence: a cheaper call can make the complete task more expensive.

## P2: break up the CLI entrypoint incrementally

The large terminal entrypoint mixes command dispatch, presentation, and orchestration. Extract cohesive command handlers behind typed dependencies as features are changed.

Start with routing inspection because its rendering is already mostly pure. Preserve behavior and PTY coverage. Avoid a wholesale rewrite or a parallel command registry that drifts from help/navigation.

Acceptance: command behavior, cancellation, resize, keyboard input, and resume stay intact. Imports should not eagerly start network clients or native sidecars.

## P2: improve outcome evidence quality

Coordinate with the private service owner. Distinguish user ratings, tool verification, test results, and independently evaluated outcomes. Define source trust, recency, and sample sufficiency before allowing feedback to alter routing strongly.

Acceptance: no fabricated labels; reproducible offline evaluation; explicit cold-start behavior; a bad or sparse feedback batch cannot silently dominate quality floors.

## Measurement discipline

Use a fixed corpus with simple edits, multi-file changes, failing tests, long-context tasks, tool errors, provider outages, cancellation, and resume.

Track:

- Verified task completion rate.
- Actual cost per verified completed task.
- Time to first useful output and total task latency.
- Retry count and abandoned paid work.
- Context/token volume and cache observations.
- Narrow-terminal usability and command responsiveness.

Change one major policy dimension at a time. Prefer deterministic replay and explicit fixtures before live experiments. Document where a simulator ends and provider-backed evidence begins.

## Handoff template for every future pass

- User objective and selected bottleneck.
- Files changed and owning repository.
- Behavioral before/after example.
- Tests and artifact checks actually completed.
- Unverified assumptions, unfinished commands, and deployment status.
- Next smallest task with a concrete acceptance test.
