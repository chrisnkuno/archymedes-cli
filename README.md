# Friday CLI

A coding agent that runs in your terminal — against your working tree, or inside an isolated
remote sandbox when the work shouldn't touch your machine.

```bash
npm install -g @archymedes/friday
friday "fix the failing test in src/parser.ts"
```

Friday's engine is written in Go and runs inside the `friday` binary: helpers (sub-agents) that
keep working in the background, steering mid-turn, sessions that survive a crash, and cheap work on
a cheap model. It drives Claude Code on your subscription too. Sessions that need what only the
earlier TypeScript engine has (Codex, sandboxes, `/undo`) run there on their own. **Documentation: [`docs/engine/`](docs/engine/README.md)**
— a [user guide](docs/engine/USER_GUIDE.md), [configuration](docs/engine/CONFIGURATION.md),
[tools](docs/engine/TOOLS.md), [sub-agents](docs/engine/SUBAGENTS.md),
[editors](docs/engine/EDITORS.md), [architecture](docs/engine/ARCHITECTURE.md),
[protocol](docs/engine/PROTOCOL.md) and [extending it](docs/engine/EXTENDING.md).

Open source under the Apache License 2.0. Friday CLI began as a fork of the Nova coding agent
(MIT) and has since been rebranded end to end; see `NOTICE`.


