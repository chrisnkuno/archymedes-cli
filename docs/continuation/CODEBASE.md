# The codebase, section by section

Updated 2026-10-18 (WS-27). This is the current map: what each part owns, what it may depend on,
and where new code goes. The rules here are checked by `bun run recheck` (see
[WORKFLOW.md](WORKFLOW.md)); when this page and a guard disagree, the guard is right and this page
is stale.

## The system in one picture

```
Go interface (friday)                          TypeScript agent (friday acp)
cmd/friday ──▶ internal/tui ──ACP over stdio──▶ packages/friday-cli/src/acp-server.ts
                  │                                  │
                  ├─ internal/acp   (client)         ├─ app/            engines and ACP handlers
                  ├─ internal/render (markdown,      │    ├─ claude/    the person's Claude Code
                  │   tool calls, the mark)          │    └─ codex/     the person's Codex
                  ├─ internal/theme                  └─ @archymedes/core
                  ├─ internal/project (git)               ├─ cli/        Friday's agent: tools,
                  ├─ internal/config                      │              permissions, sessions
                  └─ internal/gallery                     ├─ agent-runtime.ts  the model/tool loop
                                                          └─ providers/  one adapter per vendor
```

Three engines run a session: Friday's own agent (`core/cli/agent.ts` on any provider), Claude Code
(`app/claude/`) and Codex (`app/codex/`). All three speak to the interface through the same ACP
messages, so the interface never knows which one is running. One rule follows from that: **a mode
means the same thing on every engine.** Friday's `PermissionPolicy.decide` (core) is the reference,
and each engine's permission bridge (`app/claude/permissions.ts`, `app/codex/session.ts`) maps onto it.

## Go: `internal/` and `cmd/`

Packages, and what each may import (`tooling/check/go-sections.json`, guard `go-layering`):

| Package | Owns | May import |
| --- | --- | --- |
| `theme` | Colours and styles by role | — |
| `acp` | The ACP client: frames, requests, the event stream | — |
| `config` | The interface's own state.json and keys.json | — |
| `gallery` | Photographs and their credits | — |
| `project` | Git: status, diffs, branches, worktrees | — |
| `cli` | Arguments and pass-through to the agent | — |
| `render` | Markdown, tool-call cards, the mark | `theme` |
| `tui` | The interface | all of the above |
| `cmd/friday` | Wiring | anything |

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

`packages/friday-cli/src` is sectioned by directory, with an import matrix
(`tooling/check/sections.json`, guard `layering`):
`text` ← `platform` ← `catalog`/`theme` ← `terminal` ← `render` ← `ui` ← `commands` ← `app` ← root.
`session` depends only on `theme`, `platform` and `text`. Root files are entry points
(`friday.ts`, `acp-server.ts`, `headless.ts`). Engines live in `app/<engine>/` as
`backend.ts` (availability, setup), `session.ts` (one session), `translate.ts` (their events → ours)
and, for policy, a pure module such as `permissions.ts`.

`packages/core/src` is not sectioned yet: `cli/` holds 59 modules side by side (see the backlog).

## Where does it go?

| You are adding | Put it in |
| --- | --- |
| A tool for Friday's models | `core/cli/tools.ts` today (splitting it is backlog), declared with its `effect` |
| A permission rule | `core/cli/permissions.ts`, and the same rule in each engine bridge |
| A provider | `core/providers/<vendor>.ts`, dialect quirks in `chat-dialects.ts` |
| An ACP method | `core/cli/acp.ts` (protocol), handler in `friday-cli/src/app/acp-*.ts`, client in `internal/acp` |
| An app, dialog or command in the interface | `internal/tui/<prefix>_<name>.go` (above) |
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

`bun run recheck` also runs typecheck, the unit tests related to changed TS files, `go vet ./...`
and `go test` for the Go packages that changed (`--all`/`--pty`: every Go package).

## Organization backlog

Tracked in [TRACKER.md](TRACKER.md) under WS-27, safest first:

1. **Leftovers of the TypeScript interface** (removed in WS-11): 61 exports in
   `packages/friday-cli/src` that nothing reaches (`recheck --unwired` lists them), most of
   `render/tui.ts`, `ui/`, `catalog/commands.ts`. They made `recheck` red before WS-27; delete
   them after confirming each with grep, then lock the baseline.
2. **Two wrong-way imports in `platform/`**: `settings.ts` → `theme`, `update.ts` → `terminal`.
3. **Split `core/cli/tools.ts`** (1,623 lines) into `core/cli/tools/<family>.ts`: files, search,
   commands and applications, web, planning, delegation.
4. **Section `core/cli/`** by directory, as `friday-cli/src` is: `tools/`, `permissions/`,
   `session/`, `defender/`, `jobs/`, with a matrix in `sections.json`.
5. **`core/cli/agent.ts` and `agent-runtime.ts`** (about 1,600 lines each): extract seams one at a
   time behind explicit context types (QUALITY_PASS phase 3.4).
6. **Pure parts out of `internal/tui`** into packages of their own once they need no `*Model`: the
   tour scenes, the rate-limit forecast, the diff parsing in Changes.
