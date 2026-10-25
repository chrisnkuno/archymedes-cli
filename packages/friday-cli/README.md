# Friday

A coding agent for your terminal. It reads, searches, edits and runs commands in a real project,
asks before it changes anything you have not allowed, shows its work as it goes, and does not call
a change done until something has shown it works. It runs on the model you choose: your own key
for any of ten providers, free models through OpenRouter, your Claude subscription through your own
Claude Code, or your ChatGPT plan through your own Codex.

```bash
npm install -g @archymedes/friday
friday                                  # a session in this folder
friday "fix the failing test in src/parser.ts"   # a session that starts with that request
friday --resume latest                  # carry on where you left off
```

The first run asks for a provider: pick one, paste its key, choose a model from the list the
provider sends back. Nothing else is required.


**Contents:** [Its engine](#its-engine) · [The interface](#the-interface) · [Working with Friday](#working-with-friday) · [What keeps it safe](#what-keeps-it-safe) · [Providers](#providers) · [Extending it](#extending-it) · [In an editor](#in-an-editor) · [Without the interface](#without-the-interface) · [Requirements](#requirements)

## Its engine

The part of Friday that talks to the model and does the work is written in Go and runs inside the
`friday` binary. You do not choose it: when a session needs something only the earlier TypeScript
engine has (Claude Code, Codex, a Docker or E2B sandbox, `/undo`), Friday runs that session there
on its own. Settings → Engine, or `ARCHYMEDES_ENGINE=ts`, picks the TypeScript engine for every
session.

On the Go engine:

- **Helpers that keep working while Friday does.** Friday hands parts of a task to helpers
  (sub-agents). There are explorers that search several areas at once, a planner, an independent
  reviewer, a verifier that runs the checks, and helpers that do a whole piece of work. A helper can run in
  the background while Friday carries on; one that edits files in the background does so on its
  own git branch, so the two never edit the same file at once. `/subagents` lists them.
- **Nothing lost to a crash or a quit.** Every step is saved; a helper cut off resumes when you
  open the session again.
- **Talk to it while it works.** What you type mid-turn reaches Friday at its next step.
- **Cheap work on a cheap model**, if you name one (`<PROVIDER>_SMALL_MODEL`): searching, checking,
  summarizing and titles.
- **It notices going in circles**, and **waits out rate limits** as long as the provider says.

Full documentation: [the engine](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/README.md),
the [user guide](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/USER_GUIDE.md),
[configuration](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/CONFIGURATION.md),
[tools](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/TOOLS.md),
[helpers](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/SUBAGENTS.md) and
[editors](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/EDITORS.md).

## The interface

`friday` opens a small desktop in the terminal: a top bar with a `◇` start menu (`ctrl+space`
finds any app, action, session or file), a tab per open window, and a dock. The dock has every app
and its key: **F1** Chat, **F2** Files, **F3** Search, **F4** Sessions, **F5** Models, **F6** Themes,
**F7** Keys, **F8** Help, **F9** Stats, **F10** Changes, **F12** Gallery; `alt+p` Providers and
`alt+s` Settings. Everything is reachable by key and by mouse.

**Tiles.** Choices worth seeing are grids of square tiles, moved through with all four arrows:

- `/theme`: each theme as a small screen in its colours
- `/wallpaper`: each picture as a preview; tab jumps to the next theme
- `/mode`: the four modes and what each may do
- `/welcome`: the first-run walkthrough
- Providers: each one in use, ready, or what it needs
- Settings: a tile per section, opening into its list

**First run.** Friday opens on a walkthrough of six steps, each one tile grid or one question. It
asks for a name (kept on this machine, for the greeting), then a theme and a mode. You try four keys
in place, see what it is connected to, and choose whether installs are counted. Last you pick a
first request. enter goes on, backspace goes back, and esc skips the rest. `/welcome` opens it again.

**Arrow keys.** In lists ↑/↓ move and enter picks. In Settings the side arrows
step a choice in place, saved as you go, and in the model list they switch all, free and ready. In
the Gallery they turn the picture, and ↑/↓ jump theme by theme. Pickers preview as you move; esc
puts back what was there.

- **Chat** streams the reply and every tool call with its result, folded (`ctrl+o` unfolds). A
  helper's card shows what it is doing while it works, and its report when it is done.
- **Changes** is the working tree against the last commit, file by file, with each file's diff;
  `b` turns to **Branches**: branches, worktrees and the stash.
- **Models** lists every model of every provider, read live, with prices; **Providers** connects,
  switches and sets the default.
- **Stats** draws the session: tokens, time and tools per turn.
- **Gallery** shows the pictures behind the screen, full size: photographs (antiquity, sci-fi,
  abstract) and art Friday draws in code. `/wallpaper` picks one, a theme, or none.

Type `/` to see every command with what it does.

## Working with Friday

| Command | Does |
| --- | --- |
| `/plan` `/build` `/auto` `/defender` | how much Friday may do on its own: read and propose only; every edit and command asks (default); edits and commands run unasked, risky ones still ask; security work where every change asks. shift+tab switches |
| `/model [name]` | switch the model; the conversation carries on, across providers |
| `/subagents` | the helpers of this session: what each is doing, or what it found |
| `/todos` | Friday's checklist for the task |
| `/tools` | every tool Friday has in this mode, what it may change, and whether it asks |
| `/compact [focus]` | summarize the conversation to free room, keeping what you name |
| `/commit [guidance]` | Friday reviews the changes and commits them (never pushes) |
| `/push`, `/pr [guidance]` | push the branch; `/pr` then has Friday open the pull request with `gh` |
| `/worktree [name]` | a new session on a new branch in its own worktree; `/worktree back` returns |
| `/resume`, `/new`, `/export` | earlier sessions; a fresh one; this one as Markdown |
| `!command` | run a shell command yourself; its output shows here and is not sent to Friday |
| `@path` | mention a file in your message |

On the TypeScript engine only, for now (a command that is not there says so, and how to switch):
`/undo`, `/rewind`, `/diff`, `/cost`, `/review`, `/fork`, `/goal`, `/context`, `/memory`.

**Defender.** `/defender` (or `--defender`) makes Friday a defensive security engineer. It reads
the security playbooks that fit the project, from access control to AI applications, scans for
hardcoded secrets, and reports each finding with its file and line, the input that triggers it,
and its impact. Every change it makes asks first.

**Steering.** A message sent while a turn runs reaches Friday at its next step, within the same
turn: "use tabs, not spaces" lands before the next edit.

**Comments on diffs.** In Changes, `[` and `]` pick a line and `c` writes a note on it; your notes
go with your next message, each with its file, line and code.

## What keeps it safe

**Approval.** In build mode every edit and every command that is not read-only is shown and asked
for: once, always for that exact action, or for a safe pattern (a command prefix, a folder). Plan
mode has no tool that can change anything. Auto mode still stops for anything sensitive:
credentials, deploys, publishing, pushes, privileged commands. Read-only commands (`git status`,
`ls`, `rg`) never ask, and some commands are refused outright (`rm -rf`, `git reset --hard`,
`mkfs`).

**Proof before "done".** A turn that changed files is asked, once, to show the change works; a
build alone is weaker proof than tests that run the changed behaviour. By default Friday builds
test first: the tests that define done, seen failing, then the code, then the project's own static
check.

**Command rules.** `.archymedes/rules.json` (or `rules.json` in the config directory) says what to
`allow`, always `ask`, or `forbid`, by a command's first words. Each rule can carry examples that
are checked when it loads, so a rule that does not do what you meant is reported, not trusted:

```json
{ "rules": [
  { "prefix": ["rm", ["-rf", "-fr"]], "decision": "forbid", "reason": "Use trash-put instead.", "match": ["rm -rf build"] },
  { "prefix": ["git", "push"], "decision": "ask", "not_match": ["git pull"] },
  { "prefix": ["npm", ["test", "run"]], "decision": "allow" }
] }
```

**It never overwrites what it has not seen.** A file that changed since Friday read it is not edited or
overwritten until it is read again.

**On the TypeScript engine:** checkpoints before every turn (for `/undo` and `/rewind`), the Linux
command sandbox (`ARCHYMEDES_SANDBOX=on`, bubblewrap), and whole sessions in Docker
(`--sandbox docker`) or a remote E2B sandbox (`--sandbox e2b`).

## Providers

| Provider | Key |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Google Gemini | `GOOGLE_API_KEY` |
| xAI | `XAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Ollama (local) | — |
| Any OpenAI-compatible endpoint | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` |
| Free models (`--free`) | `OPENROUTER_API_KEY` |
| Claude (your subscription) | none: your own Claude Code, signed in (`claude auth login`) |
| Codex (your ChatGPT plan) | none: your own Codex CLI, signed in (`codex login`) |

Keys can be set in the environment or saved through Providers or `friday settings`.
`<PROVIDER>_MODEL` picks the model and `<PROVIDER>_SMALL_MODEL` a cheaper one for helpers and
summaries. Claude and Codex run through your own installed tools, on the TypeScript engine; Friday
never handles either account's credentials.

## Extending it

Everything lives under `.archymedes/` in the project, so it travels with the repository.

- **Helpers of your own** — `.archymedes/agents/<name>.md`: a role with its instructions, tools,
  model and limits. See [helpers](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/SUBAGENTS.md#writing-a-role).
- **Custom commands** — `.archymedes/commands/audit.md` becomes `/audit`; `$ARGUMENTS` is what you
  type after it.
- **Project instructions** — `AGENTS.md` (or `CLAUDE.md`, `ARCHYMEDES.md`) at the root is given to
  Friday with every request.
- **On the TypeScript engine:** skills (`.archymedes/skills/`), hooks (`.archymedes/hooks/`), MCP
  servers (`.archymedes/mcp.json`), plugins, and `/memory`.

## In an editor

`friday acp` speaks the Agent Client Protocol on stdio. In Zed:

```json
{ "agent_servers": { "Friday": { "command": "friday", "args": ["acp"] } } }
```

## Without the interface

```
friday --json "add a health check"   one request; events and result as JSON lines, for scripts
echo "add a health check" | friday   the same, from a pipe
friday --plan | --auto | --defender  start in a mode
friday --provider groq --model openai/gpt-oss-120b
friday --free                        free models only; never falls back to a paid one
friday --resume [id|latest]          continue a session
friday settings                      keys, models, preferences
friday history                       earlier sessions
friday doctor                        what is wrong with your setup, if anything
friday update                        install the newest Friday
friday login | logout                link this computer to your Friday account, or unlink it
friday account | keys                who it is linked as; the provider keys your account holds
friday --help                        all of it
```

## Requirements

Linux, macOS or Windows, x64 or arm64: the `friday` binary is installed with the package. Node 22.5
or newer runs the TypeScript agent for settings, `--json`, and sessions on the TypeScript engine.
Where the binary cannot run, those still work. `git` enables Changes, helpers that edit in the
background, and worktrees; `gh` is needed for `/pr`; ripgrep makes search faster.

Apache-2.0 licensed. Source: [github.com/chrisnkuno/archymedes-cli](https://github.com/chrisnkuno/archymedes-cli).
