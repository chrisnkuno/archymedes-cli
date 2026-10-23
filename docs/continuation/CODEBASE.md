# The codebase, section by section

Updated 2026-10-23 (WS-35: the Go engine). This is the current map: what each part owns, what it may depend on,
and where new code goes. The rules here are checked by `bun run recheck` (see
[WORKFLOW.md](WORKFLOW.md)); when this page and a guard disagree, the guard is right and this page
is stale.

## The system in one picture

```
Go interface (friday)                          TypeScript agent (friday acp)
cmd/friday ──▶ internal/tui ──ACP over stdio──▶ packages/friday-cli/src/server/
                  │                                  ├─ engines/   Claude Code, Codex, the contract
                  ├─ internal/acp   (client)         ├─ setup/     provider choice, free setup
                  ├─ internal/render (markdown,      └─ @archymedes/core
                  │   tool calls, the mark)               ├─ cli/        Friday's agent: tools,
                  ├─ internal/theme                       │              permissions, sessions
                  ├─ internal/project (git)               ├─ agent-runtime.ts  the model/tool loop
                  ├─ internal/config                      └─ providers/  one adapter per vendor
                  └─ internal/gallery
```

**The default engine is Go**, inside the `friday` binary: `internal/core/`, speaking the same ACP
to the same interface, and forwarding what it lacks to the TypeScript agent; a session that needs
the TypeScript engine runs there by itself (`cmd/friday/engine.go`). Its design is in
[GO_ENGINE.md](GO_ENGINE.md), its documentation in [`docs/engine/`](../engine/README.md). The
TypeScript engines below remain for what the Go engine does not have yet.

Three engines run a session: Friday's own agent (`core/cli/agent.ts` on any provider), Claude Code
(`engines/claude/`) and Codex (`engines/codex/`). All three speak to the interface through the same ACP
messages, so the interface never knows which one is running. One rule follows from that: **a mode
means the same thing on every engine.** Friday's `PermissionPolicy.decide` (core) is the reference,
and each engine's permission bridge (`engines/claude/permissions.ts`, `engines/codex/session.ts`) maps onto it.

## Go: `internal/` and `cmd/`

Packages, and what each may import (`tooling/check/go-sections.json`, guard `go-layering`):

| Package | Owns | May import |
| --- | --- | --- |
| `theme` | Colours and styles by role | — |
| `acp` | The ACP client: frames, requests, the event stream | — |
| `config` | The interface's own state.json and keys.json | — |
| `gallery` | Photographs and their credits | — |
| `i18n` | The interface's words per language (`locales/<lang>.json`, English fallback); see [LANGUAGES.md](LANGUAGES.md) | — |
| `project` | Git: status, diffs, branches, worktrees | — |
| `cli` | Arguments and pass-through to the agent | — |
| `render` | Markdown, tool-call cards, the mark | `theme` |
| `tui` | The interface (its words through `m.text.T(key)`) | all of the above |
| `core/*` | The Go engine, one section per package (`core/tool`, `core/loop`, `core/agents`…); its own matrix is in [GO_ENGINE.md](GO_ENGINE.md) | other `core/*` only |
| `cmd/friday` | Wiring; `engine.go` runs the Go engine in-process or on stdio | anything |

`internal/tui` is one Go package (every app hangs off `*Model`), so its sections are **file
prefixes**, and every non-test file has one (guard `sections`):

| Prefix | Section | Examples |
| --- | --- | --- |
| `core_` | The model, update loop, input routing, screen composition, action registry | `core_model.go`, `core_events.go`, `core_keyboard.go`, `core_view.go`, `core_keys.go` |
| `chat_` | The Chat window | `chat_transcript.go`, `chat_items.go`, `chat_composer.go`, `chat_approval.go` |
| `home_` | The home screen before the first message | `home_landing.go`, `home_welcome.go`, `home_drawer.go` |
| `desk_` | The desktop around the windows | `desk_bars.go`, `desk_shell.go`, `desk_start.go`, `desk_wallpaper.go` |
| `app_` | One app per file; its parts as `app_<name>_<part>.go` | `app_changes.go`, `app_changes_branches.go`, `app_settings.go`, `app_tour.go` |
| `dialog_` | Modal flows over a window | `dialog_connect.go`, `dialog_models.go`, `dialog_resume.go` |
| `cmd_` | Slash commands | `cmd_registry.go`, `cmd_session.go`, `cmd_gitflow.go`, `cmd_rewind.go` |

