# Friday from a phone (WS-30)

Design, 2026-10-19. Nothing here is built yet. Each milestone below is a TRACKER row, and each is
built and checked before the next one starts.

## What the person gets

They open `app.archymedes.xyz` on a phone, sign in with GitHub and pick a repository. Friday is
already working on it in a cloud sandbox: the same agent, modes, approvals and questions as on the
desktop, with live tool cards. When they close the phone, the sandbox pauses. When they come back an
hour or three weeks later, it resumes in about a second with the conversation, the files and any
running dev server as they were. The work reaches GitHub as a branch and a pull request.

## Decisions (the user's, 2026-10-19)

| Question | Answer | What follows |
| --- | --- | --- |
| Who pays | **Hosted**: Friday's E2B account and model keys | Keys never enter a sandbox; invite-only at first; per-user caps and a global ceiling before anyone else is let in |
| Sign-in | **GitHub App** | One sign-in is also the repo access. The person picks the repos; tokens are minted per use, scoped to one repo, and expire within an hour |
| Hosting | **archymedes.xyz on Cloudflare** | Workers + Durable Objects + D1, beside the install counter (`~/archymedes-site/workers/`) |
| First version | **Cloud sessions from the phone** | Chat, tool cards, approvals, questions, modes, pause/resume, branch + PR. Desktop pairing and unattended tasks come later |

## The shape

```
 phone (PWA)                Cloudflare (app.archymedes.xyz)                 E2B sandbox (one per session)
 ───────────                ───────────────────────────────                 ─────────────────────────────
  chat, cards,   wss   ┌──────────────────────────────┐   wss (dials out)  ┌───────────────────────────┐
  approvals  ◄───────► │ Session Durable Object       │ ◄────────────────── │ friday bridge             │
                       │  one per session: relays     │                    │  └─ friday acp (stdio)    │
  sign-in    https     │  ACP frames, buffers while   │                    │     the agent, unchanged  │
  ─────────────────►   │  the phone is away, owns     │                    │  git, rg, node, bun       │
                       │  pause/resume                │                    │  /workspace/<repo>        │
                       ├──────────────────────────────┤                    └─────────────┬─────────────┘
                       │ API Worker: GitHub App OAuth,│   E2B API (create,               │ model calls,
                       │ sessions, repos, D1          │   connect, pause, kill)          │ session token only
                       ├──────────────────────────────┤                                  ▼
                       │ Model proxy: the free        │ ◄────────────────────────────────┘
                       │ gateway's rules, paid models,│ ──► Anthropic / OpenRouter (keys live here)
                       │ spend per user               │
                       └──────────────────────────────┘
```

Three choices hold this up:

1. **Friday runs inside the sandbox, whole.** Today E2B is only a *workspace backend*: the agent runs
   on the person's machine and its tools run remotely (`E2BWorkspace` in `core/cli/backends.ts`).
   Here, `friday acp` itself is the process in the sandbox, with a local workspace at
   `/workspace/<repo>`. Pausing then keeps everything at once: the conversation in memory, the agent's
   state, a running dev server. Resuming continues the same process. Friday needs no new mode for this;
   it is a local session that happens to run on a machine in the cloud.
2. **The sandbox dials out.** A small `friday bridge` (a new subcommand) starts `friday acp` and
   connects *outbound* over WebSocket to that session's Durable Object, authenticated by a per-session
   secret. No port is opened to the internet. A WebSocket does not survive a pause, so after a resume
   the bridge reconnects and the Durable Object replays whatever it buffered.
3. **Secrets stay on Cloudflare.** The sandbox holds only a session token. Model calls go to the model
   proxy, which holds the provider keys and charges the user's budget. Git gets a GitHub installation
   token scoped to the one repo, minted for each fetch or push and passed to that one command, never
   written to `.git/config` or the environment.

## Pieces

### Session Durable Object (`workers/app/src/session.ts`)
- Holds two WebSockets, the phone's and the bridge's, and relays ACP JSON-RPC frames between them.
  It never interprets the agent's messages, apart from three things: noting a pending approval or
  question (so a phone that reconnects is shown it again), noting `runtime_stop` (the turn ended),
  and noting activity (for the idle timer).
- **Buffer:** frames from the bridge are kept in order (DO storage, capped) until the phone
  acknowledges them, so a phone that dropped mid-turn misses nothing.
- **Idle:** with no phone attached and no turn running for 10 minutes, it asks E2B to pause the
  sandbox. The sandbox is also created with `lifecycle: { onTimeout: 'pause' }` as a backstop.
  A turn running with the phone away keeps the sandbox up, within the per-user caps.
- **Resume:** a phone that attaches to a paused session causes the DO to call `Sandbox.connect(id)`
  (about 1 s) and wait for the bridge to dial back. A pause refused with 503 (`ServiceBusyError`) is
  retried after a short wait.

### API Worker (`workers/app/src/api.ts`)
- GitHub App user sign-in (OAuth web flow). An httpOnly, `SameSite=Lax`, signed session cookie
  lasts 30 days and slides on use, with a rotating server-side record in D1, so a lost phone can be
  signed out from anywhere.
- `GET /repos`: the repos the App is installed on that this user can reach.
- `POST /sessions {repo, branch?}`: checks caps, creates the sandbox from the Friday template with
  owner metadata, starts the bridge with the session secret, and clones over HTTPS with a fresh
  installation token passed to that one command. It also creates a working branch `friday/<slug>`.
