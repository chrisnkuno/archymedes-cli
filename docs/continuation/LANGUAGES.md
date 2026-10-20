# Friday in other languages (WS-31)

Design, 2026-10-19. First languages: Japanese (`ja`), Korean (`ko`), Simplified Chinese (`zh`),
Spanish (`es`). Then Traditional Chinese, Portuguese, French and German.

## Where things stand

- **The Go interface draws everything** and has no catalog: about 320 English strings sit in
  `internal/tui` literals (`core_`, `chat_`, `home_`, `desk_`, `app_`, `dialog_`, `cmd_`).
- **The setting exists:** `ARCHYMEDES_LANGUAGE` (Settings → "Control language", 16 choices,
  validated in `platform/settings.ts`), but only the TypeScript side reads it.
- **TypeScript has a 16-language table** (`platform/i18n.ts`: a few labels and slash-command
  descriptions). It is left over from the TS interface. The CLI's `--help` and menus still use it.
- **Width is mostly handled:** the Go interface measures with `ansi.StringWidth` (37 places), which
  counts CJK characters as two columns; two `len()` calls in layout code need checking.
- **The site** already routes by `[lang]`.

## Decisions

| | Decision | Why |
| --- | --- | --- |
| What is translated | Everything the interface draws: titles, labels, hints, notices, dialogs, the tour captions, the welcome, slash-command descriptions, setting labels; and the agent's own fixed messages that reach the screen (approval summaries, stop reasons, setup errors) | That is what a person reads |
| What is not | Slash-command names (`/model`), tool names, keys, file paths, protocol fields, logs, and model output | They are typed, matched or searched; translating them breaks muscle memory and docs |
| The agent's replies | In the language the person writes in, unless `ARCHYMEDES_LANGUAGE` says otherwise: one line in the system prompt | Models already do this well; forcing it would fight a person who writes English in a Japanese UI |
| One catalog, both stacks | JSON per language in `internal/i18n/locales/<lang>.json`, embedded in Go (`embed`) and imported by TS | One source; the Go side owns the bulk, TS reads the same keys for its messages |
| Keys | Dotted, by section: `chat.approval.allow`, `app.changes.empty`. English (`en.json`) is the source of truth | Sorted keys keep diffs reviewable |
| Placeholders and plurals | `{name}` placeholders; plurals as `key.one` / `key.other`, chosen by CLDR rules (ja, ko, zh: `other` only; es: `one`/`other`) | Enough for these languages without an ICU dependency |
| Choosing the language | `ARCHYMEDES_LANGUAGE`, else `LC_ALL` / `LC_MESSAGES` / `LANG`, else the Windows user locale, else English. Changing it in Settings redraws at once | Same order as other CLIs; no restart |
| Missing text | Falls back to English, key by key; never shows a raw key | A half-translated screen beats a broken one |

## How the catalog stays right (guards, run by `bun run recheck`)

- Every key in `en.json` is used, and every `t("…")` key exists in `en.json`.
- Every other locale has no keys that `en.json` lacks, and its placeholders match English's
  exactly. Coverage per locale is reported (not failed) until a language is declared complete.
- A suite renders every app and dialog in `ja` at 80×24 and 120×40 and checks that nothing overflows
  its box or splits a wide character (the existing design suite, run once per locale).
- No new user-visible English literal in `internal/tui`: a guard counts literals outside `t()` and
  the count may only fall, like the theme-leak guard.

## Translation

English stays the source. Drafts for ja, ko, zh and es are written by model, then reviewed by a
person who reads the language. The review is tracked per locale in TRACKER, and a locale is marked
complete only after it. Terms are kept in a glossary (`internal/i18n/glossary.md`) so "approval",
"checkpoint", "sandbox" and "mode" read the same way everywhere.

## Steps (each a TRACKER row)

| | Step | Done when |
| --- | --- | --- |
| L1 | `internal/i18n`: loader, `T(key, args)`, plural rules, fallback, language from setting/env; the Go interface reads `ARCHYMEDES_LANGUAGE` | Unit tests; switching in Settings redraws |
| L2 | Extract strings section by section (`core_`, `chat_`, `home_`, `desk_`, `app_`, `dialog_`, `cmd_`), one commit each; the literal guard's count falls with each | Guard at 0 for the section; screens identical in English (golden frames) |
| L3 | TS messages that reach the screen read the same catalog; `platform/i18n.ts`'s table folded into it | One catalog |
| L4 | ja, ko, zh, es drafts + glossary; the per-locale render suite | All four at 100% coverage, render suite green |
| L5 | The system prompt line for reply language; the site in the four languages | A Japanese prompt gets a Japanese answer; site pages exist |
| L6 | Review by speakers; then zh-Hant, pt, fr, de | Marked complete in TRACKER |
