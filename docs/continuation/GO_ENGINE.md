# The Go engine

Started 2026-10-22 (WS-35); the default engine since 2026-10-23 (WS-36). Friday's own agent,
written in Go, running inside the `friday` binary. It sits beside the TypeScript agent rather than
replacing it in one step: the interface talks to either over the same ACP messages, plain `friday`
runs this one, and a session that needs what only the TypeScript agent has runs there on its own
(`chooseEngine` in `cmd/friday/engine.go`). What it does not implement yet is forwarded to the
TypeScript agent, so the switch continues one method at a time.

User and contributor documentation is in [`docs/engine/`](../engine/README.md); this page is the
working design note.

## Why this shape

Surveyed in October 2026: Codex (Rust), Claude Code, OpenCode, Crush (Go) and the two source-code
studies of coding harnesses (arXiv 2604.03515, 2609.00006). They agree on four things this engine
follows:

- **A sub-agent is a child session of the same loop**, started from a brief, whose final report is
  the only thing that returns. Codex models them as a thread tree with fork modes; OpenCode as child
  sessions whose pending spawns are part of the transcript, so a crash mid-fan-out resumes.
- **The loop is small; the code is in safety, recovery and cost.** Loop sophistication does not
  predict results. So the loop here is one file, and the policy (permissions, safety screen,
  verification gate, budgets) is ported from the TypeScript agent unchanged in meaning.
- **Steering is a loop input**, not a side channel: Codex `turn/steer`, ACP v2's prompt lifecycle,
  Crush folding queued prompts into the next step.
- **Cheap work goes to a cheap model**: titles, compaction and exploration on a small model.

The provider layer is `charm.land/fantasy` (the library Crush uses): its `LanguageModel` interface
and message types throughout, its OpenAI provider for OpenAI, and its OpenAI-compatible provider for
every other vendor (OpenRouter and free mode included). Anthropic is the exception: Fantasy's
Anthropic provider also speaks Bedrock and Vertex and links the AWS and Google Cloud SDKs (about 190
packages), so `llm/anthropic.go` streams the Messages API over plain HTTP instead, with the same two
cache breakpoints as the TypeScript adapter. The loop is ours, not Fantasy's agent, because the
verification gate and steering need to decide what happens after the model says it is done.

| Binary (stripped, linux/amd64) | Size |
| --- | --- |
| Before the Go engine | 20.5 MB |
| With Fantasy's Anthropic and OpenRouter providers | about 68 MB |
| As built (Fantasy core, OpenAI SDK, native Anthropic) | 44.5 MB |

## Packages (`internal/core/…`)

| Package | Owns | May import |
| --- | --- | --- |
| `tool` | What a tool is (effect, capability, parallel safety, deferral), calls, results, evidence; the catalog with deferred loading and `tool_search` | — |
| `policy` | Modes and capabilities, the permission ledger, the safety screen, read-only commands, command rules, the shell tokenizer (ports of `core/cli/permissions.ts`, `safety.ts`, `command-readonly.ts`, `command-rules.ts`, `command.ts`) | `tool` |
| `gate` | The verification gate (`verification-gate.ts`); what counts as evidence is in `policy` (`ClassifyVerification`) | `tool` |
| `roles` | Sub-agent roles: built-ins, role files, which tools a role gets, the delegation guidance (`subagents.ts`), plus each role's model and background default | `tool` |
| `tools` | Built-in tools on a local workspace: files, search, commands, todos, git | `tool`, `policy`, `gate` |
| `llm` | Which provider and model, from settings.json and the environment, as Fantasy models; the main/small pair | — |
| `settings` | The Settings list: fields, choices, validation, masking, settings.json (WS-50.2, ported from `platform/settings.ts`) | `llm` |
| `loop` | One run: stream the model, run tools, fold in steering, detect loops, hold to the gate, compact | `tool`, `policy`, `gate` |
| `thread` | The thread tree on disk: an append-only log per session, fork modes, recovery of runs in flight | — |
| `agents` | The coordinator (accept, prompt, cancel, queue, summarize), sub-agents in the foreground or background, worktrees, prompts, compaction, titles | `tool`, `policy`, `gate`, `roles`, `tools`, `llm`, `loop`, `thread` |
| `server` | ACP v1 over a reader and writer: the methods the interface calls, events, forwarding the rest | `agents`, `llm`, `loop`, `thread`, `policy`, `gate`, `settings` |

The matrix is enforced: `tooling/check/go-sections.json` lists each as `core/<pkg>`, and the
`go-layering` guard reads packages under `internal/core` as sections of their own.

## Running it

- `friday`: the interface on the Go engine, in this process, through pipes and the same ACP
  client. `--engine ts`, `ARCHYMEDES_ENGINE=ts` or Settings → Engine choose the TypeScript engine;
  without a choice, Codex, Archymedes Cloud, keyless free mode, flags the Go engine
  cannot honour (`--sandbox docker`, `--budget`) and TypeScript sessions go there by themselves.
