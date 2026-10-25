# The mechanism design system

The standard every mechanism of the Friday CLI is built to: commands, flags, keys, settings,
messages, tools, sub-agent roles, protocol methods, events, files and exit codes. A visual
design system fixes how things look; this one fixes how things work and how they are named, and
checks it.

It is built for precision in two senses. From Swiss typography: one grid for everything, words
with one meaning, no ornament, structure visible. From Swiss watchmaking: every part made to a
stated measure, every measure checked, and a tolerance of zero.

The rules are code: [`internal/conform`](../../internal/conform/conform.go). Each registry is held
to them by a `TestConform…` test beside it, and `bun run recheck` runs every one of them on every
run. There is no list of excused exceptions. A rule that does not fit is changed in code, in this
document and in the tracker, together.

1. [Principles](#1-principles)
2. [Vocabulary](#2-vocabulary)
3. [Names](#3-names)
4. [Measures](#4-measures)
5. [Words people read](#5-words-people-read)
6. [The catalog](#6-the-catalog)
7. [Recipes](#7-recipes)
8. [Documentation](#8-documentation)
9. [Conformance](#9-conformance)
10. [Interaction](#10-interaction)

## 1 Principles

| # | Principle | In practice |
| --- | --- | --- |
| 1.1 | **One table per mechanism.** | Every slash command is a row of `commands`; every key a row of `actions`; every tool an entry of `Builtins()`; every protocol method a row of `methods`. Dispatch, completion, help, the docs check and the conformance test all read the same table, so what is shown is what works. |
| 1.2 | **It explains itself.** | A name and its one line say what happens, to someone who has not read the docs. No line refers to another ("The same", "As above"). |
| 1.3 | **One meaning per word.** | A word in the [vocabulary](#2-vocabulary) means one thing everywhere: interface, engines, protocol, docs. |
| 1.4 | **Same behaviour on every surface.** | A mode, an approval, a tool's arguments, an event's JSON mean the same on the Go engine and the TypeScript engine, in the interface and in an editor. |
| 1.5 | **Nothing is dropped silently.** | A flag, setting, rule or limit that cannot be honoured is refused, or the session goes where it can be (another engine), with the reason. It is never ignored. |
| 1.6 | **Measured, not felt.** | Lengths, limits, codes and timeouts are numbers, written down here, and held by a check. |
| 1.7 | **Checked, not remembered.** | Every rule in sections 3–6 names the test that enforces it. A rule with no check is a wish, and is marked as one. |

## 2 Vocabulary

| Word | Means | Not |
| --- | --- | --- |
| **session** | one conversation in one folder, with its history, saved as it goes | chat, thread (for the whole) |
| **turn** | one request and all the work it causes, until the reply | run (for the person's view) |
| **step** | one model call and the tool calls it makes, inside a turn | iteration (in words for people) |
| **tool call** | the model asking for one tool with arguments | action, function call |
| **approval** | the person's answer to "Allow this?" | permission prompt (in words for people) |
| **mode** | how much Friday may do alone: `plan`, `build`, `auto`, `defender` | permission level, policy |
| **engine** | what runs a session behind the interface: the Go engine (default) or the TypeScript engine | agent (for the engine), backend |
| **provider** | who serves the model (Anthropic, Groq, OpenRouter…) | vendor, backend |
| **model** | which model of a provider: the **main** one, and the **small** one for cheap work | LLM (in words for people) |
| **sub-agent** | a helper the main conversation starts for part of a task, with a **role**; in prose for people, "helper" glosses it | worker, child agent |
| **thread** | a sub-agent's conversation inside a session, kept on disk | (never the whole session) |
| **background** | a sub-agent that keeps working while the turn goes on | async, detached |
| **steering** | what the person types while a turn runs, read at its next step | interrupt |
| **compaction** | replacing the earlier conversation with a summary | truncation (which is cutting a result) |
| **wallpaper** | the picture behind the whole screen | background (which is the colour) |
| **setting** | a value in `settings.json`, also readable from the environment | config, option, preference |
| **window** | an app on the desktop: a frame of frosted glass with a tab in the top bar, switched to and from | modal (for a window) |
| **dialog** | a question that must be answered before anything else: an approval, a confirmation, connecting a provider | popup |
| **bars** | the top bar's tabs and the dock's apps, walked as one row by keyboard | taskbar |

## 3 Names

Every name has the grammar of its kind, checked by `conform.Name`.

| Kind | Grammar | Examples | Checked by |
| --- | --- | --- | --- |
| slash command | `^[a-z][a-z0-9-]{0,19}$` | `/subagents`, `/goal-check` | `TestConformSlashCommands` |
| session command | the same as a slash command | `todos`, `compact` | `TestConformSessionCommands` |
| key action | lower-case words joined by `-` | `next-window` | `TestConformKeyActions` |
| tool | lower-case words joined by `_` | `read_file`, `wait_agents` | `TestConformBuiltinTools`, `TestConformRootTools` |
| sub-agent role | `^[a-z][a-z0-9-]{0,39}$` | `explore`, `db-migrations` | `TestConformBuiltInRoles` |
| flag | `--word(-word)*` or `-x` | `--no-mouse`, `-p` | `TestConformHelpNamesRealFlags` |
| protocol method | `initialize`, `authenticate`, `session/<word>`, `_archymedes/<path>` | `_archymedes/session/steer` | `TestConformMethods` |
| event | lower-case words joined by `_` | `tool_result`, `steering_unread` | `TestConformEvents` |
| setting / variable | upper-case words joined by `_`; Friday's own begin `ARCHYMEDES_` | `ARCHYMEDES_ENGINE`, `GROQ_API_KEY` | `TestConformEveryVariableIsDocumented` |

Names are unique within their kind (`conform.Unique`). The `ARCHYMEDES_` prefix, the `_archymedes/`
protocol prefix and the `.archymedes/` folder keep their names from before the product was called
Friday, so existing settings and installs keep working; new names follow them.

## 4 Measures

| Measure | Value | Why | Checked by |
| --- | --- | --- | --- |
| help line (command, method, session command) | ≤ 100 characters | one row of the command list at 120 columns, beside the name and hint | `conform.Help` |
| message (toast, notice) | ≤ 120 characters | one toast | `conform.Message` |
| label (key action) | ≤ 24 characters | the dock and the Keys app | `conform.Label` |
| role description | ≤ 100 characters | sent to the model beside the role on every request | `conform.RoleDescription` |
| tool description | ≤ 400 characters, whole sentences | sent with every request; shorter is cheaper | `conform.ToolDescription` |
| exit code | `0` done · `1` failed while running · `2` refused before starting | scripts can tell a usage error from a failure | `TestConformExitCodes` |
| source file | ≤ 800 lines | one sitting to review | the `size` guard |
| package imports | the matrix in `tooling/check/go-sections.json` | layering is a design, not an accident | the `go-layering` guard |

The engine's own limits (steps, tool calls, result sizes, retries, timeouts) are in the
[user guide](../engine/USER_GUIDE.md#limits-friday-keeps-to); they are constants in the code beside
what they limit.

## 5 Words people read

Help lines, messages, labels and errors follow one voice: plain, calm, exact.

| Rule | Example | Not | Checked by |
| --- | --- | --- | --- |
| A help line or message is a sentence: it starts with a capital, or as typed (`/`, `!`, `@`, `$`, `~`, `.`, a digit, a formatted value) | `Switch to plan mode: the agent reads and proposes` | `switch to plan mode` | `conform.Help`, `conform.Message` |
| One line has no full stop at the end; several sentences may | `Nothing to copy yet` | `Nothing to copy yet.` | the same |
| It stands alone: no reference to another row | `Earlier sessions in this project, newest first (same as /resume)` | `The same: earlier sessions` | the same |
| Calm: no exclamation marks, no capitals for emphasis (initialisms such as JSON, HEAD are fine) | `Rate limited; waiting 11s` | `RATE LIMITED!` | the same |
| Say what happened, not that something went wrong | `Nowhere to push: this repository has no remote` | `Error: push failed` | `conform.Message` (no `Error:`, `Failed:` openers) |
| A warning says what to do next, after `;` or `:` | `/goal between turns; esc stops this one` | `Cannot do that now` | a review rule (a wish: not mechanically checkable) |
| Keys are written as pressed, in lower case | `esc`, `ctrl+c`, `alt+s`, `shift+tab` | `Esc`, `Ctrl-C` | `conform.Help`, `conform.Message`, `conform.DocProse` |
| Labels are lower-case words | `next window` | `Next Window` | `conform.Label` |
| A tool description is written for the model: whole sentences, ending in a full stop | `Read a text file … offset/limit for very large ones.` | `reads files` | `conform.ToolDescription` |
| A tool's error to the model is a sentence; an argument is named as typed | `` `command` is required`` | `command is required`, `Error: …` | `conform.ToolText` |
| A Go error value follows Go: lower case, no closing punctuation; its caller adds the context | `unbalanced quote in command` | `Unbalanced quote in command.` | `conform.GoError` |
| A line the binary writes to stderr says whose it is | `friday: no agent found` | `no agent found` | `TestConformErrorsToolTextAndStderr` |
| A Settings row or choice reads as a help line | `Off — save with ctrl+s (default)` | `Off — save with Ctrl+S (default)` | `TestConformSettingsLabels` |

**Which channel.** A **toast** answers what the person did a moment ago and fades (`toastInfo` when it
worked, `toastWarn` when it could not, with what to do). A **notice** is a line in the transcript
that stays (`noticeFaint` for bookkeeping, `noticeInfo` for news, `noticeWarn` for what needs
attention, `noticeError` when something stopped working). An approval or a question is a dialog,
never a toast.

## 6 The catalog

Each mechanism: where its table is, what every row must satisfy, where it is documented, and the
test that holds it.

| Mechanism | Table | Contract | Documented in | Checked by |
| --- | --- | --- | --- | --- |
| **Invocation** | `cmd/friday/main.go` (`usage`), `internal/cli/args.go` (`KnownFlags`, `GoOnlyFlags`) | the help names only flags the parser knows; every flag only the binary reads is in the help; a flag the engine cannot honour is refused; exit codes 0/1/2 | `friday --help`, [README](../engine/README.md) | `TestConformHelpNamesRealFlags`, `TestConformExitCodes` |
| **Slash commands** | `internal/tui/cmd_registry.go` (`commands`) | name, help line and argument hint to the grammar; unique; a handler | `/help`, the command list | `TestConformSlashCommands` |
| **Argument hints** | the `args` of each command | `[optional]`, `<placeholder>`, `a\|b`; lower-case words; at most two levels | — | `conform.ArgHint` |
| **Key actions** | `internal/tui/core_keys.go` (`actions`) | id and label to the grammar; one of five groups (Typing, Apps, Windows, Session, Reading); a default key and a binding; unique | the Keys app (F7), Help (F8) | `TestConformKeyActions` |
| **Messages** | every `toast` and `notice` in `internal/tui` | the voice in section 5 | — | `TestConformMessages` (literals, format strings, and how built ones start) |
| **Settings and variables** | `packages/friday-cli/src/platform/settings.ts` (`SETTING_FIELDS`); variables read by the Go code | every `ARCHYMEDES_*` the binary reads is documented; every key it reads from `settings.json` is a row of Settings; each row validates its values | [Configuration](../engine/CONFIGURATION.md) | `TestConformEveryVariableIsDocumented`, `TestConformSettingsTheBinaryReadsExist`, `menu-invariants.test.ts` |
| **Tools** | `internal/core/tools` (`Builtins`), `internal/core/agents` (`rootTools`) | name and description to the grammar; a known capability and effect; a body; a schema whose required arguments exist and whose arguments are typed; in the tools reference | [Tools](../engine/TOOLS.md) | `TestConformBuiltinTools`, `TestConformRootTools`, `tool.Contract` |
| **Sub-agent roles** | `internal/core/roles` (`BuiltIn`) | name and description to the grammar; instructions, limits and a model | [Sub-agents](../engine/SUBAGENTS.md) | `TestConformBuiltInRoles` |
| **Protocol methods** | `internal/core/server/registry.go` (`methods`, `forwarded`) | name to the grammar; a line saying what it does; in the protocol reference | [Protocol](../engine/PROTOCOL.md) | `TestConformMethods` |
| **Session commands** | `internal/core/server/registry.go` (`sessionCommands`) | name and line to the grammar; a reply kind the interface renders; in the protocol reference | [Protocol](../engine/PROTOCOL.md) | `TestConformSessionCommands` |
| **Events** | `internal/core/loop/events.go`, `agents.Notice` kinds | name to the grammar; JSON identical to the TypeScript runtime's; in the protocol reference | [Protocol](../engine/PROTOCOL.md#extension-events) | `TestConformEvents` |
| **Packages** | `tooling/check/go-sections.json` | each imports only what its row lists | [Architecture](../engine/ARCHITECTURE.md#packages) | the `go-layering` guard |
| **Pictures** | `internal/gallery` (`Photos`) | free-licensed and credited, or drawn by code; ≤ 400 px shipped | [`CREDITS.md`](../../internal/gallery/CREDITS.md) | `TestEveryPictureIsInTheCreditsFile` and the gallery tests |

**Files on disk.** What Friday writes, and where, is fixed:

| File | Where | Holds |
| --- | --- | --- |
| `settings.json` | config directory | settings (section [Configuration](../engine/CONFIGURATION.md#where-settings-live)) |
| `state.json` | config directory | what the interface remembers: the welcome was seen, the wallpaper choice, the tour drawer folded |
| `keys.json` | config directory | changed key bindings only |
| `rules.json` | config directory, and `.archymedes/rules.json` in a project | command rules |
| `agents/*.md` | config directory, and `.archymedes/agents/` in a project | sub-agent roles |
| `go-sessions/<id>/` | `.archymedes/` in a project | Go-engine sessions ([Architecture](../engine/ARCHITECTURE.md#threads-on-disk)) |
| `sessions/<id>.json` | `.archymedes/` in a project | TypeScript-engine sessions |

## 7 Recipes

| To add | Do | Then |
| --- | --- | --- |
| a slash command | one row in `commands` (`cmd_registry.go`): name, hint, help line, handler in the `cmd_` file of its family | `go test -run '^TestConform' ./internal/tui` |
| a key action | one row in `actions` (`core_keys.go`) and a field in `keyMap` | the same |
| a flag | handle it in `internal/cli/args.go` (and add Go-only ones to `goOnlyFlags`); name it in `usage` with what it does | `go test -run '^TestConform' ./cmd/friday` |
| a setting | a row in `SETTING_FIELDS` with its choices and validation; a line in [Configuration](../engine/CONFIGURATION.md) | `TestConformSettings…`, `menu-invariants.test.ts` |
| a tool | [Extending → Add a tool](../engine/EXTENDING.md#add-a-tool), and a section in [Tools](../engine/TOOLS.md) | `go test -run '^TestConform' ./internal/core/...` |
| a protocol method | one row in `methods` (`registry.go`) with its line and handler; a section in [Protocol](../engine/PROTOCOL.md) | the same |
| a message | `m.toast` or `m.notice` with a literal or `fmt.Sprintf` format in the voice of section 5 | `TestConformMessages` |
| a word | a row in the [vocabulary](#2-vocabulary), if it names a new thing | review |

## 8 Documentation

The documents are held to the same precision as the mechanisms they describe. The rules are
[`internal/conform/docs.go`](../../internal/conform/docs.go); `TestConformDocuments`,
`TestConformDocumentReferences` and `TestConformDocumentedMeasures` apply them.

| Rule | Measure | Checked by |
| --- | --- | --- |
| One title, and a sentence under it saying what the document is for | exactly one `#` heading, first | `conform.DocStructure` |
| Headings descend one level at a time | no `##` → `####` | `conform.DocStructure` |
| A long page lists its sections before the first | 6 or more `##` sections need a list of 3 or more links | `conform.DocStructure` |
| Every table row has its header's cells | equal counts (pipes in code do not count) | `conform.DocStructure` |
| A sentence carries one idea | ≤ 40 words | `conform.DocProse` |
| No filler | none of the words in `filler` (`simply`, `just`, `very`, `in order to`, `etc.`, `TODO` and the like) | `conform.DocProse` |
| One word per thing | no word from the vocabulary's "Not" column | `conform.DocProse` |
| Keys as pressed | `esc`, `ctrl+s` | `conform.DocProse` |
| Every link leads somewhere | the file exists; a `#fragment` names one of its headings | `TestConformDocumentReferences` |
| Every name in code exists | a path under `internal/`, `cmd/`, `docs/`, `packages/` or `tooling/`; a `TestConform…` test; an `ARCHYMEDES_…` variable some code reads | `TestConformDocumentReferences` |
| Every number is the code's | each limit the documents state (steps, retries, waits, timeouts, result sizes, the context window, helpers at once) is built from the constant that holds it | `TestConformDocumentedMeasures` |

Prose rules cover the documents a person reads: the README, the package README, this standard,
`docs/engine/` and the gallery's credits. The continuation notes in `docs/continuation/` are
working records; their links and names are checked, their prose is not. Fenced code is never
checked as prose, and inline code is quoted, not prose.

**Writing to the rules.** Lead with what a thing does, then how. Split a sentence at its second idea
rather than joining with a semicolon. A list of more than four parts is a table or a list, not a
sentence. Name a measure by its constant's value, then let the test hold it.

## 9 Conformance

```bash
go test -run '^TestConform' ./...     # every conformance test, in a few seconds
bun run recheck                       # runs them on every recheck, beside the guards
```

- **Tolerance is zero.** Every conformance test passes on every commit; there is no baseline of
  excused findings. When the standard was introduced (WS-38), every finding was fixed rather than
  excused. There were 1 help line over its measure and 20 messages: 9 ending in a full stop, 11
  that gave no next step. There were also 2 flags the binary read but `--help` did not name, and 2
  variables no document named. The documentation rules (WS-39) were met the same way. They found 33
  sentences over 40 words, 4 filler words, 2 retired words and 2 long pages without contents. In
  the code they found 13 tool errors and 3 Go errors in the wrong case, and 2 Settings labels.
- **Changing a rule** is a change to `internal/conform`, to this document, and to the tracker, in
  one commit, with the reason. The conformance tests then show everything the new rule touches.
- **A rule that cannot be checked** is marked here as a review rule. If it can be made checkable
  later, it should be.

## 10 Interaction

Friday is driven like a desktop: by the arrows and by the mouse. Every surface follows one grammar,
held by the components they share rather than by each surface's own code.

| Input | Means | Where it is built |
| --- | --- | --- |
| ←↑↓→ | move: a row in a list, a tile in a grid, between panes | `internal/tui/desk_list.go`, `desk_tiles.go` |
| home, end, pgup, pgdn | the first, the last, a screenful | the same |
| enter | open, or do what the selected thing does | each surface's `handle` |
| space | look inside without leaving: a quick look, a reader | the same |
| esc | step out one level; from a window's top level or an empty input, out to the bars | `core_keyboard.go`, `desk_bars_focus.go` |
| q, ctrl+w, ✕ | close a window | `desk_window.go` |
| ↑ on an empty input | onto the conversation's newest block; on the home screen, onto the desktop's icons | `chat_cursor.go`, `home_desktop.go` |
| ctrl+↑, ctrl+↓ | earlier messages | `core_keys.go` |
| a click | select | `listView.clickRow`, `tileGrid.clickTile` |
| a click on the selected thing | open it, as enter does | the same |
| a click on a button, a tab or the dock | act at once | `desk_window.go` (`hintBar`) |
| the wheel | scroll what is under the pointer, never what is hidden | `desk_window.go` (`wheel`) |

**Windows and dialogs.** Anything browsed is a window: it floats on the wallpaper with a margin, its
body frosted glass, its title and ▢ zoom and ✕ close in its top edge. A dialog is kept for a
question that must be answered. A window's keys are buttons in its foot, so nothing a key does is
out of reach of the mouse.

**Adding a surface.** A list is a `listView`, a grid a `tileGrid`, a foot a `hintBar`. A window
implements `wheel` (or `wheelAt` for panes) and `click`; it draws as if its inside were the screen
(`within`). `TestConformEveryWindowTakesTheWheel` finds every window in the source and holds it to the
wheel.