**Contents:** [Providers](#providers) · [Custom commands](#custom-commands) · [Cost and balance](#cost-and-balance) · [Install count](#install-count) · [Languages](#languages) · [Layout](#layout) · [Develop](#develop) · [Contributing](#contributing) · [License](#license) · [Release checks](#release-checks) · [Continuing development](#continuing-development)

## Providers

Direct providers use their native or OpenAI-compatible APIs. Archymedes Cloud instead sends a
capped request to the execution exchange, which selects the provider and returns a routing receipt:

| Provider | Key | Default model |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.6-terra` |
| Archymedes Cloud (not generally available) | `ARCHYMEDES_CLOUD_TOKEN` + `ARCHYMEDES_CLOUD_BASE_URL` | `auto` (policy routed) |
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.5-pro` |
| xAI Grok | `XAI_API_KEY` | `grok-4` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| Mistral | `MISTRAL_API_KEY` | `mistral-large-latest` |
| Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| Ollama (local) | — | `llama3.1` |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` | your choice |
| Free models (`--free`) | `OPENROUTER_API_KEY`, or a self-hosted free gateway | `openrouter/free` |

Set `<PROVIDER>_MODEL` to pick a model; the defaults are conservative and recorded once.

### Claude, on your Claude subscription

Choose **Claude (your subscription)** in Providers (alt+p), or start with `--provider claude`.
Archymedes then runs your own [Claude Code](https://code.claude.com/docs/en/setup), signed in with
your Claude account. Its work shows in the same interface: streamed replies, approvals, Changes,
`/undo` (Claude Code's file checkpoints), `/resume`, and switching to or from any other model
mid-session with the conversation carried over.

- **Your account stays with Claude Code.** Signing in is Claude Code's own flow (`claude auth
  login`, which Providers runs for you); Archymedes never reads, stores or forwards a Claude
  credential. It asks `claude auth status` only whether you are signed in and on which plan.
- **Your subscription, not an API key.** `ANTHROPIC_API_KEY` is removed from Claude Code's
  environment, since with it Claude Code bills the key instead; set `ARCHYMEDES_CLAUDE_BILLING=api`
  to keep it. Turns count against your plan's limits, as using Claude Code does.
- **Fast.** Claude Code is started when the session opens, before you type, and stays running.
  Each turn is one more message to the same process: no start-up per turn, and the prompt cache
  stays warm (in testing, over 99% of input tokens after the first turn).
- **Anthropic's SDK is installed, not bundled.** Connecting installs `@anthropic-ai/claude-agent-sdk`
  (about 5 MB, its JavaScript only) from npm into Archymedes's settings folder. It is Anthropic's
  code under Anthropic's terms, so Archymedes does not ship it. `ARCHYMEDES_CLAUDE_SDK` points at
  another copy and `ARCHYMEDES_CLAUDE_PATH` at another `claude`.
- `CLAUDE_MODEL` picks the model (`opus`, `sonnet`, `haiku` or an id; Claude Code's default
  otherwise). Claude Code works on this machine only, so it is not offered with `--sandbox`.

Anthropic's rules for using a Claude subscription outside its own apps have changed several times
in 2026; see its [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page.
Archymedes only drives the unmodified Claude Code you installed and signed in to yourself.

### Codex, on your ChatGPT plan

Choose **Codex (your ChatGPT plan)** in Providers, or start with `--provider codex`. Archymedes then
runs your own [Codex CLI](https://developers.openai.com/codex/cli) through `codex app-server`, and
its work shows the same way. That means streamed replies, its commands and file changes as the usual
cards (a change's result is its diff), and approvals in the interface. It also means `/undo` and
`/rewind` (Archymedes's own checkpoints, taken before each Codex turn), steering mid-turn,
`/compact`, `/resume` (Codex's own thread), and switching to or from any other engine with the
conversation kept.

- **Your account stays with Codex.** Signing in is `codex login` (Providers runs it for you);
  Archymedes asks `codex login status` only whether you are signed in. `OPENAI_API_KEY` is removed
  from Codex's environment unless `ARCHYMEDES_CODEX_BILLING=api`.
- **Modes are Codex's own sandbox.** Plan is Codex's read-only sandbox with no escalation; build
  runs in its workspace sandbox and asks before anything not known to be safe; auto asks only to
  leave the sandbox.
- `CODEX_MODEL` picks the model from the list Codex gives (Codex's own default otherwise; a
  default your plan cannot use fails with Codex's own explanation — pick another in Providers).

**Switching keeps the conversation.** An engine that has never seen the session is told what was
said. One coming back to a session it ran before resumes its own conversation and is told only what
was said while it was away (Claude → Codex → Claude loses nothing). What is passed is what was said,
not tool state: the work is in the files.

`archymedes --free` runs on zero-priced OpenRouter models with no Archymedes Cloud account and no
paid fallback. With your own `OPENROUTER_API_KEY` it goes to OpenRouter directly. Without a key it
needs a [free gateway](packages/free-gateway/README.md) reachable at `ARCHYMEDES_FREE_GATEWAY_URL`,
which holds the key server-side and rate limits requests. The hosted public gateway is not generally
available yet, so today that means running your own (the `packages/free-gateway` package deploys
standalone). Only `openrouter/free` or exact `publisher/model:free` IDs that OpenRouter lists at zero price with tool
support are accepted; every request carries a zero maximum price, and free mode never falls back to
a paid provider. Free capacity is rate limited either way. Model discovery also
reads [ClawLabsAI/free-ai-models](https://github.com/ClawLabsAI/free-ai-models).

## Custom commands

Save a prompt you reuse as Markdown: `.archymedes/commands/audit.md` becomes `/audit` for the
project. `commands/audit.md` in the Archymedes config directory is yours alone (the project file
wins). `$ARGUMENTS` is replaced by the text typed after the command, and an optional
`description:` line in `---` front matter describes it. Built-in commands cannot be replaced.
They complete as you type `/`, appear in `/help` and the start menu, and run as a prompt (queued if
a turn is running). A body without `$ARGUMENTS` gets what you typed appended.

```markdown
---
description: Review a change for data-loss risks
---
Review $ARGUMENTS for data-loss risks. List each risk with the line it comes from.
```

## Cost and balance

For direct/BYOK providers, costs are shown in your local currency and `/balance` tracks a local
spend figure you set yourself. Archymedes Cloud is not generally available: the client adapter
ships, but accounts, credits, and the hosted exchange are private and gated. Once provisioned,
`/balance` on `archymedes-cloud` reads the account's real
credit ledger: what is available now, what is reserved against work in flight, and what has settled.
The two are never combined — one is a pacing limit you chose, the other is money. Archymedes credits
are closed-loop: usable for Archymedes services, not transferable and not withdrawable.

When `archymedes-cloud` is selected, every model call reserves a configurable hard cap
(`ARCHYMEDES_CLOUD_MAXIMUM_MICROS`, default 5,000,000 USD micros); the exchange settles measured
usage and releases the remainder. Each hosted turn prints a routing receipt, and `/route` recalls
them. A receipt names the chosen model, the alternatives weighed and why each was passed over, the
policy it was held to, and the estimate against the actual charge. `/route plan` asks the same question in
advance: what the next turn would be routed to and what the whole task would be expected to cost,
before any of it is spent. It calls no model and reserves nothing. `/route summary` shows session
totals by currency, retries, route switches, and calls without settlement data.
`ARCHYMEDES_CLOUD_TASK_KIND` (coding, design, architecture, security, research, deployment) tells the
exchange what kind of work it is routing. Billing and hosted execution are operated from isolated private services; this public
repository contains only their client contract.

`/balance` and `/route` are not in the Go interface yet (WS-7); `/cost` shows what a session has
spent, and a one-shot `--json` run reports its own cost.

## Install count

The first time each new version runs, Friday sends one anonymous request to
`https://archymedes.xyz/api/v1/count/` so installs and updates can be counted. It carries exactly
`{ event: "install" | "update", version, os, arch }`: no identifier, path, project, account or
prompt. The server keeps totals only; to count each network once per version and day it keeps a
daily-salted hash of the address for two days, never the address itself.

Turn it off with `ARCHYMEDES_TELEMETRY=off` (or **Install count** in Settings) or the standard
`DO_NOT_TRACK=1`. It is never sent from CI or test runs, never delays startup, and is retried on
the next run if the network is down. The code is
[`packages/friday-cli/src/platform/install-cue.ts`](packages/friday-cli/src/platform/install-cue.ts).

## Languages

The control surfaces are localized into 16 languages — `friday --language <code>` or
`/settings`. See [`packages/friday-cli/I18N.md`](packages/friday-cli/I18N.md).

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `cmd/friday`, `internal/` | `@archymedes/friday-<platform>-<arch>` (Go) | The interactive interface (Bubble Tea v2) and, in `internal/core/`, the Go engine it runs by default, over ACP through in-process pipes. |
| `packages/friday-cli` | `@archymedes/friday` | The TypeScript agent (sessions that need it, `--json`, `settings`, `doctor`, the methods the Go engine forwards) and the npm launcher that runs the Go binary. |
| `packages/core` | `@archymedes/core` | Provider-neutral agent runtime, model adapters, workspaces (local and sandboxed), cost accounting. Internal CLI-only code lives under `src/cli/`. |
| `packages/archymedes-state` | `archymedes-state` (Rust) | The local, rebuildable history and memory index. Optional at runtime — the CLI falls back to a portable TypeScript projection. |
| `packages/free-gateway` | `@archymedes/free-gateway` (private) | Separately deployed server behind `archymedes --free`: holds the OpenRouter key, serves only verified free models, rate limits. |
| `tooling/build` | — | Builds the packages into something npm can install. |

## Develop

```bash
bun install
bun run archymedes            # run the CLI from source: the Go interface and engine (this checkout's TS agent for what it forwards)
bun run agent "a request"     # the TypeScript agent alone, for one-shot and --json runs
bun run test                  # vitest
bun run test:invariants       # seeded random model and random user: the runtime's and the desktop's invariants
bun run test:live             # one real tool round trip per configured provider (spends a few hundred tokens each)
bun run test:live --census    # which tool names each model reaches for, ours or not
bun run typecheck             # tsc --noEmit
bun run build:packages        # emit packages/*/dist
bun run build:state           # cargo build the Rust state binary (optional)
```

### The interface and the engine are Go

The terminal interface is a Go program on [Bubble Tea v2](https://github.com/charmbracelet/bubbletea)
(`cmd/friday`, `internal/`). The engine behind it is, by default, the Go engine in the same
binary (`internal/core/`, see [docs/engine](docs/engine/ARCHITECTURE.md)), driven over the Agent
Client Protocol with Friday's `_archymedes/*` extensions through in-process pipes. A session that
needs what only the TypeScript agent has runs on it instead, as `friday acp` under Node, without
being asked (`--engine ts`, `ARCHYMEDES_ENGINE=ts` or Settings → Engine choose it for every
session). Non-interactive modes (`--json`, piped prompts, `doctor`, `update`, `history`,
`settings`) go to the TypeScript agent unchanged. There is no TypeScript interface: the agent run with no
request says where the interface is. The npm package ships one static binary per platform as an
optional dependency (`@archymedes/cli-<platform>-<arch>`). Where none can be used, the bundled
agent still serves every non-interactive mode; asked for the interface, it says why there is none
and how to install it.

```bash
bun run archymedes                      # from a checkout: go run ./cmd/friday (`bun run dev` too)
go test ./...                           # Go tests; `bun run check` runs these too
bun run build:go                        # all six platform binaries → artifacts/npm
ARCHYMEDES_ACP_TRACE=/tmp/acp.log go run ./cmd/friday   # log every protocol frame
go test -race ./internal/core/... ./cmd/friday   # the Go engine, its contract through the real client
FRIDAY_LIVE=1 go test ./cmd/friday -run Live -v  # the Go engine against your own provider (a few cents)
```

The interface is a small desktop, driven by the arrows and the mouse. Before the first message the
home screen is a desktop. Icons run down its left edge, the card with the prism sits in the middle,
and the tour's scenes play on the right. ↑ steps onto the icons, the arrows move between them, and enter opens one. A
click selects, and a second click on the same thing opens it. Each app opens as a window floating
on the wallpaper, its body frosted glass, with ▢ to zoom and ✕ to close. Its keys are buttons along
its foot. esc steps out to the bars: the arrows walk the tabs and the dock, and enter switches. In a
conversation, ↑ steps onto the newest message or tool call; enter opens it and space reads it in a
reader. Earlier messages are ctrl+↑. The wheel scrolls what is under the pointer
([the full grammar](docs/mechanisms/README.md#10-interaction)). The top bar has a `◇` start menu
(ctrl+space finds any app, action, session or file) and a tab per open window. The dock along the bottom has every app and its
key: F1 Chat, F2 Files, F3 Search, F4 Sessions, F5 Models, F6 Themes, F7 Keys, F8 Help, F9 Stats,
F10 Changes, F12 Gallery. Click or press. The Finder (`alt+g`, `/finder`) shows everything Friday
can open as a grid of icons drawn in colour: apps, commands, sessions, the project's files folder by
folder, themes and modes. Typing searches all of them, space looks inside one, and enter opens it.
`/theme`, `/wallpaper`, `/mode`, Providers and the
Settings sections are grids of square tiles, each a preview, moved through with all four arrows. In lists ↑/↓ move and enter picks; the side arrows
step a setting's choice in place, turn Gallery pictures, and switch the model list between all,
free and ready.

Changes is the working tree against the last commit, file by file: each file's lines added and
removed, and the selected file's diff with old and new line numbers. It reads again when a turn
ends, so the agent's edits show as they land. Models lists every model of every provider, read live
from the providers, OpenRouter's whole catalog and every free model included. Tab narrows it to the
free ones or the ones ready to use; a model whose provider has no key yet shows the key it needs.

The home screen turns slowly through pictures in three themes: antiquity (Archimedes, the Greek
world, mathematics), sci-fi, and abstract. They are photographs from Unsplash, shipped in the
binary and credited on screen (see [`internal/gallery/CREDITS.md`](internal/gallery/CREDITS.md)),
and pictures Friday draws in code, credited "drawn by Friday". `/wallpaper` picks one, lets one
theme take turns, or turns them off. A click on the picture, or F12, opens the Gallery: the
built-in copy beside the full-resolution original loaded live from Unsplash's image CDN. It draws with the sharpest the terminal has, found by asking it. That is Kitty graphics
(kitty, Ghostty, WezTerm), else Sixel (Windows Terminal 1.22+, foot, mlterm, VS Code with images
on). Otherwise it uses half-block glyphs through ntcharts' picture component, two pixels a cell, so
they look pixelated at any size. g switches between the ways the terminal can draw; f changes the fit.
The home screen's photo is drawn the same way: in Sixel where the terminal draws it (asked once at
start), in glyphs otherwise. A first run opens a walkthrough of six steps: a name for the
greeting, kept on the machine; a theme and a mode, picked from tiles; four keys tried in place;
the connection and the install count; a first request. `alt+w` or `/welcome` opens it again. The home
screen then says what to do in three steps and offers requests to start from — tab puts one in the input, and when the project has
uncommitted changes the first offer is to review them. A turn that changed files ends with up to
three next steps, and alt+1..3 or tab put one in the input. Each edit carries notes on what is worth
knowing about it. While you type, the row above the input offers the command or earlier request you
seem headed for. With a TypeSafe key, Jev weighs all three
([Suggestions while you work](docs/engine/USER_GUIDE.md#suggestions-while-you-work)). Stats draws the session as charts: tokens per turn, seconds per turn, output per model
call and tool use; while a turn runs, a small sparkline in the top bar shows how fast the reply
is streaming. Change any key in the Keys app (F7); changes are saved to `keys.json` next to the
settings file.

| Variable | Does |
| --- | --- |
| `ARCHYMEDES_REDUCE_MOTION=1` | Turns off animated scrolling; the photos stay still |
| `ARCHYMEDES_PHOTOS=off` | Leaves the photos out |
| `ARCHYMEDES_PHOTOS=local` | Keeps the photos to the built-in copies; the Gallery fetches nothing |
| `ARCHYMEDES_WALLPAPER=off` | Keeps the photos, but not behind the screen |
| `ARCHYMEDES_MODELS_OFFLINE=1` | Keeps the model list to its cache unless refreshed |
| `ARCHYMEDES_DEBUG_LOG=<file>` | Writes a structured log of what the interface does |

`ARCHYMEDES_AGENT` overrides the agent command (a JSON array, or a space-separated string). Commands
the interface does not have yet say so when typed; WS-7 in [`TRACKER.md`](docs/continuation/TRACKER.md)
lists them.

See [`docs/PLATFORM_STATUS.md`](docs/PLATFORM_STATUS.md) for repository ownership and integration
status. The authenticated hosted boundary is documented
in [`docs/EXCHANGE_API.md`](docs/EXCHANGE_API.md).

## Contributing

See `CONTRIBUTING.md`. Commits are signed off under the [DCO](https://developercertificate.org/)
(`git commit -s`); there is no CLA.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`. The Apache license does not grant rights to the
"Archymedes" name or marks — see `TRADEMARK.md`.

## Release checks

```bash
bun run release:check
```

The release check runs every test (TypeScript, Go and the terminal suites), type-checks, builds,
and validates the packed CLI in a separate consumer project: the Go interface, the agent behind
it, and what an install without the interface says. See the
[release procedure](docs/RELEASING.md) for building and publishing.

## Continuing development

See the [agent handoff](docs/continuation/START_HERE.md), [architecture map](docs/continuation/ARCHITECTURE.md), and [prioritized roadmap](docs/continuation/PRIORITIES.md) for current work, validation status, and concrete follow-up tasks.