- `friday acp`: the engine on stdio for an editor, under the same rule.
- Sessions live in `.archymedes/go-sessions/` and resume with `--resume` as before.
- Contract tests: `go test ./cmd/friday` drives the engine through the interface's own client.
  Live: `FRIDAY_LIVE=1 go test ./cmd/friday -run Live -v` (real provider from your settings).

## Sub-agents as threads

Every session is a thread tree. The root thread is the conversation; each delegation is a child.

- **Spawn.** `delegate_task` (writable roles) and `delegate_readonly_task` (read-only roles), with
  `background` and `fork`. `fork` is `none` (the default: the brief is everything it knows),
  `full` (it starts from the parent's whole conversation), or `last:N` (the last N turns).
- **Foreground** returns the report as the tool result, as before.
- **Background** returns at once with the thread id. The child keeps running after the parent's
  turn ends. Its report arrives as a message in the parent's inbox: folded into the running turn at
  its next step, or held for the next turn.
- **Tools for the parent:** `wait_agents` (block until reports arrive), `send_agent` (steer a
  running child, or re-open a finished one with a follow-up), `close_agent` (stop one).
- **Writable roles in the background** run in their own git worktree on a `friday/<thread>` branch;
  the report names the branch. Outside a git repository they run in the foreground.
- **Limits kept from WS-32:** depth one (no child gets a delegation tool), at most four running,
  approvals through the parent's ledger, steps and calls bounded by the parent's remaining budget.
- **Restart-safe.** A spawn is written to the log before the child starts, and every child step is
  checkpointed. On `session/load`, a child with no terminal record is resumed from its last
  checkpoint with a note that it was interrupted.

## Model routing

`llm.Models` holds `Main` and `Small`. Small comes from `<PROVIDER>_SMALL_MODEL` or
`ARCHYMEDES_SMALL_MODEL`, else it is the main model. Roles say which they use (`model: small` in a
role file); `explore` and `verify` default to small. Compaction and titles use small.

## The loop

Retries follow the provider: a rate limit waits as long as `retry-after` or the message says (Groq:
"try again in 11.3s"), up to 90 seconds a wait and eight tries; a stream silent for three minutes
is cut and retried. Each step: take steering from the inbox, check budgets and the loop detector, stream one model call,
run its tool calls (read-only, parallel-safe calls in a batch at once; anything else one at a time,
each through the ledger), record results with the gate, checkpoint. When the model stops, the gate
may ask once for missing evidence; messages that reached the inbox meanwhile keep the turn going.

**Loop detection:** a call's signature is its tool and canonical arguments. Repeating one signature
past a threshold in the recent window first adds a note to the result telling the model to change
approach; a further repeat stops the run as `stuck`.

**Deferred tools:** a tool may be deferred. Deferred tools are not sent with each request; when any
exist, `tool_search` is, and finds them by name and description and loads the matches for the next
step. Calling a deferred tool by its exact name loads it too. The MCP client, when ported, registers
its tools deferred.

## Protocol

ACP v1 is the boundary now. Internally a turn already has the v2 shape: accepted (a message id),
then state updates, then idle. Mapping to v2 when it is stable is a change in `server` only.

New on the extension channel: `_archymedes/event` with `type: "thread"` (a child's status and its
report), the `_archymedes/threads` method (a session's threads), and the `subagents` session
command behind `/subagents` in the interface. A background sub-agent's card keeps showing its work
after its call returned, and shows its report when it ends.

## Measured

Live, 2026-10-23, Groq `openai/gpt-oss-120b` on an 8,000-tokens-a-minute tier, a four-file Go
project with `Add` returning `a - b`:

| Turn | Time | What happened |
| --- | --- | --- |
| "Start a background explore sub-agent to find Add; read go.mod meanwhile; collect with wait_agents" | 57 s | Background explorer spawned, parent read go.mod while it ran, `wait_agents` returned its report (add.go:4); thread `running → done` |
| "Fix the bug in Add so go test passes" (auto) | 4 min 15 s | Tests written first, seen failing, `a - b` → `a + b`, `go test` green, `go vet` clean; 27 rate-limit waits followed, none fatal |

The first attempt failed on that rate limit after backing off only 7 seconds; following the
provider's hint is what fixed it.

## Not yet in the Go engine

Each forwards to the TypeScript agent or answers that it is not available here: the Codex
engine (Claude Code runs here: `internal/core/claude`, WS-49), MCP and LSP clients, Docker/E2B workspaces, checkpoints and `/undo`, `/review`,
prices in `/cost` (tokens are counted: WS-52.3), `/diff`, Jev's turn verdicts and pre-tool checks (Jev ranks suggestions and notes edits here: `internal/core/advise`, WS-47), the free gateway (keyless free mode) and Archymedes Cloud providers, money
budgets (RWF) and prices, reasoning effort per call, images, defender playbooks,
`start_application`, web search, the headless `--json` mode. Sub-agent budgets are the role's own
limits, not reserved from the parent's remaining budget as in the TypeScript agent. Forwarded to
the TypeScript agent when it is installed: providers, setup, the model list and the startup
update check (being ported: WS-50). Settings are the Go engine's own since WS-50.2.