Tests take their file's name (`chat_composer_test.go`). A test spanning sections starts with
`suite_` (`suite_invariants_test.go`, `suite_design_test.go`).

**Adding to the interface.** A new app is `app_<name>.go` implementing `window` (`desk_shell.go`),
registered in `core_keys.go` for its key and in `cmd_registry.go` if it has a slash command. A new
command goes in `cmd_registry.go` (one row) with its handler in the `cmd_` file of its family. Pure
drawing and arithmetic belong in a function that takes values, not `*Model`, so a unit test can
call it; the app keeps only the glue.

## TypeScript: `packages/`

| Package | Owns |
| --- | --- |
| `packages/core` | The agent: runtime loop, tools, permissions, sessions, checkpoints, providers, MCP, LSP, skills, hooks |
| `packages/friday-cli` | The `friday` command's TypeScript half: the ACP server, the engines, setup, settings, non-interactive modes |
| `packages/free-gateway` | The free-mode gateway (server side) |
| `packages/archymedes-state` | Rust: the rebuildable search index |

`packages/friday-cli/src` is two stacks over a shared bottom, sectioned by directory and enforced
by an import matrix (`tooling/check/sections.json`, guard `layering`):

```
entry     friday.ts ── dispatches: --acp → server/   flags → cli/   a request → run/

agent     server/   ACP for the Go interface: sessions on any engine, setup, settings, models, commands
side        └▶ engines/  Claude Code (claude/), Codex (codex/), handoff, contract.ts (what engines implement)
                └▶ setup/   which provider a session runs on, free-mode setup, Jev, setting choices

terminal  run/      one turn from the command line (friday "request", --json), the job worker
side        └▶ cli/      flags, --help, info and maintenance commands, prompts, themed output, exit codes
                └▶ commands/ → ui/ → render/ → terminal/ → catalog/

shared    session/  records, models, spend, history       theme/  palette roles and theme files
bottom    platform/ config paths, settings, network, updates, i18n, currency      text/  escapes, glyphs, width
```

The agent side never imports the terminal side. That is what lets the Go interface own every pixel:
nothing the server sends was drawn by TypeScript. An engine is `engines/<name>/` with `backend.ts`
(availability, setup), `session.ts` (one session), `translate.ts` (its events → ours) and pure
policy modules such as `permissions.ts`; it implements the types in `engines/contract.ts`.

`packages/core/src` is not sectioned yet: `cli/` holds 59 modules side by side (see the backlog).

## Where does it go?

