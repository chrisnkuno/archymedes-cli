# Jev second opinion: implementation contract

Status: implemented; unit-verified with injected responses. No live key exercised yet.
Tracker: Jev verdict + tool check ("model first, Jev later").

## User outcome

The CLI's own model does the work first; Jev (TypeSafe System One) judges after. Two
integration points, both advisory:

1. **Pre-tool check** — before an effectful tool runs, Jev answers a fixed `tool_fit`
   choice (proceed / reconsider / stop). The reading annotates the approval prompt
   beside the rule-based safety screen. It never approves or denies on its own.
2. **Post-turn verdict** — after the turn is saved, Jev answers an `outcome` choice
   (complete / follow_up / blocked) and a `sensitive_action` noul. The transcript
   prints the outcome with its probabilities.

Jev is not a chat model and cannot drive a turn; the vendor's own docs say there is
no `model: "jev-latest"` setting that turns a coding agent into a Jev-powered one.
This integration never tries: the model provider selection is untouched.

## Interface and access policy

- Active when `TYPESAFE_API_KEY` is set, inert otherwise: no key, no calls, no
  behavior change. `ARCHYMEDES_JEV=off` forces off even with a key. A blank key
  counts as absent.
- Store `TYPESAFE_API_KEY` using the existing secret settings field mechanism. Never
  print it, include it in a journal record, persist it in a session snapshot, or send
  it anywhere but the `Authorization` header of `https://api.typesafe.ai/v1/systemone`.
- Default model `jev-latest`, overridable with `TYPESAFE_MODEL`.
- Fail-open everywhere: an unreachable or misanswering Jev means "no opinion", and
  the turn or approval proceeds exactly as it would without one. A post-turn outage
  emits an `unavailable` verdict so the transcript says so instead of going quiet.
- The verdict is awaited after the turn is saved *and disarmed*, keeping transcript
  order (verdict line before the next prompt) without extending the turn: Ctrl+C
  during judgment exits instead of aborting finished work.
- The judge is consulted only where a human is about to decide: auto-mode fast paths
  that approve without asking never pay for a judgment call. Reads (`effect: "none"`)
  never consult it.
- Bounded payloads: the turn state carries the objective, the last assistant text,
  tool names, and a bounded execution-evidence digest (recent commands, exit codes,
  verification rung — never tool outputs). Tool-check arguments are truncated to 1,500
  chars. What leaves the machine is a summary, and only when a key is configured.

## Modules and dependencies

| Location | Responsibility | Dependencies |
| --- | --- | --- |
| core `cli/jev.ts` | System One client, question sets, verdict shapes | Injected fetch only |
| core `cli/permissions.ts` | Consults the judge before the prompt; attaches `jev` to `ApprovalRequest` | `JevJudge` interface |
| core `cli/agent.ts` | Builds the judge, sets the per-turn task hint, emits `jev-verdict` post-turn | `cli/jev.ts` |
| core `cli/daemon.ts` | Carries optional `jev` across the approval boundary (additive, protocol v1 stands) | Type-only |
| CLI `app/jev.ts` | Maps environment to agent options | Core option type |
| CLI `app/transcript.ts` | Renders the verdict dimly, with probabilities | — |
| CLI `headless.ts` / `job-worker.ts` | Emit a `jev_verdict` record / log one line | — |
| CLI `app/prompts.ts` | Shows the second opinion inside the approval prompt | — |
| CLI `platform/settings.ts` | `TYPESAFE_API_KEY` (secret), `TYPESAFE_MODEL`, `ARCHYMEDES_JEV` on/off | — |

Questions and thresholds live as constants in `cli/jev.ts` (`TURN_VERDICT_QUESTIONS`,
`TOOL_CHECK_QUESTIONS`): per TypeSafe's own guidance these are the part humans must
review, so they are defined once, not constructed at call sites.

## Acceptance tests

1. All existing approval, agent, headless and job-log tests still pass; without a key
   no verdict event fires and no prompt carries an annotation.
2. Client tests prove the endpoint, Bearer auth, the documented response shape with
   probabilities, bounded state, and closed failures on malformed bodies.
3. Gate tests prove the annotation rides with the prompt, the human still decides, a
   throwing judge changes nothing, and fast paths never consult.
4. Agent tests prove the verdict emits after a completed turn and `unavailable` after
   an outage without failing the turn.
5. The key appears in no snapshot, journal record, log line, or error message.
6. `bun run typecheck` clean; the core `conformance.ts` type-escape ratchets unchanged
   (this integration adds none).
7. Terminal tests stay hermetic: turn-running PTY suites pin `ARCHYMEDES_JEV=off`
   (like the existing `ARCHYMEDES_FX_OFFLINE=true`), so an ambient `TYPESAFE_API_KEY`
   in the developer's shell cannot make the suite slow, billed, or network-dependent.
   Verdict logic itself is covered by stubbed unit tests.
