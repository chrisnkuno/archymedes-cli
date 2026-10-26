# Friday

**A coding agent for your terminal.** It shows its work, asks before it changes anything, and
proves a change works before it calls it done. Bring any model: your own key for one of ten
providers, free models, your Claude subscription, or your ChatGPT plan.

```bash
npm install -g @archymedes/friday
cd your-project
friday
```

That is all. The first run walks you through choosing a model; then you type what you want done.

---

**Contents**

- Getting going: [Why Friday](#why-friday) · [Start in three steps](#start-in-three-steps) · [Choose your model](#choose-your-model)
- Using it: [How a request runs](#how-a-request-runs) · [Modes](#modes-how-much-it-may-do-alone) · [Helpers](#helpers-several-agents-at-once) · [The interface](#the-interface) · [Commands](#commands)
- Trusting it: [What keeps your code safe](#what-keeps-your-code-safe) · [Make it yours](#make-it-yours)
- Everything else: [Scripts and editors](#scripts-and-editors) · [Questions](#questions) · [Requirements](#requirements)

## Why Friday

| | What you get |
| --- | --- |
| 🔌 **Any model** | Ten providers with your own key, free models through OpenRouter, Ollama on your machine, **your Claude subscription** through your own Claude Code, or **your ChatGPT plan** through Codex. Switch mid-conversation with `/model`; the conversation carries on. |
| 🛡️ **Asks before it acts** | Four modes, from "read and propose only" to "run on its own, but stop for anything risky". Every edit and command can be approved once, always, or by pattern. |
| ✅ **Proof before "done"** | A change is not finished until something shows it works. By default Friday writes the tests first, sees them fail, then writes the code. |
| 🤝 **Helpers in parallel** | Friday hands parts of a task to helpers: explorers searching several places at once, a planner, a reviewer, a verifier. Helpers that edit in the background work on their own git branch. |
| 💬 **Talk to it while it works** | Type while it runs: "use tabs, not spaces" reaches it before its next edit, not after the turn. |
| 💾 **Nothing lost** | Every step is saved. Close the terminal, or let it crash, and `friday --resume latest` carries on, helpers included. |
| 🖥️ **A desktop in your terminal** | Windows for chat, files, changes, sessions and models, driven by arrow keys and the mouse. |
| 🔒 **Defender mode** | A security engineer that follows playbooks, scans for leaked secrets, and reports each finding with its file, line and impact. |
| 🧩 **Works where you work** | In Zed and other editors over the Agent Client Protocol, or in scripts with `--json`. |

## Start in three steps

1. **Install it.** `npm install -g @archymedes/friday` puts a single `friday` command on your machine.
2. **Run it in a project.** `cd` into a folder with code and type `friday`. A short walkthrough asks
   for your name, a theme and a mode, then which model to use. Pick a provider, paste its key, and
   choose a model from the list it sends back. Choosing Claude or Codex signs in through those tools
   instead.
3. **Ask for something.** Type a request and press enter:

```bash
friday                                          # open a session in this folder
friday "fix the failing test in src/parser.ts"  # open it with a request already sent
friday --resume latest                          # carry on where you left off
friday --free                                   # free models only, never a paid one
```

`friday --help` lists every option, and `/` inside a session lists every command.

## Choose your model

| Provider | What you need |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Google Gemini | `GOOGLE_API_KEY` |
| xAI | `XAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Ollama (local) | nothing: Ollama running on this computer |
| Any OpenAI-compatible endpoint | `OPENAI_COMPATIBLE_API_KEY` and `OPENAI_COMPATIBLE_BASE_URL` |
| Free models (`--free`) | `OPENROUTER_API_KEY`; only free models are ever used |
| **Claude (your subscription)** | your own Claude Code, signed in (`claude auth login`) |
| **Codex (your ChatGPT plan)** | your own Codex CLI, signed in (`codex login`) |

**Where keys go.** Paste them into Providers (`alt+p`) or `friday settings`, or set them in your
environment. `<PROVIDER>_MODEL` picks a provider's model, and `<PROVIDER>_SMALL_MODEL` a cheaper
one for searching, checking and summaries.

**Your Claude plan.** With Claude chosen, your own Claude Code does the work, billed to your plan.
Friday streams its replies, puts its permission questions in Friday's approval dialog, and keeps the
conversation if you switch models. Friday never sees your Claude or ChatGPT account.

## How a request runs

1. **It looks first.** Friday reads and searches the project, often with helpers exploring several
   places at once.
2. **It plans the work** as a checklist you can see (`/todos`).
3. **It writes the tests first**, runs them, and sees them fail for the right reason.
4. **It changes the code**, asking before each edit or command your mode does not allow on its own.
   Every tool call shows in the chat as it happens, with its result.
5. **It proves the change works** by running the tests, then the project's own checks. A build
   alone is not enough.
6. **It suggests what is next:** up to three next steps, each with why. `alt+1`, `alt+2` or `alt+3`
   puts one in the input.

You can type at any point: what you send reaches Friday at its next step. esc stops the turn.

## Modes: how much it may do alone

| Mode | What it may do | Switch with |
| --- | --- | --- |
| **Plan** | read and propose; it has no tool that can change anything | `/plan` |
| **Build** (default) | every edit and every command that is not read-only asks you first | `/build` |
| **Auto** | edits and commands run on their own; anything risky still asks | `/auto` |
| **Defender** | security work: finds and fixes vulnerabilities, every change asks | `/defender` |

shift+tab cycles through them, and `--plan`, `--auto` or `--defender` starts in one. Read-only
commands such as `git status`, `ls` or `rg` never ask, in any mode.

## Helpers: several agents at once

Friday splits work between helpers (sub-agents) and uses them on its own when a task calls for it:

- **explore** searches several parts of the project at the same time;
- **plan** designs an approach before anything changes;
- **review** reads a change with fresh eyes;
- **verify** runs the checks and reports what passed;
- **general** does a whole piece of work.

A helper can run in the background while Friday carries on. One that edits in the background works
on its own git branch, so it never edits a file under Friday, and its report says how to take its
work. `/subagents` shows what each is doing. Write your own in `.archymedes/agents/<name>.md` (see
[writing a role](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/SUBAGENTS.md#writing-a-role)).

## The interface

`friday` opens a small desktop in the terminal. Everything works with the keyboard and the mouse.

| Key | Opens | Key | Opens |
| --- | --- | --- | --- |
| F1 | **Chat**: the conversation and every tool call | F7 | **Keys**: every shortcut |
| F2 | **Files**: browse and preview | F8 | **Help** |
| F3 | **Search** across the project | F9 | **Stats**: tokens, time and tools per turn |
| F4 | **Sessions**: earlier conversations | F10 | **Changes**: each changed file and its diff |
| F5 | **Models**: every model, live, with prices | F12 | **Gallery**: the pictures behind the screen |
| F6 | **Themes** | `alt+p` / `alt+s` | **Providers** / **Settings** |

- **One way to move.** A click selects and a second click opens. The arrows move, enter opens, and
  esc steps back out to the bars. The wheel scrolls whatever is under the pointer.
- **Finder.** `alt+g` shows everything Friday can open as icons: apps, commands, sessions, files,
  themes. Type to search all of them.
- **Start menu.** `ctrl+space` finds any app, action, session or file by name.
- **Comment on a diff.** In Changes, `[` and `]` pick a line and `c` writes a note on it. Your notes
  go with your next message, each with its file, line and code.
- **Suggestions while you type.** The row above the input offers the command, earlier request or
  file you seem headed for; tab takes it. `ARCHYMEDES_SUGGEST=off` turns suggestions off.
- **Make it look like yours.** `/theme` and `/wallpaper` show previews as you move through them.
  `alt+w` replays the first-run walkthrough.

## Commands

Type `/` in a session to see them all. The ones you will use most:

| Command | Does |
| --- | --- |
| `/model [name]` | switch the model or provider; the conversation carries on |
| `/plan` `/build` `/auto` `/defender` | change the mode |
| `/todos` | Friday's checklist for the task |
| `/subagents` | the helpers: what each is doing or found |
| `/tools` | every tool in this mode, what it may change, and whether it asks |
| `/compact [focus]` | summarize the conversation to free room, keeping what you name |
| `/commit [guidance]` | Friday reviews the changes and commits them; it never pushes |
| `/push`, `/pr [guidance]` | push the branch; `/pr` then opens the pull request with `gh` |
| `/worktree [name]` | a new session on a new branch in its own worktree |
| `/resume`, `/new`, `/export` | an earlier session; a fresh one; this one as Markdown |
| `!command` | run a shell command yourself; its output is not sent to Friday |
| `@path` | mention a file in your message |

Some commands still need the earlier TypeScript engine: `/undo`, `/rewind`, `/diff`, `/cost`,
`/review`, `/fork`, `/goal`, `/context` and `/memory`. On Claude, `/undo` and `/cost` work through
Claude Code.
A command that is not available says so, and how to get it.

## What keeps your code safe

- **You approve changes.** An approval can be for this once, for this exact action from now on, or
  for a safe pattern such as a command prefix or a folder.
- **Risky actions always stop.** Even in auto mode, Friday asks before anything touching
  credentials, deploys, publishing, pushes or privileged commands. Some commands are refused
  outright: `rm -rf`, `git reset --hard`, `mkfs`.
- **It never overwrites what it has not seen.** A file that changed since Friday read it is read
  again before it is edited.
- **Your own rules.** `.archymedes/rules.json` says which commands to `allow`, always `ask`, or
  `forbid`, by their first words. Each rule can carry examples, checked when it loads, so a rule
  that does not do what you meant is reported:

```json
{ "rules": [
  { "prefix": ["rm", ["-rf", "-fr"]], "decision": "forbid", "reason": "Use trash-put instead.", "match": ["rm -rf build"] },
  { "prefix": ["git", "push"], "decision": "ask", "not_match": ["git pull"] },
  { "prefix": ["npm", ["test", "run"]], "decision": "allow" }
] }
```

- **Sandboxes when you want them.** On the TypeScript engine, commands can run in a Linux sandbox
  (`ARCHYMEDES_SANDBOX=on`), and whole sessions in Docker (`--sandbox docker`) or a remote E2B
  sandbox (`--sandbox e2b`).

## Make it yours

Everything lives under `.archymedes/` in the project, so it travels with the repository.

| File | Does |
| --- | --- |
| `AGENTS.md` (or `CLAUDE.md`, `ARCHYMEDES.md`) | project instructions, given to Friday with every request |
| `.archymedes/commands/audit.md` | a command of your own: `/audit`; `$ARGUMENTS` is what you type after it |
| `.archymedes/agents/<name>.md` | a helper of your own: its instructions, tools, model and limits |
| `.archymedes/rules.json` | which commands to allow, ask about, or forbid |

On the TypeScript engine there are also skills (`.archymedes/skills/`), hooks, MCP servers
(`.archymedes/mcp.json`) and plugins.

## Scripts and editors

**In an editor.** `friday acp` speaks the Agent Client Protocol on stdio. In Zed's settings:

```json
{ "agent_servers": { "Friday": { "command": "friday", "args": ["acp"] } } }
```

**In scripts.** Friday runs without the interface and prints results:

```
friday --json "add a health check"   one request; events and the result as JSON lines
echo "add a health check" | friday   the same, from a pipe
friday --provider groq --model openai/gpt-oss-120b
friday settings                      keys, models, preferences
friday history                       earlier sessions
friday doctor                        what is wrong with your setup, if anything
friday update                        install the newest Friday
friday login | logout                link this computer to your Friday account, or unlink it
```

## Questions

**Which engine runs my session?** Friday's engine is written in Go and runs inside the `friday`
binary. A session that needs something only the earlier TypeScript engine has (Codex, a Docker or
E2B sandbox, `/undo`) runs there on its own. Settings → Engine chooses one for every session.

**Can I use it without paying for a model?** Yes: `friday --free` with a free OpenRouter key uses
free models only and never falls back to a paid one. Ollama runs models on your own computer.

**Something is not working.** `friday doctor` says what is wrong with your setup. The
[user guide](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/USER_GUIDE.md#troubleshooting)
covers the rest.

**Where is the full documentation?** [The engine](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/README.md),
the [user guide](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/USER_GUIDE.md),
[configuration](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/CONFIGURATION.md),
[tools](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/TOOLS.md),
[helpers](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/SUBAGENTS.md) and
[editors](https://github.com/chrisnkuno/archymedes-cli/blob/master/docs/engine/EDITORS.md).

## Requirements

- **Linux, macOS or Windows**, on x64 or arm64. The `friday` binary comes with the package.
- **Node 22.5 or newer**, for settings, `--json` and sessions on the TypeScript engine.
- **Optional:** `git` for Changes, background helpers and worktrees; `gh` for `/pr`; ripgrep for
  faster search; Claude Code or Codex to use those plans.

Apache-2.0 licensed. Source: [github.com/chrisnkuno/archymedes-cli](https://github.com/chrisnkuno/archymedes-cli).
