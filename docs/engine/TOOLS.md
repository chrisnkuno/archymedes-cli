# Tools

Every tool the model can call on the Go engine. Names and arguments match the TypeScript engine's,
so prompts, role files and the interface's cards work the same on both. `/tools` in a session lists
the ones the current mode has, with what each may do.

**Effect** is what a call can change: *none* (it only reads; never asks), *project* (it changes
files or runs something; asks in build and defender mode, and in auto mode only when risky), or
*per call* (decided from the arguments). **Together** means several such calls in one step run at
the same time.

**Modes.** Plan mode has only the tools whose effect is none, plus the read-only helpers. Build,
auto and defender have them all; defender also has `read_playbook`.

- [Reading and searching](#reading-and-searching)
- [Changing files](#changing-files)
- [Running commands](#running-commands)
- [Planning](#planning)
- [Git](#git)
- [Asking you](#asking-you)
- [Security](#security)
- [Sub-agents](#sub-agents)
- [Skills](#skills)
- [MCP tools](#mcp-tools)
- [Finding more tools](#finding-more-tools)
- [Paths, sizes and what is skipped](#paths-sizes-and-what-is-skipped)

## Reading and searching

### `read_file`

Read a text file, with numbered lines (`12<tab>text`; the numbers are not in the file).

| Argument | | |
| --- | --- | --- |
| `path` | required | relative to the project, or absolute inside it |
| `offset` | optional | first line, from 1 |
| `limit` | optional | how many lines; default 2,000 |

Effect none, together. A window says which lines it shows (`app.go (lines 200-399 of 812)`).
Binary files and directories are refused, and so are files over 10 MB. Reading a file also
remembers its content, so a later edit can tell whether someone changed it in between.

### `list_files`

The files and folders under a path, folders ending in `/`.

| Argument | | |
| --- | --- | --- |
| `path` | optional | default: the project root |
| `depth` | optional | levels to descend; default 2 |

Effect none, together. At most 500 entries; it says so when there are more.

### `glob_files`

Files whose path matches a pattern, newest first.

| Argument | | |
| --- | --- | --- |
| `pattern` | required | `**` spans folders: `src/**/*.tsx`. A pattern with no `/` matches the file name at any depth: `*.go` |
| `path` | optional | the folder to search; default the project root |

Effect none, together. At most 500 paths.

### `grep_files`

Search file contents. Uses ripgrep when it is installed (and so honours `.gitignore`), a built-in
search otherwise.

| Argument | | |
| --- | --- | --- |
| `query` | required | the text to find; a regular expression with `regex: true` |
| `path` | optional | a file or folder; default the project root |
| `include` | optional | a file-name pattern: `*.ts` at any depth, or `src/**/*.tsx` |
| `regex` | optional | treat the query as a regular expression |
| `ignoreCase` | optional | |
| `output` | optional | `content` (matching lines, the default), `files` (paths only), `count` (matches per file) |
| `context` | optional | lines before and after each match, up to 10 |
| `limit` | optional | lines shown; default 100, at most 500 |

Effect none, together.

## Changing files

### `write_file`

Create a file, or replace all of it. Folders on the way are created.

| Argument | | |
| --- | --- | --- |
| `path` | required | |
| `content` | required | the whole new content |

Effect project. If the file was read earlier in the session and has changed since (you edited it,
another tool did), the write is refused until it is read again: Friday never overwrites what it has
not seen.

### `edit_file`

Replace exact text in a file.

| Argument | | |
| --- | --- | --- |
| `path` | required | |
| `oldText`, `newText` | one edit | `oldText` must occur exactly once (add surrounding lines to make it unique) |
| `replaceAll` | optional | replace every occurrence instead |
| `edits` | several edits | a list of `{oldText, newText, replaceAll}` applied in order, **all or nothing** |

Effect project. Refused, with the reason, when the text is not found, occurs more than once, or
the file changed since it was read. Line numbers pasted from `read_file` output are recognised and
stripped; a file with Windows line endings matches text written with plain newlines.

## Running commands

### `run_command`

Run a shell command in the project root (`sh -c`, or `cmd /C` on Windows) and wait for it.

| Argument | | |
| --- | --- | --- |
| `command` | required | |
| `timeoutSeconds` | optional | default 120, at most 1,800 |
| `background` | optional | start it and return at once with a job id; see [Background commands](#background-commands) |

Effect **per call**:

- **Read-only commands run unasked** in every mode, and several in one step run together:
  `git status`, `git diff`, `ls`, `cat`, `rg`, `grep`, `find` (without `-delete`, `-exec`),
  `sed -n …p`, `head`, `wc`, version and help checks. Every part of a compound command must be
  read-only, and anything that redirects, substitutes (`$( )`), backgrounds (`&`) or sets a
  variable is not.
- **Everything else** asks in build and defender mode; in auto mode it asks only when risky
  (credentials, deleting work, pushing, publishing, deploying, `sudo`, `chmod 777`).
- **Command rules** speak first: `allow` runs unasked (except in defender mode), `ask` always asks,
  `forbid` is refused with your reason. See [Configuration → Command rules](CONFIGURATION.md#command-rules).
- **Refused outright**, whatever the mode: recursive forced `rm`, `find -delete`,
  `git reset --hard`, `git clean -f`, `git checkout -- .`, `mkfs`, `dd if=`, writing to a raw
  disk, the fork bomb.

The result is `exit <code>` and the output (stdout, then stderr), each kept to 200,000 characters.
When the time runs out, the command and everything it started are stopped. A command that looks
like a server or watcher (`npm start`, `vite`, `--watch`) gets 15 seconds; if it is still running
then, it is stopped and the model is told to start it with `background: true` instead. A missing program is
named, with a request not to retry it.

**As proof.** A successful run of a test, build, typecheck or smoke command counts as evidence
that a change works. From weakest to strongest: a check (build, typecheck, lint), tests, a smoke
run of the assembled program (a script Friday wrote counts), an end-to-end suite.
Reading files or printing text does not count, and the result says when a run was not accepted
as proof and why.

### Background commands

`run_command` with `background: true` starts a server, watcher or long build and returns at once.
It returns a job id (`cmd1`, `cmd2`, …), the process id, and what it printed in its first 2 seconds
(sooner if it ends), so a crash on startup is seen straight away. It is the same shell, the same project
root and the same rules as a foreground command: forbidden and destructive commands are refused,
and starting one always counts as a change (it asks in build and defender mode). Stdout and stderr
are one stream. `timeoutSeconds` does not apply: a background command runs until it exits, is
stopped, or the session ends.

At most 8 run at once (a ninth is refused until one is stopped) and the last 20 are remembered.
Each keeps the first 20,000 bytes of its output and the last 200,000; the middle of a longer
output is dropped and counted, never silently lost. When the session closes, every background
command is stopped with everything it started. A sub-agent's background commands are the
session's: the session can read and stop them after the sub-agent ends. Read-only sub-agents and
plan mode have none of these tools.

#### `command_output`

A background command's output since a cursor, and its status.

| Argument | | |
| --- | --- | --- |
| `id` | required | the job id |
| `since` | optional | a byte offset: the `next` of the previous result, or 0 for the start. Default: where the last read ended |
| `waitSeconds` | optional | wait for new output, a `pattern` match or the command's end; at most 60 |
| `pattern` | optional | a regular expression: only matching lines are returned, and the wait ends on the first match |
| `tail` | optional | only the last this many lines of the new output |

Effect none, together. The result opens with a status line, `cmd1 running · 12.3s · 4,567 bytes`
(or `exited 3`, `stopped`, `failed: …`), then the output, at most 30,000 bytes of it, then
`[next: since=4567]` while it runs or `[N more bytes; read on with since=…]` when there is more.
Bytes dropped between the cursor and what is still kept are marked `[… N bytes dropped …]`.
A cursor never returns the same byte twice, and a read costs the new output, not all of it.

#### `stop_command`

Stop a background command and everything it started: SIGTERM to its process group, then SIGKILL
after 3 seconds (on Windows the process is killed).

| Argument | | |
| --- | --- | --- |
| `id` | required | the job id |

Effect none: it ends only what this session started, so it never asks. Stopping a command that
already ended changes nothing and says so. Its output stays readable.

#### `list_commands`

This session's background commands, one per line: id, status, runtime, output size, command.
No arguments. Effect none, together.

## Planning

### `todo_write`

The checklist for the task, shown with `/todos`.

| Argument | | |
| --- | --- | --- |
| `items` | | a list of texts: replaces the list, with new ids |
| `complete` | | ids now done |
| `start` | | ids now in progress |

Effect none. Unknown ids are reported, the others still applied; repeating an update that changes
nothing is answered with "already recorded". Not given to sub-agents.

### `todo_read`

The checklist as it is. Effect none, together. Found with `tool_search`.

## Git

All read-only (effect none, together), with arguments checked so an option can never pose as a
ref.

| Tool | Arguments | Gives |
| --- | --- | --- |
| `git_status` | — | the branch, ahead and behind, staged, unstaged and untracked files |
| `git_diff` | `staged`, `ref` (`HEAD~1`, `main..feature`), `path`, `stat`, `maxChars` (default 20,000, at most 100,000) | the changes |
| `git_log` | `n` (default 20, at most 200), `path`, `ref` | commits: hash, date, author, subject. Found with `tool_search` |
| `git_show` | `ref` (required), `stat`, `maxChars` | one commit's message and diff. Found with `tool_search` |

## Asking you

### `ask_user`

One question, when a decision is yours to make.

| Argument | | |
| --- | --- | --- |
| `question` | required | |
| `options` | optional | suggested answers; you may answer anything |
| `multiSelect` | optional | several options may be picked |

Effect none. Dismissing the question tells the model to decide and say what it assumed. Only the
main conversation has it; a sub-agent's question would reach you without the context to answer it.

## Security

Defender mode's tools. Its instructions list the playbooks by id, and tell the model to read the
two or three that fit the project before it starts looking.

### `scan_secrets`

Scan files for likely hardcoded credentials: cloud, GitHub, Google, Slack, Stripe and model API
keys, private key blocks, JSON Web Tokens, and credential-looking assignments.

| Argument | | |
| --- | --- | --- |
| `include` | optional | a glob limiting which files are scanned, e.g. `src/**` |

Effect none, together. Findings come worst first (critical, high, medium), each as
`path:line: [severity] kind — value`. A value shows only its first and last four characters, so the
result never holds a secret in full. Sent from the start in defender mode; found with `tool_search`
in the others.

### `read_playbook`

Read one security playbook in full, by id: access control, misconfiguration, supply chain,
injection, client-side, authentication, APIs, SSRF, secrets, dependencies, cryptography,
infrastructure, error handling, business logic, input validation, logging, AI applications,
threat intelligence, and hardening resources.

| Argument | | |
| --- | --- | --- |
| `id` | required | an id from the index, or a playbook's title |

Effect none, together. Defender mode only. An unknown id is answered with the list of ids.

## Sub-agents

Only the main conversation has these; a sub-agent never starts another. Full guide:
[Sub-agents](SUBAGENTS.md).

### `delegate_readonly_task` / `delegate_task`

Start a helper. `delegate_readonly_task` takes the read-only roles (explore, plan, review, and your
read-only ones) and several run together; `delegate_task` takes the others (general, verify, yours)
and is not offered in plan mode.

| Argument | | |
| --- | --- | --- |
| `task` | required | a self-contained brief: goal, area, what is known, what to report |
| `agent` | optional | the role; default explore / general |
| `background` | optional | return at once and keep working; the report comes later |
| `fork` | optional | what it starts from: `none` (the brief only, the default), `full` (this whole conversation), `last:N` (the last N exchanges) |

Effect none: what the helper does is approved call by call, as Friday's own calls are. In the
foreground the result is the helper's report; in the background it is the helper's id.

### `wait_agents`

Wait for background helpers and collect their reports.

| Argument | | |
| --- | --- | --- |
| `ids` | optional | which; default every background helper whose report has not been read |
| `timeoutSeconds` | optional | default 600, at most 1,800 |

A report that already reached the conversation as a message is not given twice; the result says
where it is.

### `send_agent`

| Argument | | |
| --- | --- | --- |
| `id` | required | |
| `message` | required | |

A running helper reads it at its next step. A finished helper is re-opened with it as a follow-up,
keeping everything it read, in the foreground or background as it ran before.

### `close_agent`

Stop a running helper (`id`); what it found so far becomes its report. Found with `tool_search`.

## Skills

### `load_skill`

Present when the project or your skills folders hold a skill (see
[Skills](USER_GUIDE.md#skills)). Returns the skill's instructions, its folder and the other files in
it; the model reads those with `read_file` as the skill directs. Changes nothing, in any mode.

| Argument | | |
| --- | --- | --- |
| `name` | required | the skill's name, as the prompt lists it |

## MCP tools

A declared MCP server's tools join as `mcp__<server>__<tool>`, deferred (see
[MCP servers](USER_GUIDE.md#mcp-servers)). Each takes the arguments its server describes, counts as
an action outside the project for approvals, and is offered in plan mode only when the server
marks it read-only.

## Finding more tools

### `tool_search`

Present only while some tools are not sent with every request (see
`ARCHYMEDES_DEFER_TOOLS` in [Configuration](CONFIGURATION.md#behaviour)). It ranks those tools by
how well their names and descriptions match the query and makes the matches available from the next
step. Calling such a tool by its exact name works without searching first.

| Argument | | |
| --- | --- | --- |
| `query` | required | what the tool should do, in a few words |
| `limit` | optional | default 5 |

## Paths, sizes and what is skipped

- Every path is relative to the project root, or absolute inside it. Paths outside the project,
  `~` paths, and links that lead out of it are refused.
- Listing, globbing and the built-in search skip `.git`, `node_modules`, `.hg`, `.svn`, `dist`,
  `target`, `vendor`, `__pycache__`, `.venv`, `.next` and the engine's own `go-sessions`.
- A tool result over 40,000 characters (9,000 for a sub-agent) keeps its start and end, and says
  how many characters were left out in the middle. Cuts never split a character.
