# archymedes

A coding agent for your terminal. It reads, searches, edits and runs commands in a real project,
asks before it changes anything you have not allowed, keeps a checkpoint before every turn, and
says what each request cost. It works with the model you choose: your own API key for any of ten
providers, free models through OpenRouter, or your Claude subscription through your own Claude Code.

```bash
npm install -g archymedes-cli
archymedes                                   # the interface
archymedes "fix the failing test in src/parser.ts"   # one request, then exit
```

The first run asks for a provider: pick one, paste its key, choose a model from the list the
provider sends back. Nothing else is required.

## The interface

`archymedes` opens a small desktop in the terminal: a top bar with a `◇` start menu
(`ctrl+space` finds any app, action, session or file), a tab per open window, and a dock with every
app and its key — **F1** Chat, **F2** Files, **F3** Search, **F4** Sessions, **F5** Models,
**F6** Themes, **F7** Keys, **F8** Help, **F9** Stats, **F10** Changes, **F12** Gallery; `alt+p`
Providers and `alt+s` Settings. Everything is reachable by key and by mouse.

- **Chat** streams the reply and every tool call with its result, folded (`ctrl+o` unfolds).
- **Changes** is the working tree against the last commit, file by file, with each file's diff;
  `b` turns to **Branches**: local and remote branches with how they stand against their upstream,
  worktrees, and the stash, each readable in place.
- **Models** lists every model of every provider, read live, with prices; **Providers** connects,
  switches and sets the default.
- **Stats** draws the session: tokens, time and tools per turn.

`/help` lists every command; the most used are below.

## Working with the agent

| | |
| --- | --- |
| `/plan` `/build` `/auto` `/defender` | What the agent may do: read only; edit with approval (default); edit and run ordinary things without asking; security review where every change asks |
| `/model [name]` | Switch model; the conversation carries on, across providers |
| `/undo [code\|conversation]` | Revert the last turn — files, conversation or both; again for the one before |
| `/rewind` | Every turn of the session with what it changed; go back to before any of them |
| `/diff` | What changed since the last checkpoint |
| `/review [base <ref>\|commit <ref>\|branch <ref>\|focus]` | A read-only review of a change, findings worst first; `R` on a branch in Branches reviews it |
| `/commit [guidance]` | The agent reviews the changes and commits them (never pushes) |
| `/push`, `/pr [guidance]` | Push the branch; `/pr` then has the agent open the pull request with `gh`. On the default branch a new branch is offered first |
| `/goal <condition>` | Keep working, turn after turn, until the condition holds — judged after each turn, at most ten |
| `/worktree [name]` | A new session on a new branch in its own worktree; `.archymedes/setup.sh` runs there first; `/worktree back` returns |
| `/fork` | Copy the conversation into a new session; the original stays as it was |
| `/compact [focus]`, `/context` | Summarize the conversation to free room; see what fills the context window |
| `/resume`, `/new`, `/export` | Earlier sessions; a fresh one; this one as Markdown |
| `!command` | Run a shell command yourself; its output shows here and is not sent to the agent |
| `@path` | Mention a file in your message |

**Steering.** A message sent while a turn runs reaches the agent after the tool calls in flight,
within the same turn — "use tabs, not spaces" lands before the next edit.

**Comments on diffs.** In Changes, `[` and `]` pick a line and `c` writes a note on it; your notes
go with your next message, each with its file, line and code.

## What keeps it safe

**Approval.** In build mode every edit and command is shown and asked for: once, always for that
exact action, or for a pattern (a command prefix, a directory). Plan mode does not load the write
tools at all. Auto mode still stops for anything sensitive — credentials, deploys, publishing,
pushes, destructive commands.

**Checkpoints.** Before each turn the workspace is snapshotted into a private git index and kept by a
hidden ref (`refs/archymedes/checkpoints/…`, never a branch), so `/undo` and `/rewind` work after a
resume and after `git gc`, and your staged changes are never touched.

