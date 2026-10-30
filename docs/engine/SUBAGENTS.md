# Sub-agents

A sub-agent is a helper the main conversation starts for one part of a task: it gets a brief, works
with its own conversation, and reports back. On the Go engine every sub-agent is a **thread** of the
session, kept on disk like the main conversation, so it can run in the background, be followed up,
and survive a restart.

- [Why helpers](#why-helpers)
- [Roles](#roles)
- [Foreground and background](#foreground-and-background)
- [What a helper starts from: fork modes](#what-a-helper-starts-from-fork-modes)
- [Editing in the background: worktrees](#editing-in-the-background-worktrees)
- [Waiting, following up, stopping](#waiting-following-up-stopping)
- [Restarts](#restarts)
- [Limits and safety](#limits-and-safety)
- [Writing a role](#writing-a-role)
- [What you see](#what-you-see)
- [Comparison with other agents](#comparison-with-other-agents)

## Why helpers

Two reasons, and each built-in role is shaped by one of them.

- **Context.** A broad search reads twenty files to find the three that matter. In the main
  conversation all twenty would stay for the rest of the session; done by a helper, only its report
  does. The read-only roles exist for this, and several run at the same time.
- **Independence.** A second opinion is only worth something if it was not formed by the reasoning
  it checks. A review helper starts from the brief and the code, never from the main conversation
  (unless asked to), so it catches what the main conversation talked itself past.

Friday's instructions tell it when a helper pays: a search that would take several rounds, a plan
across files it has not read, a review after substantial edits, an independent piece of work while
it does the rest. One- or two-call lookups it does itself, since a helper starts from nothing.

## Roles

| Role | For | Reads | Edits | Runs commands | Steps / calls | Model |
| --- | --- | --- | --- | --- | --- | --- |
| `explore` | where and how something works: files, symbols, callers; one area each, several at once | yes | no | no | 10 / 30 | small |
| `plan` | files, order, risks and checks for a change across several files | yes | no | no | 12 / 36 | main |
| `review` | an independent bug review of changed code (uses the git tools) | yes | no | no | 12 / 36 | main |
| `general` | one independent, fully specified piece of work | yes | yes | yes | 25 / 80 | main |
| `verify` | run the project's tests, builds and typechecks and report failures | yes | no | yes | 15 / 40 | small |

The read-only roles get only the search tools (`read_file`, `list_files`, `glob_files`,
`grep_files`; `review` also `git_diff`, `git_status`, `git_log`, `git_show`). No helper gets the
delegation tools, the checklist (`todo_write`, `todo_read`), or `ask_user`.

Every helper is told the same contract. It has no memory of the conversation that sent it, and its
final message is the only thing the sender sees. That message is a report of about 400 words at
most: answer first, then evidence (`path:line`, commands with their exit codes), then what it could
not do.

## Foreground and background

`delegate_readonly_task` (read-only roles) and `delegate_task` (the others) start a helper.

**Foreground** (the default): the call waits for the helper and its result is the report. Several
read-only helpers asked for in one step run at the same time.

**Background** (`background: true`, or a role whose file says `background: true`): the call returns
at once with the helper's id, and Friday carries on. The report arrives:

- as a message, read at Friday's next step if the turn is still running;
- or with `wait_agents`, if Friday decides it needs the report before going on;
- or, if the turn ends first, at the start of your next message. The helper keeps working
  meanwhile.

A report is delivered once: collected with `wait_agents`, it is withdrawn from the waiting
messages; already read as a message, `wait_agents` says so instead of repeating it.

## What a helper starts from: fork modes

| `fork` | The helper starts with | Use it when |
| --- | --- | --- |
| `none` (default) | the brief alone | almost always: a clean start is what makes a helper cheap and independent |
| `full` | the main conversation so far, then the brief | the brief would have to repeat most of the conversation |
| `last:N` | the last N exchanges, then the brief | only the recent part matters |

A forked conversation is always complete: the call that is starting the helper (which has no
result yet) and any other call without its result are left out, so the provider never sees half
of a pair.

## Editing in the background: worktrees

A helper that can edit files and runs in the background works in its own **git worktree**: a
separate checkout of the repository, on a new branch `friday/<id>`, outside the project folder (in
your user cache directory, `…/friday/worktrees/<session>/<id>`). Friday keeps editing the main
checkout meanwhile; two agents editing one file at the same time would silently overwrite each
other, and this makes that impossible rather than a matter of care.

- The worktree starts from `HEAD`: changes you had not committed are not in it.
- The helper is told not to commit, push or switch branches. When it finishes, Friday commits
  what it changed on its branch (`friday <role>: <brief>`), and its report ends with the files
  changed and how to take them:

```text
Its changes are committed on branch friday/t-k3x9ab (worktree …/friday/worktrees/…/t-k3x9ab),
started from HEAD, so edits you had not committed are not in it:
 src/api/routes.go | 14 ++++++++++++--
Take them with `git merge friday/t-k3x9ab` (or cherry-pick), then `git worktree remove …`.
```

- Outside a git repository, or in a repository with no commit yet, an editing helper runs in the
  foreground instead.

## Waiting, following up, stopping

| Tool | Does |
| --- | --- |
| `wait_agents` | waits for background helpers (all unread ones, or the `ids` given) up to `timeoutSeconds` (default 600, at most 1,800), and returns their reports; those still running are named |
| `send_agent` | sends a running helper a message it reads at its next step; re-opens a finished helper with a follow-up, keeping everything it already read |
| `close_agent` | stops a running helper; what it found so far becomes its report |

Re-opening is what lets a helper's work be multi-phase: "map the API" now, "and now list the
endpoints without tests" later, without paying for the map twice.

## Restarts

A helper's spawn is written to the session log before it starts, and its conversation after every
step. When a session is opened again:

- a helper that was running when Friday **crashed** is found, marked interrupted, and resumed from
  its last saved step;
- a background helper that was running when you **closed** Friday was paused, not cancelled, and is
  resumed the same way;
- a helper someone stopped (`close_agent`, or esc on a foreground one) stays stopped.

A resumed helper is told it was interrupted and asked to continue without redoing finished steps.
Its report reaches the main conversation as a message, since the call that started it is long
gone. A helper is found once: opening the session again does not start it twice.

## Limits and safety

- **Depth one.** A helper never gets the delegation tools, so helpers never start helpers.
- **Four at once.** More wait for a free place.
- **Its own limits.** Each role has a step and a tool-call limit (above). At the limit it is asked,
  with no tools, for its report from what it has, so the work is not lost.
- **Same mode, same approvals.** A helper works in the session's mode, and every call that changes
  something is approved through the same ledger as Friday's own: you see the same question, and a
  standing approval you gave applies.
- **Tests first.** Editing helpers are held to the same proof and test-first rules as the main
  conversation.
- **Small results.** A helper keeps tool results to 9,000 characters each.

## Writing a role

A role is a Markdown file with front matter, in `.archymedes/agents/` in the project (shared with
everyone who works on it) or in `agents/` in your config directory (yours alone). Files are read in
name order, the config directory's first; a role with a built-in's name replaces it.

```markdown
---
name: migrations
description: writes and checks database migrations
tools: read_file, grep_files, glob_files, write_file, edit_file, run_command
readonly: false
model: small
background: false
max-iterations: 20
max-tool-calls: 60
---
You write database migrations for this project.

- Every migration has a down step that restores the schema exactly.
- Run `make migrate-test` after writing one, and report its output.
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | lowercase letters, digits and dashes, up to 40 characters |
| `description` | yes | what it is for; shown to the model beside the role's name |
| `tools` | no | only these tools (a comma list, or `[a, b]`); default: every tool the mode allows, minus those no helper gets |
| `readonly` | no | `true`: the role is offered through `delegate_readonly_task`, gets only tools that change nothing, and runs beside others |
| `model` | no | `main` (default), `small`, or a model id of the session's provider (a free session keeps free models) |
| `background` | no | `true`: runs in the background unless the call says otherwise |
| `max-iterations` | no | steps; default 12 read-only, 25 otherwise, at most 40 |
| `max-tool-calls` | no | tool calls; default 36 read-only, 80 otherwise, at most 150 |
| `effort` | no | `minimal` … `max`; accepted and used by the TypeScript engine, not yet by the Go engine |

The body is the role's instructions. A file that does not parse is left out, and a line at the
start of the session names it and why.

## What you see

- **A card per helper**, under the call that started it: `agent · explore`, with its latest calls
  while it runs, how many calls and tokens it used, and the first line of its report when done.
- **In the background**, the card says so ("in the background · 4 calls") and keeps showing what
  the helper does after the call returned; its report replaces "started in the background" when it
  finishes. If you are between turns, a line says a report is waiting for your next message.
- **The Inspector** (→ on an empty input, or → on a helper's card): every helper of the session,
  those at work first. The one you choose shows its brief and its report once done. Between them
  is its whole timeline: each call, its time, whether it failed, and every edit's diff. → steps
  into the timeline, enter opens a call's output in place, space reads it, ← steps back out.
- **Helpers you start yourself** (`/agent [role] <task>`, or alt+a on what you typed) run in the
  background with no call behind them. Their card appears with their first step and is otherwise
  the same. Their reports reach Friday like any background helper's.
- **`/subagents`** lists every helper of the session: id, role, status, foreground or background,
  the tokens it used, the brief's first line, and the branch for an editing background helper. Its
  last line is what all helpers used together: in, from cache, out.
- A helper's tokens count toward the session's, in the status line and in Stats, and its card
  shows its own. Each helper's total is kept with the session, so it survives a restart and a
  resumed helper counts on from where it was.

## Comparison with other agents

The design follows what the widely used open-source agents converged on, surveyed in October 2026:

| | Friday (Go engine) | Codex | Claude Code | OpenCode | Crush |
| --- | --- | --- | --- | --- | --- |
| Helper is | a child thread of the session | a thread in a tree | a sub-agent in its own context | a child session | a child session |
| Starts from | the brief, or a fork (full, last N) | fork modes (full history, last N turns) | a fresh context, or a fork | the brief | the brief |
| Background | yes | yes | yes | yes | no |
| Follow up a finished one | yes (`send_agent`) | yes | yes | requested by users (issue #11012) | no |
| Restart-safe | yes, spawn logged first | — | — | spawns are part of the transcript | — |
| Depth | one | limited | one | budgeted | — |
| Edits isolated from the parent's | own worktree and branch | — | worktree option | — | — |

A dash means the sources do not describe it. Sources: the [Codex sub-agent docs](https://learn.chatgpt.com/docs/agent-configuration/subagents),
[Claude Code sub-agents](https://code.claude.com/docs/en/sub-agents),
[OpenCode agents](https://opencode.ai/docs/agents/),
[Crush](https://github.com/charmbracelet/crush/blob/main/AGENTS.md), and the source-code studies
[arXiv 2604.03515](https://arxiv.org/html/2604.03515) and [arXiv 2609.00006](https://arxiv.org/html/2609.00006).
