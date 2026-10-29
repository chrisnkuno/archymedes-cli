# User guide

How to work with Friday on its engine: what happens when you send a request, how much it may do on
its own, how it uses helpers (sub-agents), and what to do when something goes wrong. For every
setting see [Configuration](CONFIGURATION.md); for every tool see [Tools](TOOLS.md).

- [Starting](#starting)
- [What happens when you send a request](#what-happens-when-you-send-a-request)
- [How much Friday may do on its own](#how-much-friday-may-do-on-its-own)
- [Approvals](#approvals)
- [Talking to Friday while it works](#talking-to-friday-while-it-works)
- [Tests first, and proof before "done"](#tests-first-and-proof-before-done)
- [Suggestions while you work](#suggestions-while-you-work)
- [Sub-agents](#sub-agents)
- [Seeing every change](#seeing-every-change)
- [Sessions: resuming, restarts, titles](#sessions-resuming-restarts-titles)
- [Long conversations: compaction](#long-conversations-compaction)
- [Models: the main one and the small one](#models-the-main-one-and-the-small-one)
- [Limits Friday keeps to](#limits-friday-keeps-to)
- [Commands in a session](#commands-in-a-session)
- [Troubleshooting](#troubleshooting)

## Starting

```bash
friday                          # a session in this folder
friday "add a --verbose flag"   # a session that starts with a request
friday --resume latest          # the last session in this folder
friday --resume                 # same as latest
friday --plan                   # start in plan mode (read and propose only)
friday --provider groq --model openai/gpt-oss-120b
```

The first time, with no key anywhere, Friday opens a welcome that lets you pick a provider and
paste its key; the key is saved in your settings file and never shown again. After that, `friday`
opens straight into a session.

Friday works in the folder you start it in (or `-C <dir>`). It can read anything in that folder,
and it changes nothing outside it: paths outside the project, `~` paths, and links that lead out of
it are refused by every file tool.

## From a script

```sh
friday --print "fix the failing test"        # the answer on stdout, progress on stderr
echo "summarize the README" | friday         # a request from a pipe
friday --json --auto "bump the version"      # one JSON object per line, for another program
```

A scripted run is one turn in the current folder, saved as a session (`--resume` continues it).
Nobody can answer an approval there, so a call that would ask is refused and the model is told so:
choose the mode for what it may do (`--plan`, `--auto`) or allow commands with
[command rules](CONFIGURATION.md#command-rules). With `--json`, stdout carries `session`, `text`,
`tool_call`, `tool_result`, `refused` and a final `result` (`status`, `text`, `session`, `usage`), and
nothing else. The exit code is 0 when the turn completed, 1 when it failed or got stuck, 2 when it
could not start, 130 when interrupted.

## What happens when you send a request

One request is one **turn**. A turn is a loop of **steps**:

1. Friday reads what has arrived since the last step: your request, anything you typed while it
   worked, and reports from sub-agents that finished.
2. It asks the model what to do next. You see the reply stream in, and while the model is still
   writing a tool call you see what it is about ("writing src/app.ts…").
3. It runs the tools the model asked for. Calls that only read run together, at the same time;
   anything that changes something runs on its own, in order, after your approval when the mode
   asks for one. Every call appears as a card with its result.
4. It saves the conversation. Then the next step, until the model has nothing more to do.

When the model says it is done, Friday checks one more thing before it lets the turn end: if files
changed, has anything shown that the change works? (See [Tests first](#tests-first-and-proof-before-done).)

A turn ends when the work is done, when you stop it (esc), when the turn's budget of steps is
spent, or when Friday notices it is going in circles. The last line of the turn says which.

## How much Friday may do on its own

The **mode** decides what Friday may do without asking. shift+tab cycles plan → build → auto →
defender in a session; `/mode <name>`, or `/plan`, `/build`, `/auto`, `/defender`, switch
directly. The mode can change mid-session; standing approvals carry over.

| Mode | Reads | Edits files | Runs commands | Asks you |
| --- | --- | --- | --- | --- |
| **plan** | yes | no | no | never: nothing can change |
| **build** (default) | yes | yes | yes | before every edit and every command that is not read-only |
| **auto** | yes | yes | yes | only for risky actions: credentials, deleting work, pushing, publishing, deploying, privileged commands |
| **defender** | yes | yes | yes | before every change, always; security work |

**Defender** is Friday as a defensive security engineer. It reads the security playbooks that fit
the project (19, from access control to AI applications), scans for hardcoded secrets, and
reports each finding with its file and line, the input that triggers it, and its impact. It fixes
what you ask, and every change asks first: command rules that allow a command do not apply here.

"Read-only" commands never ask in any mode: `git status`, `git diff`, `git log`, `ls`, `cat`,
`rg`, `grep`, `find` without `-delete`/`-exec`, `sed -n …p`, version checks. Friday decides this by
looking at every part of the command; anything it cannot account for (a redirect, `$( )`, a
background `&`, a program it does not know) is treated as a change and asks.

Some commands are refused outright, whatever the mode, because no undo brings their work back:
a recursive forced `rm` (in any flag spelling), `find … -delete`, `git reset --hard`,
`git clean -f`, `git checkout -- .`, `mkfs`, `dd if=…`, writing to a raw disk, and the fork bomb.
The model is told why and asked to leave them to you; you can always run them yourself with
`!command` in the input box.

## Approvals

When Friday asks, the dialog offers:

| Answer | What it means |
| --- | --- |
| **Allow** | this call, once |
| **Allow this action from now on** | this exact call (same tool, same arguments) for the rest of the session |
| **Always allow commands starting with "npm test"** / **edits under src/app/** | a broader rule, offered only when generalizing is safe: a command prefix (never for `rm`, `sudo`, shells, network tools, `git push`, installs or publishes) or the edited file's own folder (never the project root, `.git` or `.archymedes`) |
| **Deny** | not this call; the model is told you declined and should not try another way |
| **Deny this action from now on** | never this exact call this session |

Standing decisions are saved with the session and come back when you resume it. They are keyed to
the exact action, including where the tool came from, so an approval for Friday's own `write_file`
never covers a same-named tool from somewhere else. Decisions made on the TypeScript engine are
understood by the Go engine and the other way round.

For decisions you make every day, write **command rules** instead (`allow`, `ask` or `forbid` a
command by its first words). See [Configuration → Command rules](CONFIGURATION.md#command-rules).

## When Friday needs you

Look away while Friday works, and it tells you when the turn ends or when an approval or a
question waits: a notification from your terminal, or its bell. Set a push URL in Settings
(`ARCHYMEDES_NOTIFY_URL`, an [ntfy](https://ntfy.sh) topic for example) and your phone hears it
too. See [Notifications](CONFIGURATION.md#notifications).

## Images in a request

Name a picture in your request and it is sent with it: type its path, mention it (`@shot.png`), or
drop the file onto the terminal, which pastes its path. PNG, JPEG, GIF and WebP up to 5 MB each are
sent, at most eight a request, and a line under your message says how many went. The path stays in
the text, so the model knows which file it is. The model must be one that reads images. One that
cannot will refuse the request, and its provider's words come back to you.

## Vim keys in the input

`/vim` (or Settings → `ARCHYMEDES_VIM`) turns on vim keys in the input. Pressing esc on a non-empty
input enters normal mode, shown as NORMAL in the status bar. The enter key sends in either mode. In
normal mode esc does what it always does: stop the turn, or step out to the bars.

| Keys | Do |
| --- | --- |
| `h` `j` `k` `l`, `w` `b` `e`, `0` `^` `$`, `gg` `G` | move |
| `x` `X`, `dd` `dw` `D` | delete |
| `cw` `cc` `C` | change (and type) |
| `yy`, `p` `P` | copy, paste |
| `u` | undo |
| `i` `a` `I` `A` `o` `O` | back to typing |

## Errors after an edit

When Friday edits a file that a language server covers, the server checks it, and its errors (and a
few warnings) are added to the edit's result, so the model fixes what it broke before going on.
Friday starts the server the first time a file of its language changes, if it is installed:
gopls for Go, typescript-language-server for TypeScript and JavaScript, pyright for Python,
rust-analyzer for Rust, clangd for C and C++. Nothing is installed for you. `/lsp` shows which are
installed and running; `ARCHYMEDES_LSP=off` turns them off.

## Profiles

A profile is another set of settings, for another account or way of working: a file in Friday's
config directory, `profiles/<name>.json`, in the same shape as `settings.json`, laid over it while
the profile is active.

```json
{"ANTHROPIC_API_KEY": "sk-ant-…work", "ARCHYMEDES_PROVIDER": "anthropic", "CLAUDE_CONFIG_DIR": "~/.claude-work"}
```

`/profile` lists them, `/profile work` chooses one for the sessions that follow (`/new` opens one
now), `/profile none` goes back to plain settings, and `friday --profile work` uses one for a single
run. The status bar names the profile in use. `CLAUDE_CONFIG_DIR` in a profile makes Claude Code run
as another Claude account (sign that account in once with
`CLAUDE_CONFIG_DIR=~/.claude-work claude auth login`).

## Side questions

`/btw <question>` asks something on the side, even while Friday is working: "/btw what does
`retryAfter` return?". Friday answers from the conversation and what it knows of the project, with
no tools, and neither the question nor the answer joins the conversation, so the work carries on as
it was.

## Talking to Friday while it works

You do not have to wait. While a turn runs:

- **Type and press enter.** Your message joins the turn at its next step, as if you had said it
  between two of Friday's actions. Use it to correct course ("not that file, the other one"), add a
  requirement, or answer a question it is about to ask.
- If the turn ends before reading what you typed, your message is sent as the next turn instead, so
  nothing you type is lost.
- **esc** stops the turn. Requests already sent to Friday and waiting behind it are stopped with
  it; what you send afterwards runs normally.

## Tests first, and proof before "done"

Two things hold a turn back from ending:

**Proof.** If the turn changed files and nothing has shown the change works, Friday asks the model,
once, to run the smallest relevant test or check and report the real result. A passing build or
typecheck counts as the weakest proof; Friday asks once more for tests that run the changed
behaviour. Running something that only prints, or reading a test file, is not proof. A turn that
changed only prose (Markdown and text files, a changelog, a license) is not asked at all; other
changes with nothing to test, such as configuration, may say so and finish.

**Tests first** (on by default; Settings → Behaviour → Build test first). For a code change, the
order is: write the tests that define done and see them fail, write the smallest code that makes
them pass, then run the project's own static check (typecheck, linter, vet). If code changes before
any test, the model is reminded of the order; if it finishes without tests or without the check,
it is asked once for each. You see where it is in a small row under the transcript:
`✓ 1 test ✓ red ● code ○ green ○ checks`.

## Suggestions while you work

Friday suggests in three places. Nothing it suggests is sent until you press enter.

**Next steps after a turn.** A turn that changed files or ran a command ends with up to 3 next
steps under the reply. Each says why now: a check that failed, a change nothing has tested, a diff
worth reading before it goes further. alt+1, alt+2 and alt+3 put one in the input. On an empty
input, tab puts the first and then the next; a click works too.

**Notes on each edit.** Under an edit, a ⚑ line says what is worth knowing about it. Code finds the
facts: a `TODO` left behind, debug output added, an exported signature changed or removed, many lines
removed, no test file beside it.

**Hints while you type.** Once a request is four characters long, the row above the input offers
what it seems headed for. That is a slash command by what it does, an earlier request, a next step,
or a file the last word begins. tab takes the first, alt+2 the second.

**Jev.** With a TypeSafe key (`TYPESAFE_API_KEY`), Jev, TypeSafe's judging model, weighs all three.
It keeps the next steps it finds useful at 0.5 or above, best first, with the probability shown. It
adds two concerns to an edit when it is sure at 0.7 or above: an error left unhandled, and
behaviour that callers rely on changed. While you type, it finds the command your words mean when
they share few words with it; a ⟡ marks hints it weighed. Without a key, rules and word matching
do the same work, and nothing leaves your machine for it.

**The small model.** With `ARCHYMEDES_SUGGEST_MODEL` on, the small model proposes up to two next
steps of its own after each turn, for one small call. It is off by default, because it costs a call
per turn. `ARCHYMEDES_SUGGEST=off` turns all three off.

## Skills

A skill is a folder of instructions for one kind of task: a `SKILL.md` whose frontmatter has a
`name` and a `description` (when to use it), and any scripts or references beside it. Friday lists
each skill in a line, and when a task matches one it loads the instructions and follows them, so a
skill costs almost nothing until it is used.

Friday looks where other agents look, so a skill written for one works here:

| Where | For |
| --- | --- |
| `.agents/skills/<name>/SKILL.md`, `.claude/skills/…`, `.archymedes/skills/…` in the project | this project (wins over a personal skill of the same name) |
| `~/.agents/skills/…`, `~/.claude/skills/…`, `skills/…` in Friday's config directory | every project |

`/skills` lists what was found, and says why a folder was skipped (no frontmatter, a name that is
not lower-case words joined by hyphens). A skill added during a session is found at the next turn.

## MCP servers

Friday uses the MCP servers a project or you declare, in the files other agents read:

| File | Shape |
| --- | --- |
| `.mcp.json` in the project | `{"mcpServers": {"github": {"command": "github-mcp", "args": ["stdio"], "env": {"TOKEN": "${GITHUB_TOKEN}"}}}}`; a URL server is `{"type": "http", "url": "https://…", "headers": {…}}` |
| `.archymedes/mcp.json` in the project | the same, or `{"servers": [{"id": "github", "command": "…"}]}` (wins over `.mcp.json`) |
| `mcp.json` in Friday's config directory | the same shape, for every project |

`${VAR}` and `${VAR:-default}` take values from your environment, so tokens stay out of the file.

An MCP server costs nothing until it is used. Its tools are not sent with each request: Friday
finds the one a task needs with `tool_search`, or by name. Its tool list is kept after the first
time, so later sessions do not start the server at all until one of its tools is called. Each
call is approved like any action outside the project; tools are named
`mcp__<server>__<tool>`. `/mcp` shows each server, how many tools it has, whether it is running,
and why a declaration was skipped.

## Going back

Before every turn Friday snapshots the project, so a turn can be taken back:

| Command | Does |
| --- | --- |
| `/undo` | the last turn's file changes and its part of the conversation; again for the turn before |
| `/undo code`, `/undo conversation` | only the files, or only the conversation |
| `/rewind` | picks any turn of the session to go back to, showing what each changed |
| `/diff`, `/diff stat`, `/diff turn N` | what changed since your last message, a summary per file, or what one turn changed |

Files a turn created are removed, files it deleted come back. Your own staged changes are left as
they were, and Friday's sessions are never part of a snapshot. Snapshots need a git repository;
outside one, `/undo` says so. After a long conversation is summarized, older turns can still give
their files back, but not their conversation.

## Hooks

Hooks are your commands at Friday's moments. They are written as Claude Code writes them, so the
ones you have keep working: a `"hooks"` object in `.archymedes/hooks.json`, `.claude/settings.json`
or `.claude/settings.local.json` in the project, `hooks.json` in Friday's config directory, or
`~/.claude/settings.json`.

```json
{"hooks": {"PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "./scripts/guard.sh"}]}]}}
```

| Event | When | Exit 2 (or `{"decision": "block", "reason": …}` on stdout) |
| --- | --- | --- |
| `PreToolUse` | before a call, before it is asked about | stops the call; stderr is the reason the model gets |
| `PostToolUse` | after a call | stderr is added to the result for the model |
| `UserPromptSubmit` | when you send a request | refuses it; otherwise what it prints is added as context |
| `Stop` | when the model is done | keeps the turn going with stderr, at most three times (`stop_hook_active` is true after the first) |
| `SessionStart` | when a session opens | what it prints joins the model's instructions |
| `SessionEnd` | when a session closes | — |

A matcher is a pattern over the tool's name, Friday's or Claude Code's (`run_command` is `Bash`,
`edit_file` is `Edit`, `write_file` is `Write`). The command gets the event as JSON on stdin, in
Claude Code's fields (`tool_name`, `tool_input` with `file_path`, `tool_response`, `prompt`), runs
in the project with `CLAUDE_PROJECT_DIR` and `FRIDAY_PROJECT_DIR` set, and has 60 seconds unless
it says otherwise (`"timeout"`). Sub-agents run the tool hooks too. Scripts in
`.archymedes/hooks/<phase>/` (`pre-tool-use`, `post-tool-use`, `pre-turn`, `post-turn`,
`pre-session`, `post-session`) still work, any non-zero exit of a `pre-` script blocking; they also get the event base64-encoded in `ARCHYMEDES_HOOK_EVENT_B64`.
`/hooks` lists what runs, and why a file or entry was skipped.

## Sub-agents

A **sub-agent** is a helper Friday starts for one part of the task. It gets a brief, works on its
own, and reports back; only its report enters the main conversation, so a search that reads twenty
files costs the conversation one report, not twenty files. Friday decides when to use them; you can
also ask ("use a background explorer to map the API while you fix the bug").

The built-in helpers:

| Role | Does | Can change files | Model |
| --- | --- | --- | --- |
| **explore** | finds where and how something works; several at once, one area each | no | small |
| **plan** | the files, order, risks and checks for a change across several files | no | main |
| **review** | an independent bug review of changed code, before Friday reports it done | no | main |
| **general** | one independent, fully specified piece of work, edits included | yes | main |
| **verify** | runs tests, builds and typechecks and reports failures | runs commands, never edits | small |

**In the background.** A helper can run while Friday keeps working. Its card stays on screen with
what it is doing ("in the background · 6 calls"), and its report arrives as a message Friday reads
at its next step, or when Friday waits for it. If Friday's turn ends first, the helper keeps
working and its report is waiting at the start of your next message.

A background helper that edits files works in its own copy of the project (a git worktree) on its
own branch, `friday/<id>`, so it never edits the same file as Friday at the same time. When it
finishes, its changes are committed on that branch, and the report says how to take them:

```bash
git merge friday/t-k3x9ab          # or cherry-pick
git worktree remove <the path the report gives>
```

Outside a git repository, an editing helper runs in the foreground instead.

**Following up.** Friday can send a running helper more instructions, or stop one. It can also
re-open a finished helper with a follow-up question; the helper keeps everything it read. `/subagents` lists every helper of
the session: its role, whether it ran in the background, its status, its brief and its branch.

**Limits.** Helpers never start helpers of their own. At most four run at once (others wait their
turn). Each role has its own step and call limits; a helper that runs out is asked for its report
anyway, so what it found is not lost. Approvals for a helper's edits come to you exactly as
Friday's own do.

You can write your own roles; see [Sub-agents](SUBAGENTS.md).

## Seeing every change

Every edit is shown as it lands, not only when the turn ends.

- **On its card.** An edit or a write shows its diff under the call: the lines removed and added,
  with their line numbers in the file, and `+3 −1` in the card's header. A long diff shows its
  first rows; enter on the card (or a second click) shows all of it.
- **In the changes rail.** On a wide terminal, a column beside the conversation lists every file
  changed since the last commit, with its lines added and removed. It marks the file edited last,
  shows the helpers at work and what each is doing now, and the background commands with the last
  line each printed. It ends with the latest edit's diff, whoever made it. It is read again from git each time an edit lands. alt+d hides it or brings it
  back. On a narrower terminal the top bar counts the changed files instead.
- **In the Inspector** (→ on an empty input, or → on a selected card): every helper and every edit
  of the session in full, described under [Sub-agents](SUBAGENTS.md#what-you-see).
- **In Changes** (F10): the whole diff of every file against the last commit. A click on a file in
  the rail opens Changes on it.

## Sessions: resuming, restarts, titles

Every session is saved as it goes, in `.archymedes/go-sessions/<id>/` in the project. Each step is
saved when it completes, and your request is saved before the first step, so a crash loses at most
the step in progress. (Add `.archymedes/` to your project's `.gitignore` if it is not there.)

- `friday --resume latest` (or `--resume`, or **F4 Sessions** / `/resume`) continues the last one;
  `--resume <id>` a particular one. The conversation is drawn again as it was.
- **Helpers survive.** A helper that was working when Friday crashed or was closed resumes, from
  its last saved step, when you open the session again. Its report then arrives like any other.
- **Titles.** A session is titled from your first request, and then renamed in the background by
  the small model to a few words ("Fix the login bug"). `ARCHYMEDES_TITLES=off` keeps the first
  line of the request instead.
- Sessions of the two engines are kept apart: `--resume <id>` of a session the TypeScript engine
  wrote opens it on the TypeScript engine.

## Long conversations: compaction

A conversation that nears the model's context window is **compacted**. The small model summarizes
the earlier part (goal, requirements, decisions, files, commands and what they showed, what
remains), and the summary replaces it. Your latest message and everything after it stay as they
were. A line in the transcript says when it happened ("Compacted the conversation:
48 → 6 messages").

- It happens at 80% of the window. The window is assumed to be 128,000 tokens unless you set
  `ARCHYMEDES_CONTEXT_LIMIT`. The size is checked before each turn as well as after it, so a
  conversation that is already over the line is trimmed before the slow turn is sent, not after.
- The most recent quarter of the window is always kept word for word. When a long run keeps
  working without you saying anything, there is no recent message to anchor on. The summary then
  reaches forward to cover all but that recent quarter. Otherwise the untouched tail would grow
  until every turn carried the whole run and stalled.
- If a provider says the conversation is already too long, Friday compacts and tries again, once.
- `/compact` does it now, between turns; `/compact <focus>` keeps what you name in full ("/compact
  the database migration").

## Models: the main one and the small one

A session uses its provider's **main model** for the conversation, and a **small model** for cheap,
mechanical work: the explore and verify helpers, compaction and titles. Set the small model with
`<PROVIDER>_SMALL_MODEL` (for example `GROQ_SMALL_MODEL=llama-3.1-8b-instant`) or
`ARCHYMEDES_SMALL_MODEL`; without one, the main model does everything. In free mode the small model
is always a free one.

`/model <name>` switches the main model mid-session, and the conversation carries on; F5 lists
every model you can switch to. Switching to another provider works too (`/model` lists them),
Claude included (see [Claude Code](#claude-code)), except to Codex, which runs on the TypeScript
engine.

## Claude Code

Choose **Claude (your subscription)** in the model picker, in Providers, or with `--provider claude`,
and your own Claude Code does the work on your Claude plan, with its own tools, prompt and project
instructions (`CLAUDE.md`). Friday shows it and keeps the session:

- **Replies stream in**, and its tool calls draw as Friday's cards (its `Edit` is an edit card with
  the diff, its `Bash` a command card; its own sub-agents' calls go under the call that started them).
- **It asks the way Friday asks.** Claude Code's permission questions come to Friday's approval
  dialog, and the mode decides first. Reads and read-only commands never ask, and your command
  rules apply. Auto mode runs a command when the safety screen finds nothing sensitive in it.
  "Allow from now on" lasts for the session and is never written to Claude Code's settings.
- **Switching keeps the conversation.** Claude is told, once, what was said before it joined; coming
  back after another model, only what it missed. Its own conversation resumes with the session.
- **Steering, stop and modes work.** A message sent while one of its tools runs reaches it within
  the turn; esc interrupts it; shift+tab changes its permission mode.
- `/cost` shows its usage and your plan's limit, `/undo` puts back the files it changed in the last
  turn (from Claude Code's own checkpoints), `/todos` and `/tools` show its list and its tools.

It needs Claude Code installed and signed in (`claude auth login`, which Providers runs for you);
Friday never sees your account. With `ANTHROPIC_API_KEY` in your environment, Claude Code would bill
that key instead of your plan, so Friday leaves it out unless `ARCHYMEDES_CLAUDE_BILLING=api`
(see [Configuration](CONFIGURATION.md#claude-code)).

## Limits Friday keeps to

| Limit | Default | What happens at it |
| --- | --- | --- |
| Steps in a turn | 100 | the turn ends: "the run's budget is spent" |
| Tool calls in a turn | 500 | the same |
| Tool calls in one step | 16 | the rest are not run; the model is told to make them in its next step |
| One tool result | 40,000 characters | the start and end are kept; the full output is saved under the project and the model can read it back with read_file |
| One step's results together | half the window (64,000 characters by default) | shared fairly across the step's calls; large results are trimmed so a step never sends more than compaction keeps |
| One reply | 16,384 tokens | a reply cut off by it is continued, up to twice |
| A silent stream | 3 minutes | the connection is cut and the call retried |
| Repeating one call with nothing changed | a note at 3, a stop at 5 | see below |

**Going in circles.** If the model calls the same tool with the same arguments while nothing in the
project changed in between, the third time it is told the result will not change; the fifth time
the turn stops ("stuck"). Running the tests again after an edit is not a repeat: the edit changed
something.

**Rate limits and outages.** A request that fails before anything streamed is retried: up to 4
times for an outage, 8 for a rate limit. Each wait is as long as the provider says ("try again in
11s", or its `retry-after` header), up to 90 seconds. You see each retry as it happens. A request
that failed after text already streamed is not retried, so nothing is said twice.

## Commands in a session

Type `/` to see every command with what it does. Those that matter most on this engine:

| Command | Does |
| --- | --- |
| `/subagents` | the helpers of this session: role, status, brief, branch |
| `/todos` | Friday's checklist for the task: what is done, doing and left |
| `/compact [focus]` | summarize the conversation now, keeping what you name |
| `/mode`, `/plan`, `/build`, `/auto`, `/defender` | how much Friday may do on its own |
| `/model [name]` | switch the model; the conversation carries on |
| `/resume`, `/new` | another session, or a fresh one |
| `/settings` | every setting, including the engine |
| `/tools` | every tool Friday has in this mode, what it may change, and whether it asks |

Commands that are not in the Go engine yet (`/undo`, `/rewind`, `/diff`, `/cost`, `/review`,
`/fork`, `/goal`, `/context`, `/memory`) say so when you run them, and how to switch.

## Troubleshooting

| You see | It means | Do |
| --- | --- | --- |
| "No model provider is configured" | no key anywhere | the welcome screen, `friday settings`, or `/key` |
| "… is not available in the Go engine yet" | the provider runs on the TypeScript engine only | Settings → Engine → TypeScript, then a new session; or pick another provider |
| "/cost is not in the Go engine yet" | that command is TypeScript-only so far | as above |
| retries with "rate_limit", turns that take minutes | your provider's per-minute limit | a higher tier, a smaller model, or fewer helpers at once |
| "Stopped: … was called 5 times with the same arguments" | the model went in circles | rephrase, or give it the missing fact |
| a helper's report says it ran out of steps | its role's limit | ask Friday to continue it (`send_agent`), or raise the limit in a role file |
| a background helper's work is not in your files | it worked on its own branch | `git merge friday/<id>` as its report says |
| the session will not resume | it was written by the other engine | `--resume <id>` picks the right engine by itself; check `.archymedes/sessions` vs `.archymedes/go-sessions` |

For a record of everything the engine and the interface said to each other, start Friday with
`ARCHYMEDES_ACP_TRACE=/tmp/acp.log`. `ARCHYMEDES_DEBUG_LOG=/tmp/friday.log` writes the interface's
own log. Its first `engine` line says which engine runs the session, and why when it is the
TypeScript one.