| You are adding | Put it in |
| --- | --- |
| A tool for Friday's models | `core/cli/tools.ts` today (splitting it is backlog), declared with its `effect` |
| A sub-agent role | Built in: `BUILT_IN_SUBAGENTS` in `core/cli/subagents.ts` (and a line in `delegationGuidance`); a project's own: `.archymedes/agents/<name>.md` |
| What a run must show before it may finish (evidence, test first) | `core/src/verification-gate.ts`; the order of work it holds is also in `prompt.ts` (`testFirstLoop`) |
| A permission rule | `core/cli/permissions.ts`, and the same rule in each engine bridge |
| A command that should run unasked (it only reads) | `core/cli/command-readonly.ts` (read by run_command's `effectFor`, `PermissionLedger.decide` and the Claude bridge) |
| A provider | `core/providers/<vendor>.ts`, dialect quirks in `chat-dialects.ts` |
| An ACP method | `core/cli/acp.ts` (protocol), handler in `friday-cli/src/server/`, client in `internal/acp` |
| The hosted/remote bridge, accounts | `friday-cli/src/bridge/` (sandbox side), `friday-cli/src/account/` (login, keys); Worker in the site repo `workers/app/`; design in REMOTE.md |
| An engine | `friday-cli/src/engines/<name>/`, implementing `engines/contract.ts`, registered in `server/session.ts` |
| A command-line flag | `cli/args.ts`, handled in `cli/startup-commands.ts` (exits) or `run/` (runs a turn) |
| An app, dialog or command in the interface | `internal/tui/<prefix>_<name>.go` (above) |
| A tool, role, provider or ACP method of the Go engine | `internal/core/tools`, `core/roles`, `core/llm`, `core/server` (see [GO_ENGINE.md](GO_ENGINE.md)); the TypeScript one stays the reference until a method is ported |
| A rule of the mechanism design system | `internal/conform` (the rule), a `TestConform…` beside the registry it judges, and [docs/mechanisms](../mechanisms/README.md) |
| A guard | `tooling/check/guards.ts` (CLI) or `repo-guards.ts` (core, Go), with a test and a baseline entry |

## Guards

Each count is per file, kept in `tooling/check/baseline.json`; it may fall, never rise.

| Guard | Covers |
| --- | --- |
| `size` | Files over 800 lines in `packages/friday-cli/src`, `packages/core/src`, `internal/`, `cmd/` |
| `layering` | `packages/friday-cli/src` imports against `sections.json` |
| `go-layering` | `internal/*` imports against `go-sections.json` |
| `sections` | `internal/tui` files without a section prefix |
| `theme`, `helpers`, `unwired` | Raw colours, private copies of shared helpers, exports nothing reaches (`packages/friday-cli/src`) |

`bun run recheck` also runs typecheck, the unit tests related to changed TS files, `go vet ./...`,
every mechanism conformance test (`go test -run '^TestConform' ./...`: the standard in
[docs/mechanisms](../mechanisms/README.md), with its rules in `internal/conform`), and `go test`
for the Go packages that changed (`--all`/`--pty`: every Go package).

## Tools for structural work

| Tool | Does |
| --- | --- |
| `bun run tooling/check/remove-dead.ts` | Deletes exports nothing reaches, their tests, and what that leaves unused, in waves until none |
| `bun run tooling/check/move-declarations.ts <from> <to> <Name>…` | Moves declarations with their comments, writes the imports, repoints every importer |
| `python3 tooling/check/rewrite_imports.py move-files <map.json>` | `git mv` files (tests follow) and rewrites every import |
| `python3 tooling/check/module_map.py` | Regenerates [MODULE_MAP.md](MODULE_MAP.md) from the import graph |

## Organization backlog

Tracked in [TRACKER.md](TRACKER.md) under WS-27, safest first:

1. **A lean one-shot run.** `friday "request"` runs one turn, but `friday.ts` still builds the
   old REPL's session state (forty getters and setters: tabs, wander, watch, navigation hints,
   live models) and `run/turn-runner.ts` reads it. The target: open a session, run the turn,
   print it (human or JSONL), exit, with the terminal stack below it cut to what that needs.
2. **`render/tui.ts`** (928 lines): what is left after the dead code went is the shared
   drawing kit for `cli/`; split by kind (boxes, tables, widths).
3. **Split `core/cli/tools.ts`** (1,623 lines) into `core/cli/tools/<family>.ts`: files, search,
   commands and applications, web, planning, delegation.
4. **Section `core/cli/`** by directory, as `friday-cli/src` is: `tools/`, `permissions/`,
   `session/`, `defender/`, `jobs/`, with a matrix in `sections.json`.
5. **`core/cli/agent.ts` and `agent-runtime.ts`** (about 1,600 lines each): extract seams one at a
   time behind explicit context types (QUALITY_PASS phase 3.4).
6. **Pure parts out of `internal/tui`** into packages of their own once they need no `*Model`: the
   tour scenes, the rate-limit forecast, the diff parsing in Changes.
