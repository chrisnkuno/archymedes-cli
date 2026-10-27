# What developers want from coding agents (October 2026)

Research for WS-52, done 2026-10-27. Three sources, read together:

| Source | Size | What it measures |
| --- | --- | --- |
| GitHub issues of ten agent repos (claude-code, codex, gemini-cli, opencode, crush, aider, cline, Roo-Code, continue, goose) | 3,664 issues; the 200 most-reacted per repo analysed (2,000 issues, 114,918 reactions, 88% from 2025 on) | Votes for a request |
| Developer forums | 4,435 documents from 245 queries: Hacker News comments (2,377), the Cursor, OpenAI, Google AI, JetBrains, Zed and Warp forums, GitHub Discussions, Stack Overflow, Lobsters, dev.to, Indie Hackers, Tildes, Substack, Medium, Bluesky | How often a theme is raised (a document counts once per theme) |
| Surveys | Stack Overflow 2025 and 2026, JetBrains 2025 and 2026, METR 2025 and 2026 | Trust, frustration, adoption |

Reddit and X could not be read (Exa returns nothing for them, Reddit refuses direct access), so the
forum side leans towards experienced, sceptical developers. Claude Code holds 47% of all GitHub
reactions; rankings were also checked with each repo weighted equally. Raw data, scripts and the
full findings (quotes with links) were kept outside the repository; the counts below are theirs.

## The wishes, ranked across sources

| # | Wish | GitHub reactions (issues) | Forum docs | Survey signal |
| --- | --- | --- | --- | --- |
| 1 | **See usage, limits and cost**: context %, plan limits and when they reset, tokens per task | 7,498 (84); top 10 in 7 of 10 repos | 952, the biggest complaint | cost a barrier for about half; organisations cap spend |
| 2 | **Choose the model**: bring your own key, local models, the subscription you already pay for | 7,466 (287); the one theme in 9 of 10 repos; largest when repos are weighted equally | 588 local models, plus lock-in | — |
| 3 | **A terminal that behaves**: no flicker, real scrollback, clean copy and paste, vim keys | 10,354 (122) | 414 | — |
| 4 | **Instructions it follows**: AGENTS.md everywhere (the most-reacted single issue, 6,688), nested, honoured | 8,258 (29) | 400 ("CLAUDE.md ignored") | 53.6% want AI memory controlled by them alone |
| 5 | **Editor and terminal together**: ACP, IDE diff and approval | 5,156 (80) | 991 | — |
| 6 | **Verify before trusting**: the agent checks its own work, review is easy, undo and rewind | diff 1,473, undo 1,105 | 781 testing, 605 review, undo in the top 20 | 66% "almost right"; 45% slower debugging; 48% trust only what is easy to verify |
| 7 | **Extend it**: skills, hooks, plugins, custom commands | 3,500 + 918 | 569 | — |
| 8 | **MCP without the context cost** | 4,329 (84) | 531, now often critical of token waste | — |
| 9 | **Context that does not lose the plot**: compaction, token efficiency | 3,269 (82) | 522 | — |
| 10 | **Parallel work**: sub-agents, background, worktrees | 1,722 + 409 | 511 | — |
| 11 | **Less babysitting**: notifications, approve from the phone, precise (not all-or-nothing) permissions | permissions 1,535 | 427 approval fatigue, 108 phone or remote, 98 notifications | 54% keep terminal actions for themselves |
| 12 | **Headless and CI**: scripts, SDK, background agents | 350 | 481 | — |
| 13 | **Reliability**: no loops, no stuck sessions, honest "done" | 3,011 (88) | 445, plus dishonesty (false done, cheating tests) | — |
| 14 | **Sessions**: resume, history, side questions (/btw), queue or steer | 3,389 + 1,497 | in the top 30 | — |
| 15 | **Smaller asks**: multi-account, images and PDFs, LSP, voice, Windows, XDG, i18n and IME, a quiet mode (or the pet back) | 4,940 accounts; LSP 955; Windows 1,105 | Windows under-served | — |

What developers say they do **not** want: planning their day around reset windows, an agent that
commits, pushes or merges on its own, narration and flattery, all-or-nothing permissions, MCP
servers sitting in context unused.

## Where Friday stands (Go engine, 2026-10-27)

| Wish | Friday today | Gap |
| --- | --- | --- |
| 1 Usage and limits | Token meter, rate-limit forecast, sub-agent tokens (WS-51.5), Claude and Codex `/cost` | No context % in the status line; no `/cost` on Friday's own models in Go; plan reset times not shown |
| 2 Model choice | Twelve providers, Ollama, free models, Claude and Codex on your own plan, live model lists | Codex still on the TypeScript engine (WS-50.8) |
| 3 Terminal | Go interface on Bubble Tea (no flicker), mouse, transcript cursor | No vim mode in the input |
| 4 Instructions | AGENTS.md and CLAUDE.md read | Check nested files; no `.agents/skills` |
| 5 Editor | ACP: Zed, JetBrains (docs/engine/EDITORS.md) | — |
| 6 Verify | Test-first verification gate, Changes app with diffs | No checkpoints or `/undo` in Go (WS-50.7) |
| 7 Extend | Custom commands, role files | No skills, no hooks in Go |
| 8 MCP | Deferred tools and `tool_search` built for it | No MCP client in Go (WS-50.7) |
| 9 Context | Compaction on the small model | Context % not visible |
| 10 Parallel | Background sub-agents, worktrees, `/subagents` | — |
| 11 Babysitting | Modes, command rules, auto asks only about risk | No notification when a turn ends or waits for you; nothing reaches a phone |
| 12 Headless | — | `friday "request"`, `--json` (WS-50.6) |
| 13 Reliability | Loop detector, retries that follow the provider, the gate | — |
| 14 Sessions | Resume, steering, queued prompts | No `/btw` |
| 15 Smaller | Windows binaries, XDG paths, 17 languages, simple mode | Images, LSP, accounts |

## Plan

WS-52 in [TRACKER.md](TRACKER.md), in this order (demand × gap × size), alongside the WS-50 ports:

1. Notifications: a desktop notification and the bell when a turn ends, an approval or a question waits, while the terminal is not focused; an optional push URL (ntfy-style) for the phone.
2. Context % and usage in the status line; `/cost` in Go for Friday's own models.
3. Skills: `SKILL.md` folders (`.agents/skills`, `.claude/skills`, the config directory), listed by name and loaded on demand.
4. MCP client in Go, its tools deferred so unused servers cost no context (WS-50.7).
5. Checkpoints, `/undo` and rewind in Go (WS-50.7).
6. Hooks in Go.
7. `/btw`, a vim mode for the input, images in prompts, multiple accounts, LSP diagnostics, headless mode (WS-50.6).
