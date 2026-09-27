# Archymedes — landing page copy

Positioning source: `docs/RELEASE_ASSESSMENT.md`. Claims policy: BYOK/local only; no cloud, credits,
hosted free-gateway, or benchmark-vs-competitor claims. Provider count: **11** (CLI surface).

---

## Hero

### Headline
**The coding agent you can inspect.**

### Subheadline
Archymedes reads, edits, and runs commands in your workspace — and shows you everything: guarded
execution, recoverable edits, explicit cost, durable history. Your keys, your machine, your
terminal.

### CTA
- Primary: `npm install -g archymedes-cli` (copy button) → **Get started**
- Secondary: **See how it works** (anchors to demo section)

---

## Above the fold: the one-line pitch

> An open-source coding agent for your terminal, with an IDE-grade desktop client. Every edit is
> snapshotted, diffable, and one keystroke from undo. Every command needs your approval. Every
> token has a visible price.

---

## Feature blocks (order = differentiation first)

1. **Review before you trust.** The agent plans, edits, and verifies — and `/task` shows the whole
   picture: the request, the plan, every changed file with its line delta, every check that ran,
   and what still blocks completion. `/diff` for the unified diff, `/undo` to roll a file back.
   *Screenshot: the `/task` view.*
2. **Guarded execution.** Approval modes from "ask me always" to "just run it." Spawned commands
   are confined to the workspace. Failed checks are shown as failed — green only means verified.
3. **Costs you can see.** Live spend in your currency, priced from a dated per-model catalog with
   cached-token discounts. Models without pricing say so instead of guessing. `/balance` tracks the
   pacing limit you set — it is never mistaken for money spent elsewhere.
4. **Your providers, your keys.** Anthropic, OpenAI, Gemini, Grok, DeepSeek, Mistral, Groq,
   Ollama (local), any OpenAI-compatible endpoint, free OpenRouter models with your own key, and
   Archymedes Cloud for hosted runs. Keys stay in your machine's config — nothing is proxied.
5. **History that survives crashes.** Sessions are saved after every tool step, so a killed process
   resumes where it stopped — not where it started. Durable local history, rebuildable index.
6. **Desktop, when you want windows.** [Archymedes Desktop](desktop-link) — agent chat with
   tool cards, a real editor, PTY terminals, and one-click revert, in a sandboxed Electron shell.

---

## Demo section

- TUI GIF (90 frames or less): `bun run preview:workspace` produces the real interface offline.
- Desktop screenshots: agent turn with a tool card open, `/task` view, diff view.
- 60–90s video: install → paste key → first prompt → first edit → `/diff` → `/undo`.

---

## Quickstart (docs/quickstart.md publishes this)

```bash
npm install -g archymedes-cli
cd your-project
archymedes
```

1. Pick a provider and paste a key (stored locally; set `<PROVIDER>_MODEL` to choose a model).
2. Type a task — *"fix the failing test in src/parser.ts"*.
3. Review with `/task`, inspect with `/diff`, undo with `/undo`.
4. Prefer windows? Install [Archymedes Desktop](desktop-link) and open any folder as a workspace.

Requirements: Node 22+ (macOS, Linux, Windows).

---

## Social proof / footer

- npm install count badge, Apache-2.0 license, GitHub star CTA, Discord link.
- Honest-status line: *"Hosted services (Archymedes Cloud, hosted free gateway) are in private
  beta and not part of this release."*
- 16 languages: *"The interface speaks 16 languages — `archymedes --language <code>`."*

---

## Do-not-claim checklist (for anyone editing this page)

- [ ] No Archymedes Cloud pricing, credits, ledger, or availability claims.
- [ ] No "free with no key" claim — free mode needs your OpenRouter key or a self-hosted gateway.
- [ ] No cross-tool benchmark claims; journey numbers are stub-based regression signals only.
- [ ] No bundled 91/100 reliability score (it names a provider this build no longer ships).
- [ ] Provider count consistent: 11.
