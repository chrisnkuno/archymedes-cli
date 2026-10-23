# Friday's engine

Friday is two programs in one binary. The **interface** is what you see in the terminal. The
**engine** reads your request, talks to a model, runs tools in your project, and asks before
anything changes. The engine is now written in Go and runs inside the `friday` binary itself. You start it the way you always did:

```bash
friday                          # a session in this directory
friday "fix the failing test"   # a session that starts with a request
friday --resume latest          # carry on where you left off
friday acp                      # the engine on stdio, for an editor (Zed, JetBrains)
```

There is nothing to add after `friday`. Friday picks its engine on its own: the Go engine by
default, and the earlier TypeScript engine only for a session that needs something the Go engine
does not have yet (see [Which engine runs](#which-engine-runs)).

## The documents

| Document | For | What it covers |
| --- | --- | --- |
| [User guide](USER_GUIDE.md) | Everyone using Friday | Sessions, modes and approvals, how Friday works through a task, sub-agents in the foreground and background, steering, resuming, compaction, models, limits, troubleshooting |
| [Configuration](CONFIGURATION.md) | Everyone setting Friday up | Every setting and environment variable the engine reads, provider keys and models, the small model, command rules, role files, project instructions |
| [Tools](TOOLS.md) | Everyone, and role authors | Every tool the model can call: arguments, what it may change, when it asks |
| [Sub-agents](SUBAGENTS.md) | People delegating work, and role authors | Roles, foreground and background runs, fork modes, worktrees, waiting, following up, restart safety, writing your own role |
| [Editors and ACP](EDITORS.md) | People using Friday from an editor | `friday acp`, what an editor sees, the `_archymedes/*` extension |
| [Architecture](ARCHITECTURE.md) | Contributors | Packages and layering, a turn from request to reply, threads on disk, concurrency, the provider layer, design decisions and the research behind them |
| [Protocol reference](PROTOCOL.md) | Contributors and client authors | Every ACP method and extension event the engine speaks, with examples |
| [Extending the engine](EXTENDING.md) | Contributors | Adding a tool, a role, a provider or a method; porting a TypeScript feature; tests and guards |
| [The mechanism design system](../mechanisms/README.md) | Contributors | The standard every command, flag, key, setting, message, tool, role, method and event is built to, and the checks that hold it |

[`docs/continuation/GO_ENGINE.md`](../continuation/GO_ENGINE.md) is the working design note and
[`TRACKER.md`](../continuation/TRACKER.md) (WS-35, WS-36) the record of how it was built and verified.

## What is new on the Go engine

- **Sub-agents that keep working while Friday does.** Friday can start a sub-agent in the
  background, keep working, and collect its report when it is ready. It can also send a running
  sub-agent more instructions, or re-open a finished one with a follow-up. A sub-agent that edits
  files in the background does so on its own git branch, so its edits never collide with Friday's.
- **Nothing lost to a crash or a quit.** Every step is saved. A sub-agent cut off by a crash or by
  closing Friday resumes when you open the session again.
- **Steering mid-turn.** What you type while Friday works reaches it at its next step, not after
  the turn.
- **Cheap work on a cheap model.** Searching, checking, compaction and session titles can run on a
  smaller model of the same provider (`<PROVIDER>_SMALL_MODEL`).
- **It notices when it is going in circles.** Repeating the same call with nothing changed earns a
  warning, then a stop, instead of spending the rest of the budget.
- **Rate limits are waited out.** When a provider says "try again in 11 seconds", Friday waits that
  long instead of failing.
- **One binary.** The Go engine needs no Node.js for a session; the TypeScript agent is only used,
  when it is installed, for settings, providers and the modes listed below.

## Which engine runs

Friday decides once, when it starts, in this order:

1. **Your explicit choice.** `--engine go` or `--engine ts`, else the `ARCHYMEDES_ENGINE`
   environment variable, else **Settings → Engine** (open Settings with alt+s or `/settings`). An
   explicit choice is always followed.
2. **Otherwise the Go engine**, unless this session needs something only the TypeScript engine has.
   Then the TypeScript engine runs it, without being asked:

| The session… | Because |
| --- | --- |
| runs on Claude Code or Codex (your own subscription) | those are engines of their own, driven by the TypeScript engine |
| uses Archymedes Cloud | its routed provider is not in the Go engine yet |
| uses keyless free mode through a free gateway | the gateway client is not in the Go engine yet (free mode with your own `OPENROUTER_API_KEY` runs on Go) |
| asks for `--sandbox docker` or `--sandbox e2b` | the Go engine runs on this computer only |
| asks for a money budget (`--budget`, `--max-rwf`) or another flag the Go engine does not honour | it never quietly ignores a limit you set |
| resumes a session the TypeScript engine wrote | each engine reads its own sessions |

If the TypeScript agent is not installed, the Go engine always runs.

**Non-interactive modes** — `friday --json "…"`, a piped request, `friday doctor`, `update`,
`history`, `settings`, `login` — are still served by the TypeScript agent, exactly as before.

## What the Go engine does not have yet

These are on the TypeScript engine only. A command that is not there says so, and tells you how to
switch:

- Claude Code and Codex as engines; Archymedes Cloud; keyless free mode
- Docker and E2B sandboxes; the Linux command sandbox (bubblewrap)
- Checkpoints and `/undo`, `/rewind`, `/diff`, `/cost`, `/review`, `/fork`, goals
- MCP servers and LSP diagnostics
- Jev, defender's knowledge index (`query_defensive_brain`), web search and fetch,
  `start_application`
- Money budgets and prices; reasoning effort per call; images
- The headless `--json` mode (served by the TypeScript agent)

To use one of these, set **Settings → Engine** to **TypeScript** (or `ARCHYMEDES_ENGINE=ts`) and
start a new session. Sessions do not move between engines.
