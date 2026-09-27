# Archymedes launch announcement — drafts

Claims policy: same as `landing-copy.md`. BYOK/local only; no cloud, credits, hosted-gateway,
or benchmark-vs-competitor claims. Numbers you may cite: 11 providers, 16 languages, 180 test
files / 2,906 tests at last validated release, Node 22+, Apache-2.0.

---

## Show HN (and general launch post)

**Title:** Show HN: Archymedes – an open-source coding agent that shows its work

**Body:**

We built Archymedes because using a coding agent felt like hiring someone who works behind a
closed door. You get the result, and if something went wrong you find out by reading the code.

Archymedes is a coding agent for your terminal (with an IDE-style desktop client) built around
being *inspectable*:

- **Guarded execution.** Approval modes from "ask me always" to "just run it." Spawned commands
  are confined to the workspace. Failed checks render as failed — a green card only means
  something actually passed.
- **Recoverable edits.** Every file the agent touches is snapshotted first. `/diff` shows the
  unified diff, `/undo` rolls the file back, and the desktop client reverts with one click.
- **Explicit cost.** Live spend in your currency, priced from a dated per-model catalog with
  cached-token discounts. Models without pricing say so instead of guessing.
- **Durable history.** Sessions are saved after every completed tool step, so a killed process
  resumes where it stopped — not where it started.
- **Your providers, your keys.** Anthropic, OpenAI, Gemini, Grok, DeepSeek, Mistral, Groq,
  Ollama (local), any OpenAI-compatible endpoint, and free OpenRouter models with your own key.
  Keys stay on your machine; nothing is proxied.

One view we're proud of: `/task` assembles the whole state of a turn — the request, the agent's
plan, every changed file with its line delta, every verification outcome, and what still blocks
completion. Each row names the command that acts on it.

The CLI is validated by 2,906 tests including PTY-level journeys driven through a real terminal,
and the interface is localized into 16 languages.

Try it:

```bash
npm install -g archymedes-cli
cd your-project
archymedes
```

- Landing page: https://soniaineza.github.io/Archymedes-desktop/
- Source (Apache-2.0): https://github.com/chrisnkuno/archymedes-cli
- Desktop client (Windows installer): https://github.com/soniaineza/Archymedes-desktop/releases

Honest status: the local BYOK product is the release. Hosted services (Archymedes Cloud, a
hosted free gateway) are in private beta and are not part of this launch. Free mode needs your
own OpenRouter key or a self-hosted gateway.

Happy to answer questions about the architecture (provider-neutral runtime, Rust local index,
protocol package) or the security model.

---

## X / Twitter (short)

> Launch: Archymedes, an open-source coding agent that shows its work.
>
> - every command approved (or not — your call)
> - every edit snapshotted, /diff + /undo
> - every token priced, live in your currency
> - sessions survive crashes
> - your keys, your machine, 11 providers
>
> npm install -g archymedes-cli
> <link>

---

## Reddit (r/programming / r/commandline tone)

> I built an open-source terminal coding agent where you can actually see what it's doing.
>
> The pitch: every command needs your approval (configurable), every edit is snapshotted with
> one-keystroke undo, cost is tracked live in your currency, and sessions survive crashes — the
> transcript is saved after every tool step, not every turn.
>
> It's BYOK across 11 providers (including local Ollama), keys never leave your machine, and
> there's an Electron desktop client if you prefer windows over a TUI. Apache-2.0, Node 22+,
> works on macOS/Linux/Windows.
>
> Install: `npm install -g archymedes-cli` — link in comments.

---

## Files to attach when publishing

- Landing page URL + OG card (`docs/og.png`)
- TUI GIF (to record: `bun run preview:workspace`, capture 30–60s)
- Desktop screenshot: agent turn with tool card + diff view
