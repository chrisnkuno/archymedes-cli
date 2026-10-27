# Architecture

How the Go engine is built, and why. For the decisions as they were made, see
[`docs/continuation/GO_ENGINE.md`](../continuation/GO_ENGINE.md) and WS-35/WS-36 in the
[tracker](../continuation/TRACKER.md).

- [The picture](#the-picture)
- [Packages](#packages)
- [A turn, from request to reply](#a-turn-from-request-to-reply)
- [Threads on disk](#threads-on-disk)
- [Concurrency](#concurrency)
- [The provider layer](#the-provider-layer)
- [Policy, ported](#policy-ported)
- [Choosing the engine](#choosing-the-engine)
- [Design decisions](#design-decisions)
- [Testing](#testing)

## The picture

```
friday  (one Go binary)
│
├─ cmd/friday ─ chooseEngine: the Go engine, unless the session needs the TypeScript one
│
├─ internal/tui ─────── the interface
│     │
│  internal/acp ─────── the ACP client (the same one for both engines)
│     │
│     │  io.Pipe  (or stdin/stdout for `friday acp`)
│     ▼
└─ internal/core/server ─── ACP methods and events; forwards settings and providers ──► TypeScript agent
      │
   core/agents ─── Session: turns in order, cancel, steering, sub-agent threads, worktrees
      │
      ├─ core/loop ──── one run: stream, tools, inbox, loop detector, retries, compaction
      │    ├─ core/tools ─── files, search, commands, todos, git
      │    ├─ core/policy ── modes, ledger, safety screen, read-only commands, rules
      │    ├─ core/gate ──── proof before done, tests first
      │    └─ core/tool ──── what a tool is; the catalog and tool_search
      ├─ core/claude ── a session run by the person's own Claude Code (its stream-JSON protocol)
      ├─ core/thread ── the session on disk: log, messages, fork, recovery
      ├─ core/llm ───── provider and models (Fantasy; native Anthropic)
      ├─ core/advise ── suggestions: next steps, notes on edits, hints; Jev
      └─ core/roles ─── sub-agent roles

TypeScript agent (`friday acp` under Node): settings, providers, setup, --json, doctor, history;
and whole sessions that need Codex, sandboxes, Archymedes Cloud or keyless free mode.
```

The interface does not know which engine it talks to: both speak the same ACP messages and
`_archymedes/*` extension. The Go engine runs in the same process, connected by two `io.Pipe`s to
the same client the interface uses for the TypeScript agent; `friday acp` connects it to standard
input and output instead.

## Packages

All under `internal/core/`. Each is a layering section of its own (`core/<pkg>` in
`tooling/check/go-sections.json`), and the `go-layering` guard holds every import to this table.

| Package | Owns | May import |
| --- | --- | --- |
| `tool` | What a tool is: name, schema, capability, effect (declared, or judged per call), parallel safety, deferral, provenance. Calls, results, evidence. The **catalog**: which tools are sent, which are found with `tool_search` (BM25 over name and description) | — |
| `policy` | Modes and their capabilities. The **ledger** (who decides whether a call runs: command rules, read-only commands, auto mode's safety screen, standing approvals, patterns, the person). The safety screen. Read-only commands. Command rules. The shell tokenizer. What counts as verification evidence | `tool` |
| `gate` | The **verification gate**: what a run must show before it may end (proof of changes; tests first, red, green, static check) | `tool` |
| `roles` | Sub-agent **roles**: built-ins, role files, which tools a role gets, the delegation guidance in the prompt | `tool` |
| `llm` | Which **provider and model** (settings under the environment, the TypeScript agent's order), opened as Fantasy models; the main/small pair; the native Anthropic streamer | — |
| `settings` | The **Settings list**: every setting, its choices, how a value is checked, `settings.json` | `llm` |
| `thread` | The **session on disk**: meta, the append-only thread log, message snapshots, fork modes, recovery | — |
| `tools` | The **built-in tools** on a local workspace | `tool`, `policy` |
| `loop` | **One run**: steps, streaming, tool execution and batching, the inbox, the loop detector, retries and the idle watchdog, compaction, wrap-up | `tool`, `gate` |
| `advise` | **Suggestions** beside the work: next steps after a turn, notes on an edit, weighing what is being typed. The Jev client | — |
| `agents` | The **coordinator**: a Session's turns in order, cancel, steering, sub-agents in the foreground and background, worktrees, prompts, compaction, titles | everything above |
| `server` | **ACP**: framing, methods, requests to the client, events, forwarding | `agents`, `advise`, `llm`, `loop`, `policy`, `gate`, `settings`, `thread`, `tool` |

`cmd/friday/engine.go` chooses the engine and wires the server to the interface or to stdio.

## A turn, from request to reply

1. **Read.** `server.handle` reads `session/prompt` on the reading goroutine, checks it, and calls
   `Session.Accept()`, which gives it a numbered slot. Then a goroutine waits for the reply.
2. **Wait its turn.** `Session.Prompt` → `inTurn` waits until no turn runs and its number is next
   (or it is at or below the cancel mark, and ends unrun).
3. **Set up.** `runRoot` takes the mode's ledger and builds the catalog for the mode: built-ins
   whose capability the mode has, `ask_user`, the delegation tools, rarely used ones deferred. It
   builds the system prompt (identity, mode, how to work, choosing tools, delegation guidance,
   environment, project instructions), a fresh gate, and the root inbox.
4. **Run.** `loop.Run`:
   - saves the request (a checkpoint before the first call);
   - each step: folds in the inbox; checks the budget; streams one model call (retrying what is
     worth retrying, cut by the idle watchdog if silent); records the assistant message;
   - with no calls: continues a reply cut by the length limit, keeps going if something arrived in
     the inbox, asks the gate (one nudge per missing proof), else ends;
   - with calls: prepares each (decode, look up, load if deferred, judge the effect). Consecutive
     effect-free parallel-safe calls run together, the rest one at a time after the ledger
     approves. Each result is recorded with the gate and the loop detector, truncated and emitted.
     Then it saves, and compacts past 80% of the window.
5. **Report.** Every event goes out through `Notify` → `server.publish` as it happens: text as
   `agent_message_chunk`, tool calls as `tool_call` / `tool_call_update`, everything as
   `_archymedes/event`. The run ends with `runtime_stop`.
6. **Reply.** `runRoot` saves the conversation and the standing approvals, hands back unread
   steering (`steering_unread`), and the reply `{"stopReason": …}` is written, after every event of
   the turn.

A sub-agent runs the same `loop.Run` with its own catalog (the role's tools, never delegation),
its own inbox, its model, the role's budget and a wrap-up request, and events forwarded as
`subagent` notices under the call that started it.

## Threads on disk

A session is `.archymedes/go-sessions/<id>/` in the project. The id is the TypeScript agent's
format (`20261023T094105Z-k3x9ab`), so `--resume <id>` accepts both.

| File | Holds | Written |
| --- | --- | --- |
| `session.json` | id, title, cwd, provider, model, mode, standing approvals, times | on every change, replaced whole |
| `threads.jsonl` | one line per event: `{"t":"spawn","thread":{…}}` when a thread is created, `{"t":"status","id":…,"status":…,"report":…}` when it reaches a status | appended, synced |
| `root.json` | the main conversation, as Fantasy messages | after every step, replaced whole |
| `<thread id>.json` | a sub-agent's conversation | after every step, replaced whole |

Rules that make it safe:

- **Replaced whole, never appended**: message files and `session.json` are written to a temporary
  file and renamed over, so a crash leaves the previous step, never half of one.
- **Spawn before start**: a sub-agent is in the log before it runs. On load, `Interrupted()`
  finds every child still `running` (a crash) or `paused` (a quit), marks it `interrupted` (so a
  second load does not find it again), and the session resumes it.
- **A torn last line is skipped**: replaying the log ignores a line that does not parse.
- **Complete pairs**: a loaded or forked conversation drops tool calls without results and results
  without calls (`thread.Complete`), so a provider never sees half of a pair.

## Concurrency

| Thing | Guarded by | Notes |
| --- | --- | --- |
| Turn order | `turnMu` + `turnCond`, `acceptSeq`, `nextTurn`, `cancelMark` | each waiter waits for its own number; `advancePast` moves `nextTurn` past finished and cancelled slots and wakes everyone. Every accepted slot must reach `inTurn` once, which is why the server checks a prompt before accepting it |
| `/compact` | a turn slot | so a turn sent during compaction runs after it, on the shorter conversation |
| Session state (messages, meta, ledger, models) | `Session.mu` | `Models()` swaps under the lock for a provider change |
| Inbox | its own mutex | steering only while open; notices always; keyed notices can be withdrawn |
| Children | `childMu` for the map, each child's `mu` for its result | a child closes `done` after `finish` has queued its report, so a waiter that sees `done` sees the report |
| Background lifetime | `Session.life` | background children run under it, not under the turn; `Close` ends it, and they pause |
| Foreground lifetime | the turn's context | stopping the turn stops them |
| Sub-agent slots | a buffered channel of 4 | a child waits for a slot under its own context |
| Writes to the client | `writeMu` | one line at a time; events of a session are published under its `sessionRef` lock so buffered ones are never overtaken |
| Requests to the client | `pending` map, ids `friday-<n>` | registered before writing; closed when the connection ends |
| Tool batch | the loop's goroutine | tools run in goroutines, but results are recorded with the gate and detector in call order, on the loop's goroutine |

Shutdown: when the client's input ends, `Serve` cancels its context. `closeAll` sets `closing` (no
session may register after it) and closes every session, cancelling turns and pausing background
children. It waits for in-flight requests, then fails any request to the client still waiting.

## The provider layer

The engine depends on [`charm.land/fantasy`](https://github.com/charmbracelet/fantasy) for its
`LanguageModel` interface and message types, its OpenAI provider (OpenAI itself), and its
OpenAI-compatible provider (every other provider, OpenRouter and free mode included, at their base
URLs). The loop needs only `Stream` and `Model`.

Anthropic is reached by `llm/anthropic.go`, a small Messages API streamer over plain HTTP, rather
than Fantasy's Anthropic provider, which also speaks Bedrock and Vertex and links the AWS and Google
Cloud SDKs (about 190 packages):

| `friday` binary, stripped, linux/amd64 | Size |
| --- | --- |
| before the Go engine | 20.5 MB |
| with Fantasy's Anthropic and OpenRouter providers | about 68 MB |
| as built | 44.5 MB (Windows 45.5 MB) |

The native streamer places the TypeScript adapter's two cache breakpoints: system and tools, and
the second-to-last message. It merges consecutive same-role messages (tool results and the next
words share a user turn), drops empty text blocks, and reports usage with cache reads and writes. It
yields a keepalive for every event and SSE comment, so the idle watchdog sees life. Errors come back
as Fantasy `ProviderError`s with headers, so retries treat every provider alike.

Retries (`loop/stream.go`) happen only before anything streamed: up to 4 attempts, 8 for a rate
limit. The delay is the larger of exponential backoff (1, 2, 4… s, at most 20) and the provider's
hint (`retry-after-ms`, `retry-after`, or "try again in Xs"), at most 90 s. A provider that says the
conversation is too long gets one compaction and a retry.

## Policy, ported

`policy`, `gate` and `roles` are ports of the TypeScript agent's `permissions.ts`, `safety.ts`,
`command-readonly.ts`, `command-rules.ts`, `command.ts`, `verification-gate.ts`, `subagents.ts`
and the verification classifier in `tools.ts`, with their test cases. They mean the same thing:

- **Approval digests are byte-identical** to the TypeScript ones (canonical JSON with JavaScript's
  key order and number formatting, SHA-256), checked against `bun` output in
  `TestActionDigestMatchesTypeScript`, so a standing approval made on one engine holds on the other.
- **JavaScript regex semantics** where Go's RE2 differs: no lookbehind or lookahead (rewritten as
  code and tested against Node), JavaScript's `\s` and `.` character sets.

## Choosing the engine

`chooseEngine` (`cmd/friday/engine.go`) is a pure function over gathered facts, tested case by
case. An explicit choice wins (`--engine`, `ARCHYMEDES_ENGINE`, the setting); without the TypeScript
agent, Go. Then the TypeScript engine for Codex, Archymedes Cloud, keyless free mode,
flags the Go engine would ignore, and sessions it wrote; otherwise Go. See the
[README](README.md#which-engine-runs).

## Design decisions

Surveyed in October 2026: Codex (Rust), Claude Code, OpenCode, Crush (Go), Gemini CLI, Goose,
Aider, Cline, and two source-code studies of coding-agent harnesses.

| Decision | Because |
| --- | --- |
| **Our own loop over Fantasy's models**, not Fantasy's agent | the gate and steering decide what happens after the model says it is done; "loop sophistication does not predict benchmark performance" (arXiv 2609.00006), so the loop stays one small package and the code goes to safety, recovery and cost |
| **Crush's coordinator contract** (accept, queue, cancel, summarize) | it solves cancel-during-handoff; Crush is the nearest Go agent on the same Charm stack |
| **Sub-agents as child threads with fork modes** | Codex's thread tree and SpawnAgentForkMode; OpenCode's child sessions; Claude Code's fresh-context helpers |
| **Spawn logged before start; steps checkpointed** | OpenCode's pending spawns as transcript parts made fan-out restart-safe |
| **Re-open a finished child** | OpenCode users asked for it (issue #11012); Codex routes follow-ups |
| **Worktrees for editing background children** | Claude Code's worktree isolation; Friday's own `child-session.ts`, written after two agents overwrote one file |
| **Steering as a loop input** | Codex `turn/steer`, ACP v2's prompt lifecycle, Crush folding queued prompts into the next step |
| **Small model for cheap work** | universal across the surveyed agents (Aider's weak model, OpenCode's per-agent overrides, Crush's large/small pair) |
| **Repeat detection scoped to the workspace generation** | Crush stops on repeats in a window; scoping to "nothing changed" lets test reruns after edits through |
| **Deferred tools with BM25 search** | Codex defers MCP tools behind a BM25 `tool_search`; Claude Code defers its own |
| **ACP v1 outside, v2 shape inside** | v2 is a draft; accepting a prompt separately from running it is the v2 shape, so v2 changes one package |
| **Policy ported with its tests, not rewritten** | the safety rules are the product; a port that means something else is a regression |

## Testing

| Level | Where | Runs |
| --- | --- | --- |
| Unit, per package | `internal/core/*/…_test.go` | `go test -race ./internal/core/...` |
| Coordinator and threads, with a scripted model | `internal/core/agents/agents_test.go` | ordering, cancel, background, collect-once, resume after crash and quit, worktrees, fork, compaction, titles |
| Protocol contract, through the interface's own client | `cmd/friday/engine_test.go` | approvals, denials, plan mode, steering, commands, resume, threads, forwarding, the engine rule |
| The real binary in a real terminal | `packages/friday-cli/src/pty/go-engine.test.ts` | plain `friday` against an Anthropic stub: approvals, resume, model switch, first-run setup |
| A real model | `cmd/friday/live_test.go` | `FRIDAY_LIVE=1 go test ./cmd/friday -run Live -v` with your own key |
| Repository guards | `bun run recheck` | layering, sizes, vet, tests of changed packages |
