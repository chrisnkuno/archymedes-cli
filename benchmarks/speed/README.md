# Speed benchmarks

Where Archymedes spends time, and a budget for the part we control.

| Command | Measures |
| --- | --- |
| `bun run bench:speed` | startup, tool latency on this repo, the agent's cost per turn and per iteration (stub model) |
| `bun run bench:speed -- --check` | the same, exiting 1 when a number in `budgets.json` is exceeded |
| `bun run bench:speed:go` | the interface: a redraw, a keystroke and a streamed chunk with a long transcript |
| `bun run benchmarks/speed/analyze-session.ts <session.jsonl>` | a real session's wall time split into model, tools, checkpoint, after-answer and other |

## What the first measurements showed (2026-10-14)

* On real tasks **97–99% of wall time is the model** (6–7 s per call, 18–40 calls for a small
  task). The levers there are fewer calls and cheaper calls, not our code.
* Of the time Archymedes controls, a one-word reply spent ~1 s (24%) on fixed overhead:
  0.82 s waiting for the Jev verdict after the answer, and ~240 ms probing the environment before
  the first model call. Both are off the critical path now (`turn.first-cold` 380 ms → `turn.first-warmed` 94 ms;
  after-answer 0.82 s → 0.04 s).
* A further model call + tool call costs under 1 ms of our own time; tools cost 2–30 ms.
* A redraw costs ~3.5 ms whatever the transcript length.

Numbers move with machine load, so budgets are about three times what an idle machine measures:
they catch a real regression (a 10x), not noise.

## Experiments that did not pay off (kept so nobody repeats them)

* A memo for `estimateTextTokens`: the profiler suggested ~40 ms a turn, wall-clock showed none.
* A "verification passed, finish if done" hint on the first green test run: calls after the first green run averaged
  6.8 before and 7.3 after. The models keep going regardless.

## Reasoning effort (opt-in)

See `docs/continuation/FREE_MODE.md`. The A/B harness is a fresh directory per run, the same task, files checked
and `node --test` run afterwards for pass/fail, then `analyze-session.ts` on the event log.
