# Configuration

Everything the Go engine reads, where it reads it from, and what each value does.

- [Where settings live](#where-settings-live)
- [Choosing the engine](#choosing-the-engine)
- [Providers and keys](#providers-and-keys)
- [Models](#models)
- [Behaviour](#behaviour)
- [Command rules](#command-rules)
- [Your own sub-agent roles](#your-own-sub-agent-roles)
- [Project instructions](#project-instructions)
- [Diagnostics](#diagnostics)
- [Every variable, in one table](#every-variable-in-one-table)

## Where settings live

Settings are flat `KEY: "value"` pairs in `settings.json`, in Friday's config directory:

| System | Directory |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/archymedes`, else `~/.config/archymedes` |
| macOS | `~/Library/Application Support/Archymedes` |
| Windows | `%APPDATA%\Archymedes` |
| Anywhere | `ARCHYMEDES_CONFIG_DIR`, when set |

Three ways to change them, all writing the same file:

- **In a session**: Settings (alt+s or `/settings`), Providers (alt+p), `/key`, `/model`.
- **From the shell**: `friday settings`.
- **By hand**: edit `settings.json`.

An environment variable with the same name always wins over the file, so a key exported in your
shell is used even when the file holds another. The engine reads settings when a session opens; a
change applies to the next session.

## Choosing the engine

| Value | Where | Effect |
| --- | --- | --- |
| `--engine go` / `--engine ts` | command line | this run only |
| `ARCHYMEDES_ENGINE=go` / `ts` | environment | every run in this shell |
| **Settings → Behaviour → Engine** (`ARCHYMEDES_ENGINE` in `settings.json`) | settings | every run |
| nothing set | — | the Go engine, with the TypeScript engine taking a session that needs it ([the rule](README.md#which-engine-runs)) |

`auto` is accepted as "nothing set". Anything else is refused with a message.

## Providers and keys

A provider is ready when its key (and, for some, its address) is set. Without an explicit choice,
Friday uses the provider you used last (`ARCHYMEDES_PROVIDER`, remembered for you), else the first
ready one in this order:

| Provider | `--provider` | Needs | Default model | How the Go engine reaches it |
| --- | --- | --- | --- | --- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-sonnet-5` | Messages API, native, with prompt caching |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5.6-terra` | OpenAI API |
| Archymedes Cloud | `archymedes-cloud` | `ARCHYMEDES_CLOUD_TOKEN`, `ARCHYMEDES_CLOUD_BASE_URL` | `auto` | TypeScript engine only |
| OpenRouter | `openrouter` | `OPENROUTER_API_KEY` | `openrouter/auto` | Chat Completions at `https://openrouter.ai/api/v1` |
| Google Gemini | `google` | `GOOGLE_API_KEY` | `gemini-2.5-pro` | Chat Completions (Google's OpenAI-compatible endpoint) |
| xAI Grok | `xai` | `XAI_API_KEY` | `grok-4` | Chat Completions |
| DeepSeek | `deepseek` | `DEEPSEEK_API_KEY` | `deepseek-chat` | Chat Completions |
| Mistral | `mistral` | `MISTRAL_API_KEY` | `mistral-large-latest` | Chat Completions |
| Groq | `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Chat Completions |
| Ollama (local) | `ollama` | — | `llama3.1` | Chat Completions at `http://localhost:11434/v1` |
| OpenAI-compatible | `openai-compatible` | `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL` | `gpt-4o-mini` | Chat Completions at your address |
| Free models | `free` / `--free` | `OPENROUTER_API_KEY` | `openrouter/free` | OpenRouter, free models only |
| Claude Code | `claude` | your own `claude` sign-in | — | TypeScript engine only |
| Codex | `codex` | your own `codex` sign-in | — | TypeScript engine only |

Each provider's settings share a prefix: the id in capitals with `-` as `_` (`openai-compatible` →
`OPENAI_COMPATIBLE`, `free` → `FREE`, so free mode's model is `FREE_MODEL`).

| Variable | Does |
| --- | --- |
| `<PREFIX>_API_KEY` | the key, as in the table's "Needs" column (Ollama needs none; free mode's is `OPENROUTER_API_KEY`) |
| `<PREFIX>_MODEL` | the model to use instead of the default |
| `<PREFIX>_SMALL_MODEL` | the model for cheap work; see [Models](#models) |
| `<PREFIX>_BASE_URL` | another address: a regional endpoint, a proxy, a self-hosted gateway |
| `OPENROUTER_BASE_URL` | free mode's address, when not OpenRouter's own |

**Free mode never pays.** With `--free` or `ARCHYMEDES_PROVIDER=free`, only `openrouter/free` or a
model ending in `:free` is accepted, for the main model, the small model and any role's model.
A session that remembered free mode never falls through to a paid provider when the key is gone.

## Models

| Variable | Default | Does |
| --- | --- | --- |
| `<PREFIX>_MODEL` | the provider's default | the main model |
| `<PREFIX>_SMALL_MODEL` | — | the small model, for this provider |
| `ARCHYMEDES_SMALL_MODEL` | — | the small model, for any provider without its own |
| `ARCHYMEDES_CONTEXT_LIMIT` | `128000` | the main model's context window in tokens (at least 8000); compaction starts at 80% of it |

Without a small model, the main model does everything. What runs on which:

| Work | Model |
| --- | --- |
| the conversation; plan, review and general helpers | main |
| explore and verify helpers | small |
| compaction (automatic and `/compact`) | small |
| session titles | small |
| a role file's `model:` | `main`, `small`, or a model id of the same provider |

## Behaviour

| Setting | Default | Does |
| --- | --- | --- |
| `ARCHYMEDES_TEST_FIRST` (Settings → Build test first) | `on` | for code changes: tests first and seen failing, then the code, then the project's static check. `off`: only the ordinary proof rule |
| `ARCHYMEDES_TITLES` | on | `off` keeps a session's title as the first line of its first request, with no title request to the small model |
| `ARCHYMEDES_SUGGEST` (Settings → Suggestions) | `on` | next steps after a turn, notes on each edit and hints while you type ([User guide](USER_GUIDE.md#suggestions-while-you-work)). `off`: none of them |
| `ARCHYMEDES_SUGGEST_MODEL` | `off` | `on`: the small model proposes up to two next steps of its own after each turn, for one small call |
| `ARCHYMEDES_JEV` | `on` | with `TYPESAFE_API_KEY` set, Jev weighs the suggestions and notes edits; `off` never calls it. `TYPESAFE_MODEL` names the Jev model (`jev-latest` by default) |
| `ARCHYMEDES_DEFER_TOOLS` | `auto` | which tools are found on demand with `tool_search` instead of being sent with every request. `auto`: `git_log`, `git_show`, `todo_read`, `close_agent`. `off`: send every tool. A comma list: exactly those names |
| `ARCHYMEDES_PROVIDER` | — | the provider to use when none is chosen; set for you when you pick one |

Modes are chosen per session (`--plan`, `--build`, `--auto`, `--defender`, or shift+tab), not by a
setting; a resumed session keeps its own.

## Command rules

Rules you write once instead of answering the same approval every day. A rule names a command by
its first words and says **allow** (run without asking), **ask** (always ask, even in auto mode or
under a standing approval) or **forbid** (never run; the model is told your reason).

Two files are read, both optional: `.archymedes/rules.json` in the project, and `rules.json` in the
config directory.

```json
{
  "rules": [
    { "prefix": ["npm", ["test", "run"]], "decision": "allow" },
    { "prefix": ["git", "push"], "decision": "ask", "reason": "pushes are reviewed",
      "match": ["git push origin main"], "not_match": ["git pull"] },
    { "prefix": ["rm", ["-rf", "-fr"]], "decision": "forbid", "reason": "use trash-put instead" }
  ]
}
```

- **prefix**: the command's first words. An element that is a list matches any one of its words.
- **decision**: `allow`, `ask` or `forbid`.
- **reason**: shown to the model with a refusal, and to you with a question.
- **match** / **not_match**: examples checked when the rules load. A rule whose examples fail is
  left out, and a line at the start of the session names it and why.
- A compound command (`a && b`, `a | b`, `a; b`) is judged part by part: forbidden if any part is,
  asked if any part asks, allowed only if every part is allowed.
- In defender mode, `allow` rules still ask: every change there is looked at.

## Your own sub-agent roles

A Markdown file per role, in `.archymedes/agents/` in the project or `agents/` in the config
directory. A file with a built-in role's name replaces it. Full reference:
[Sub-agents → Writing a role](SUBAGENTS.md#writing-a-role).

```markdown
---
name: migrations
description: writes and checks database migrations
tools: read_file, grep_files, write_file, edit_file, run_command
readonly: false
model: small
background: false
max-iterations: 20
max-tool-calls: 60
---
You write database migrations for this project. Every migration has a down step…
```

## Project instructions

The first of these files found at the project root is given to the model with every request, as
instructions from the people who work there: `AGENTS.override.md`, `ARCHYMEDES.md`, `AGENTS.md`,
`CLAUDE.md`, `.archymedesrules`. Up to 20,000 characters are used. Sub-agents do not receive it;
their brief says what they need.

## The interface

Read by the `friday` binary itself, for what the screen looks like. Each is also a row of Settings
(Appearance) unless marked as environment only.

| Variable | Default | Does |
| --- | --- | --- |
| `ARCHYMEDES_THEME` | `archymedes-blue` | the colours; `--theme` or `/theme` for one run or to change it |
| `ARCHYMEDES_LANGUAGE` | your locale | the interface's language |
| `ARCHYMEDES_PHOTOS` (environment only) | on | `off` leaves the pictures out; `local` keeps them to the built-in copies (the Gallery fetches nothing) |
| `ARCHYMEDES_WALLPAPER` (environment only) | on | `off` keeps the pictures but not behind the whole screen |
| `ARCHYMEDES_REDUCE_MOTION` (environment only) | off | any value turns off animated scrolling and keeps the wallpaper still |

## Diagnostics

| Variable | Does |
| --- | --- |
| `ARCHYMEDES_ACP_TRACE=<file>` | appends every protocol message between the interface and the engine |
| `ARCHYMEDES_DEBUG_LOG=<file>` | the interface's structured log; its first `engine` line says which engine runs and why |
| `ARCHYMEDES_AGENT=<command>` | the TypeScript agent's command (the npm launcher sets it; a JSON array or a space-separated string) |

## Every variable, in one table

| Variable | Read by | Section |
| --- | --- | --- |
| `ARCHYMEDES_ENGINE` | the `friday` binary | [Choosing the engine](#choosing-the-engine) |
| `ARCHYMEDES_CONFIG_DIR` | both engines and the interface | [Where settings live](#where-settings-live) |
| `ARCHYMEDES_PROVIDER` | both engines | [Providers and keys](#providers-and-keys) |
| `<PREFIX>_API_KEY`, `<PREFIX>_MODEL`, `<PREFIX>_BASE_URL` | both engines | [Providers and keys](#providers-and-keys) |
| `<PREFIX>_SMALL_MODEL`, `ARCHYMEDES_SMALL_MODEL` | Go engine | [Models](#models) |
| `ARCHYMEDES_CONTEXT_LIMIT` | Go engine | [Models](#models) |
| `ARCHYMEDES_TEST_FIRST` | both engines | [Behaviour](#behaviour) |
| `ARCHYMEDES_TITLES` | Go engine | [Behaviour](#behaviour) |
| `ARCHYMEDES_SUGGEST` | Go engine | [Behaviour](#behaviour) |
| `ARCHYMEDES_SUGGEST_MODEL` | both engines | [Behaviour](#behaviour) |
| `ARCHYMEDES_JEV`, `TYPESAFE_API_KEY`, `TYPESAFE_MODEL` | both engines | [Behaviour](#behaviour) |
| `ARCHYMEDES_DEFER_TOOLS` | Go engine | [Behaviour](#behaviour) |
| `OPENROUTER_BASE_URL` | Go engine (free mode) | [Providers and keys](#providers-and-keys) |
| `ARCHYMEDES_FREE_GATEWAY_URL` | TypeScript engine; the binary reads it to choose the engine | [Providers and keys](#providers-and-keys) |
| `ARCHYMEDES_ACP_TRACE`, `ARCHYMEDES_DEBUG_LOG`, `ARCHYMEDES_AGENT` | the `friday` binary | [Diagnostics](#diagnostics) |
| `ARCHYMEDES_THEME`, `ARCHYMEDES_LANGUAGE`, `ARCHYMEDES_PHOTOS`, `ARCHYMEDES_WALLPAPER`, `ARCHYMEDES_REDUCE_MOTION` | the `friday` binary | [The interface](#the-interface) |

Key bindings are changed in the Keys app (F7) and saved to `keys.json` in the config directory.
