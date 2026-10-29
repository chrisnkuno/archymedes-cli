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
- [Notifications](#notifications)
- [Diagnostics](#diagnostics)
- [The Settings list](#the-settings-list)
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

Keys the Settings list does not have are dropped when the file is saved. One key is kept that it
does not list: `ARCHYMEDES_FREE_PRIVACY_ACK`, which Friday sets to `yes` once it has shown the
free-mode privacy notice.

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
| Claude Code | `claude` | your own `claude` sign-in | `default` (Claude Code's choice) | your own Claude Code, driven over its stream-JSON protocol; see [Claude Code](#claude-code) |
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

## Claude Code

| Variable | Default | Does |
| --- | --- | --- |
| `ARCHYMEDES_CLAUDE_PATH` | the `PATH`, then `~/.local/bin` and `~/.claude/local` | where the `claude` program is |
| `ARCHYMEDES_CLAUDE_BILLING` | — | `api` passes `ANTHROPIC_API_KEY` to Claude Code, which then bills that key instead of your plan |
| `CLAUDE_CONFIG_DIR` | Claude Code's own | the folder Claude Code keeps its sign-in in; set in a [profile](USER_GUIDE.md#profiles), it runs another Claude account |
| `CLAUDE_MODEL` | `default` | the model new Claude sessions start on: `default`, `opus`, `sonnet`, `haiku` or a model id |
| `ARCHYMEDES_REASONING` | each model's own | the reasoning effort: `low`, `medium`, `high`, `xhigh` or `max` (`minimal` is `low`, `auto` is Claude Code's default). A change applies at the next turn: Claude Code is restarted on the same conversation |

Claude Code runs with the environment Friday was started in, never with the keys Friday keeps in
its settings file for other providers. It needs no key of its own: it is signed in, or not.

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
| `ARCHYMEDES_LSP` | on | after an edit, the file's language server (gopls, typescript-language-server, pyright, rust-analyzer, clangd, when installed) reports its errors to the model; `off`: never start one |
| `ARCHYMEDES_DEFER_TOOLS` | `auto` | which tools are found on demand with `tool_search` instead of being sent with every request. `auto`: `git_log`, `git_show`, `todo_read`, `close_agent`. `off`: send every tool. A comma list: exactly those names |
| `ARCHYMEDES_PROVIDER` | — | the provider to use when none is chosen; set for you when you pick one |

Modes are chosen per session (`--plan`, `--build`, `--auto`, `--defender`, or shift+tab), not by a
setting; a resumed session keeps its own.

Automatic updates (`ARCHYMEDES_AUTO_UPDATE`) install through the package manager Friday was
installed with, detected from the environment; set `ARCHYMEDES_PACKAGE_MANAGER` to `npm`, `pnpm`,
`yarn` or `bun` to force one. The newest version is read from the npm registry, or from
`ARCHYMEDES_UPDATE_REGISTRY` when set.

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

## Notifications

The interface tells you when a turn ends, or when an approval or a question waits for you.

| Variable | Default | Does |
| --- | --- | --- |
| `ARCHYMEDES_NOTIFY` | `auto` | `auto` notifies only while the terminal is not focused, `always` notifies every time, `off` never |
| `ARCHYMEDES_NOTIFY_URL` | — | a URL that takes a plain-text POST, such as an [ntfy](https://ntfy.sh) topic, so the notification reaches your phone |

The terminal shows its own notification where it has one (iTerm2, WezTerm, Ghostty, kitty, foot),
and rings the bell elsewhere and inside tmux. A terminal that does not report focus counts as
focused, so `auto` stays quiet there; choose `always` for it. The push URL receives one line, what
happened and the project's folder name, never a command, a file or a reply.

## Diagnostics

| Variable | Does |
| --- | --- |
| `ARCHYMEDES_ACP_TRACE=<file>` | appends every protocol message between the interface and the engine |
| `ARCHYMEDES_DEBUG_LOG=<file>` | the interface's structured log; its first `engine` line says which engine runs and why |
| `ARCHYMEDES_AGENT=<command>` | the TypeScript agent's command (the npm launcher sets it; a JSON array or a space-separated string) |

## The Settings list

Every setting the Settings app (alt+s) offers, in its order. The list is `internal/core/settings`;
this table is held to it by `TestConformSettingsDocumented`. A row for something the Go engine does
not do yet is read by the TypeScript engine.

| Variable | Section | Setting |
| --- | --- | --- |
| `ARCHYMEDES_THEME` | Appearance | Theme — colours for the whole CLI (/theme <name> also saves it) |
| `ARCHYMEDES_CODE_COLORS` | Appearance | Code colours |
| `ARCHYMEDES_CODE_LINE_NUMBERS` | Appearance | Line numbers in code blocks |
| `ARCHYMEDES_SIMPLE` | Appearance | Simple mode — quiet start, short help |
| `ARCHYMEDES_LANGUAGE` | Appearance | Control language |
| `ARCHYMEDES_REASONING` | Appearance | Reasoning effort — clear it to leave each model at its own default |
| `ARCHYMEDES_RESUME` | Behaviour | Continue your last chat at startup |
| `ARCHYMEDES_ENGINE` | Behaviour | Engine — what runs your sessions (applies to the next session) |
| `ARCHYMEDES_EDITOR_AUTOSAVE` | Behaviour | Auto-save in /edit |
| `ARCHYMEDES_VIM` | Behaviour | Vim keys in the input — esc for normal mode, i to type (/vim switches) |
| `ARCHYMEDES_SUGGEST` | Behaviour | Suggestions — next steps, notes on edits, hints while typing |
| `ARCHYMEDES_SUGGEST_MODEL` | Behaviour | Ask the model for extra suggestions (a small extra call per turn) |
| `ARCHYMEDES_NOTIFY` | Behaviour | Notifications — when a turn ends or Friday waits for you |
| `ARCHYMEDES_NOTIFY_URL` | Behaviour | Push URL for notifications, such as https://ntfy.sh/your-topic (event and folder name only) |
| `ARCHYMEDES_AUTO_UPDATE` | Behaviour | Automatic updates — install daily by default |
| `ARCHYMEDES_TELEMETRY` | Behaviour | Install count — one anonymous cue per new version (event, version, OS) |
| `ARCHYMEDES_TEST_FIRST` | Behaviour | Build test first — tests, then code, then static analysis |
| `ARCHYMEDES_JEV` | Behaviour | Jev second opinion — verdicts, tool checks, ranked suggestions |
| `ARCHYMEDES_KEYS` | Behaviour | Key bindings, e.g. /diff=alt+d,/wander=off |
| `ARCHYMEDES_SANDBOX` | Behaviour | Command sandbox (Linux, bubblewrap): commands write only to the project and /tmp |
| `ARCHYMEDES_SANDBOX_NETWORK` | Behaviour | Network inside the command sandbox |
| `FREE_MODEL` | Free mode | Free mode model (openrouter/free or publisher/model:free) |
| `ARCHYMEDES_TOKEN_SAVER` | Free mode | Free mode token saver |
| `ARCHYMEDES_TOKEN_METER` | Free mode | Token meter in the status line |
| `ARCHYMEDES_COUNTRY` | Money | Location — sets the currency costs are shown in |
| `ARCHYMEDES_CURRENCY` | Money | Display currency (overrides the one your location implies) |
| `ARCHYMEDES_ACCOUNT_BALANCE` | Money | Tracked spend balance — drawn down by each turn's measured cost |
| `ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY` | Money | Currency of the tracked balance (defaults to the display currency) |
| `ARCHYMEDES_LOW_BALANCE` | Money | Low-balance alert threshold, in the balance currency |
| `ARCHYMEDES_CRITICAL_BALANCE` | Money | Critical-balance threshold, in the balance currency |
| `ARCHYMEDES_PROVIDER` | Providers | Default provider |
| `ARCHYMEDES_PROFILE` | Providers | Profile — keys and choices from profiles/<name>.json, laid over these settings |
| `ARCHYMEDES_FALLBACK_MODEL` | Providers | Fallback after transient provider failure — ask, or provider:model |
| `CLAUDE_MODEL` | Providers | Claude model (your subscription) — opus, sonnet, haiku or a model id; empty for the default |
| `CODEX_MODEL` | Providers | Codex model (your ChatGPT plan) — a model id from Codex's list; empty for Codex's default |
| `ANTHROPIC_API_KEY` | Providers | Anthropic API key |
| `ANTHROPIC_BASE_URL` | Providers | Anthropic base URL |
| `ANTHROPIC_MODEL` | Providers | Anthropic model |
| `OPENAI_API_KEY` | Providers | OpenAI API key |
| `OPENAI_BASE_URL` | Providers | OpenAI-compatible base URL |
| `OPENAI_MODEL` | Providers | OpenAI model |
| `ARCHYMEDES_CLOUD_TOKEN` | Providers | Archymedes Cloud access token |
| `ARCHYMEDES_CLOUD_BASE_URL` | Providers | Archymedes Cloud base URL |
| `ARCHYMEDES_CLOUD_MODEL` | Providers | Archymedes Cloud route (default auto) |
| `ARCHYMEDES_CLOUD_MAXIMUM_MICROS` | Providers | Maximum cloud credits reserved per model call, in micros |
| `ARCHYMEDES_CLOUD_CURRENCY` | Providers | Cloud credit currency |
| `ARCHYMEDES_CLOUD_REGION` | Providers | Cloud routing region |
| `ARCHYMEDES_CLOUD_DATA_POLICY` | Providers | Cloud data policy |
| `ARCHYMEDES_CLOUD_QUALITY_FLOOR` | Providers | Cloud routing quality floor (0 to 1) |
| `ARCHYMEDES_CLOUD_TASK_KIND` | Providers | Cloud task kind (coding, design, architecture, security, research, deployment) |
| `GOOGLE_API_KEY` | Providers | Google Gemini API key |
| `GOOGLE_BASE_URL` | Providers | Google Gemini base URL |
| `GOOGLE_MODEL` | Providers | Google Gemini model |
| `XAI_API_KEY` | Providers | xAI (Grok) API key |
| `XAI_BASE_URL` | Providers | xAI base URL |
| `XAI_MODEL` | Providers | xAI (Grok) model |
| `DEEPSEEK_API_KEY` | Providers | DeepSeek API key |
| `DEEPSEEK_BASE_URL` | Providers | DeepSeek base URL |
| `DEEPSEEK_MODEL` | Providers | DeepSeek model |
| `MISTRAL_API_KEY` | Providers | Mistral API key |
| `MISTRAL_BASE_URL` | Providers | Mistral base URL |
| `MISTRAL_MODEL` | Providers | Mistral model |
| `GROQ_API_KEY` | Providers | Groq API key |
| `GROQ_BASE_URL` | Providers | Groq base URL |
| `GROQ_MODEL` | Providers | Groq model |
| `OPENAI_COMPATIBLE_API_KEY` | Providers | OpenAI-compatible API key |
| `OPENAI_COMPATIBLE_BASE_URL` | Providers | OpenAI-compatible base URL |
| `OPENAI_COMPATIBLE_MODEL` | Providers | OpenAI-compatible model |
| `OLLAMA_BASE_URL` | Providers | Ollama base URL (default http://localhost:11434/v1) |
| `OLLAMA_MODEL` | Providers | Ollama model |
| `OPENROUTER_API_KEY` | Providers | OpenRouter API key (direct + free mode) |
| `OPENROUTER_MODEL` | Providers | OpenRouter model (default openrouter/auto; any publisher/model id) |
| `OPENROUTER_BASE_URL` | Providers | OpenRouter base URL |
| `OPENROUTER_HTTP_REFERER` | Providers | OpenRouter app URL for rankings (optional) |
| `OPENROUTER_APP_TITLE` | Providers | OpenRouter app title for rankings (optional) |
| `TYPESAFE_API_KEY` | Providers | TypeSafe API key for Jev verdicts (optional) |
| `TYPESAFE_MODEL` | Providers | Jev model (default jev-latest) |
| `E2B_API_KEY` | Tools & voice | E2B API key |
| `E2B_CODING_TEMPLATE` | Tools & voice | E2B template |
| `EXA_API_KEY` | Tools & voice | Exa search API key |
| `EXA_BASE_URL` | Tools & voice | Exa base URL |
| `ARCHYMEDES_WEB_SEARCH` | Tools & voice | Web search without Exa |
| `BRAVE_SEARCH_API_KEY` | Tools & voice | Brave Search API key |
| `TAVILY_API_KEY` | Tools & voice | Tavily API key |
| `SEARXNG_URL` | Tools & voice | SearXNG instance URL (JSON output enabled) |
| `VOICE_TRANSCRIPTION_URL` | Tools & voice | Speech-to-text URL |
| `VOICE_MODEL` | Tools & voice | Speech-to-text model |
| `VOICE_INPUT_DEVICE` | Tools & voice | Microphone device override |
| `MODEL_INPUT_PER_MILLION` | Price overrides | Input price per million tokens |
| `MODEL_OUTPUT_PER_MILLION` | Price overrides | Output price per million tokens |
| `MODEL_CACHED_INPUT_PER_MILLION` | Price overrides | Cached input price per million tokens |
| `MODEL_PRICE_CURRENCY` | Price overrides | Model price currency |
| `MODEL_PRICE_MODEL` | Price overrides | Model the price override applies to |

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
| `ARCHYMEDES_PACKAGE_MANAGER`, `ARCHYMEDES_UPDATE_REGISTRY` | Go engine | [Behaviour](#behaviour) |
| `OPENROUTER_BASE_URL` | Go engine (free mode) | [Providers and keys](#providers-and-keys) |
| `ARCHYMEDES_FREE_GATEWAY_URL` | TypeScript engine; the binary reads it to choose the engine | [Providers and keys](#providers-and-keys) |
| `ARCHYMEDES_ACP_TRACE`, `ARCHYMEDES_DEBUG_LOG`, `ARCHYMEDES_AGENT` | the `friday` binary | [Diagnostics](#diagnostics) |
| `ARCHYMEDES_THEME`, `ARCHYMEDES_LANGUAGE`, `ARCHYMEDES_PHOTOS`, `ARCHYMEDES_WALLPAPER`, `ARCHYMEDES_REDUCE_MOTION` | the `friday` binary | [The interface](#the-interface) |

Key bindings are changed in the Keys app (F7) and saved to `keys.json` in the config directory.