- `GET /sessions`, `DELETE /sessions/:id` (kill the sandbox; the branch stays on GitHub).
- `POST /sessions/:id/push`, `POST /sessions/:id/pr`: the server mints the token and runs `git push`
  in the sandbox through the E2B command API, then opens the PR through the GitHub API. The model
  cannot push on its own; pushing is a button the person presses (or an approval in the chat).

### Model proxy (`workers/app/src/model.ts`)
The free gateway's rules (`packages/free-gateway`), moved to a Worker and extended to paid models:
the request body rebuilt from an allowlist, `max_tokens` clamped, streams guarded by first-byte and
idle deadlines, upstream errors scrubbed. Authenticated by the session token, which maps to a user,
and charged from the usage the provider reports to that user's daily and monthly spend. Friday in the
sandbox sees an ordinary provider: a base URL plus the session token as the key.

### Sandbox template (`workers/app/template/`)
An E2B template: Debian with git, ripgrep, Node 22, Bun and `@archymedes/friday` at the released
version. It is rebuilt on each Friday release, and the version is recorded on each session so an old
session keeps its own until it is restarted.

### The phone (`app/` route in archymedes-site, a PWA)
Mobile-first, one column. It shows the same transcript the Go interface draws (messages, tool cards
with the live "writing…" line from WS-29.3, diffs, approvals, questions, the mode pill), a composer,
and a session list with each session's state (running, paused, the age of its last activity). It
reads ACP plus Friday's `_archymedes/event` extension, so the rendering rules come from the Go
interface's `internal/render` and are re-implemented in TS against the same fixtures.

## D1 schema (first cut)

```sql
users     (id, github_id UNIQUE, login, created_at, allowed INTEGER NOT NULL DEFAULT 0, disabled_at)
logins    (id, user_id, token_hash, created_at, last_used_at, expires_at, user_agent)  -- one per signed-in device
sessions  (id, user_id, repo, branch, sandbox_id, state, friday_version, secret_hash,
           created_at, last_active_at, paused_at, ended_at)
spend     (user_id, day, model_micros, sandbox_seconds, PRIMARY KEY (user_id, day))
events    (id, session_id, at, kind, detail)  -- created/paused/resumed/pushed/killed; no message content
```

Message content is not stored on Cloudflare. It lives in the sandbox (Friday's own session file) and
in the DO's short replay buffer.

## Cost and abuse controls (needed before anyone but the owner signs in)

- **Invite-only:** `users.allowed` is set by hand (admin token, like the install counter's).
- **Per user, per day:** model spend $5 and sandbox time 4 h running. Paused time costs nothing
  but storage. Live sessions: at most 3.
- **Global:** a monthly ceiling across all users, and a kill switch (one D1 flag) that refuses new
  turns everywhere.
- **Sandboxes are reaped:** one paused for 30 days with no activity is snapshotted to its branch (a
  `friday/autosave` commit pushed) and killed, and the person is told. E2B keeps a paused sandbox
  indefinitely; without this, storage grows forever.

These numbers are placeholders to be set from E2B's and the providers' real prices before M5.

## Security model

| Threat | Answer |
| --- | --- |
| The agent (or code it runs) reads secrets | The sandbox holds no provider key and no lasting git token. The session token is useless outside the proxy and is revoked when the session ends |
| A git token leaks from a command | Installation tokens are scoped to one repo, expire within an hour, and are minted per command |
| One user reaches another's sandbox | The DO checks the login cookie against `sessions.user_id`; the bridge's secret is per session, stored hashed, and rotated on each resume |
| A stolen phone | The person can revoke each device from the session list; logins expire after 30 days unused |
| Cost runaway (a looping agent, abuse) | Per-user caps are checked in the proxy before each model call and in the DO for sandbox time; global ceiling; kill switch; invite-only |
| Prompt injection pushes code | Pushing and opening PRs are buttons or explicit approvals. The model has no git credential of its own |

## Milestones (each a TRACKER row; built and checked in order)

| | Milestone | Done when |
| --- | --- | --- |
| M0 | **Spikes**: (a) create/connect/pause from a Worker (the `e2b` SDK if it runs in Workers, else its REST API); (b) a template with Friday that runs `friday acp`; (c) the bridge dialling out, surviving a pause/resume by reconnecting | A script creates a sandbox, a turn runs through a DO, the sandbox pauses and resumes, and the next turn continues the conversation |
| M1 | Sign-in with the GitHub App, login records, invite flag, repo list | Sign in on a phone, see your repos, sign out a device |
| M2 | Sessions: create (clone + branch), list, resume, kill; the relay; a phone that shows text and tool cards read-only | Start a session from the phone, watch a turn, close the phone, reopen, see the same session |
| M3 | Full chat: composer, approvals, questions, modes, cancel, steering; replay after reconnect | Everything the Go interface's chat does, from the phone |
| M4 | Git: push the branch, open a PR, show the diff | A PR on GitHub from a phone session |
| M5 | Model proxy with spend; caps; kill switch; the admin view | A user over the cap is refused with a clear message; spend matches provider invoices within 1% |
| M6 | PWA: install to home screen, Web Push when a turn ends or needs approval | The phone buzzes when Friday needs an answer |

## Not decided yet (asked when the milestone needs it)

- Which models the hosted tier offers, and their caps (M5).
- Whether people beyond the invite list ever pay, and how (after M6).
- Desktop pairing (driving a Friday running on your own machine from the phone): a later
  workstream. The bridge in this design is the piece it would reuse.