**Command rules.** `.archymedes/rules.json` (or `rules.json` in the config directory) says what to
`allow`, always `ask`, or `forbid`, by a command's leading words. Each rule can carry examples that
are checked when it loads, so a rule that does not do what you meant is reported, not trusted:

```json
{ "rules": [
  { "prefix": ["rm", ["-rf", "-fr"]], "decision": "forbid", "reason": "Use trash-put instead.", "match": ["rm -rf build"] },
  { "prefix": ["git", "push"], "decision": "ask", "not_match": ["git pull"] },
  { "prefix": ["npm", ["test", "run"]], "decision": "allow" }
] }
```

A forbidden command is refused with its reason, and the agent carries on another way.

**Command sandbox (Linux).** With `ARCHYMEDES_SANDBOX=on` and bubblewrap installed, commands can
write only to the project and the temporary directory, `.archymedes` stays read-only, and there is
no network (`ARCHYMEDES_SANDBOX_NETWORK=on` allows it). When something needs more, the agent asks
to run that one command outside, and you are always asked. Off by default; without it, an approved
command runs with your own permissions. `--sandbox` (E2B) and `--sandbox docker` run the whole
session in a container instead.

**Verification.** A turn that changed files without running anything that checks them ends as
`needs_verification`, not `completed`.

**Files changed under it.** When a file the agent read changes on disk, the next turn names it, so
it re-reads instead of editing from a stale copy.

## Providers

| Provider | Key |
| --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google Gemini | `GOOGLE_API_KEY` |
| xAI | `XAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Ollama (local) | — |
| Any OpenAI-compatible endpoint | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` |
| Free models (`--free`) | `OPENROUTER_API_KEY` |
| Claude (your subscription) | none: your own Claude Code, signed in (`claude auth login`) |

Keys can be set in the environment or saved through Providers or `archymedes settings`. Claude
runs through your installed Claude Code with Anthropic's Agent SDK (installed on your machine when
you connect it); Archymedes never handles your Claude credentials.

## Extending it

Everything lives under `.archymedes/` in the project, so it travels with the repository.

- **Custom commands** — `.archymedes/commands/audit.md` becomes `/audit`; `$ARGUMENTS` is what you
  type after it.
- **Skills** — `.archymedes/skills/<name>/skill.json`: a named command with an input schema.
- **Hooks** — scripts in `.archymedes/hooks/pre-tool-use/` (can block a call) and
  `post-tool-use/` (can warn).
- **MCP servers** — `.archymedes/mcp.json`.
- **Plugins** — `.archymedes/plugins/<name>/` bundle the above.
- **Memory** — `/memory` shows and edits what the agent remembers about you and the project, kept as
  plain Markdown.

Tools that did not ship with Archymedes always ask, in every mode, and say where they came from.

## Without the interface

```
archymedes "add a health check"      One request, then exit
archymedes --json "…"                Machine-readable events and result
archymedes --plan | --auto | --defender
archymedes --provider groq --model openai/gpt-oss-120b
archymedes --free                    Free models only; never falls back to a paid one
archymedes --resume                  Continue the last session
archymedes --budget 500              A spend cap for the session, in your currency
archymedes --estimate "task"         Forecast tokens and cost without calling a model
archymedes acp                       The Agent Client Protocol on stdio, for an editor (Zed, JetBrains)
archymedes settings | history | doctor | update
```

## Requirements

Node 22.5 or newer on Linux, macOS or Windows. The interface is a native binary installed with the
package for linux, darwin and win32 on x64 and arm64; where none fits, every mode without the
interface still works. `git` enables checkpoints, Changes, review and worktrees; `gh` is needed for
`/pr`; bubblewrap for the command sandbox.

Apache-2.0 licensed. Source: [github.com/chrisnkuno/archymedes-cli](https://github.com/chrisnkuno/archymedes-cli).
