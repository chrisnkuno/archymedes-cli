# Friday from a phone (WS-30)

Design, 2026-10-19; revised 2026-10-20 after reading E2B's, Cloudflare's, OpenRouter's and Stripe's
docs and running the spikes below. Each milestone is a TRACKER row, built and checked before the next.

**What changed on 2026-10-20:** people now pay for what they use, plus a margin (see Billing), and the
E2B SDK turned out not to run in Workers, which moved how the control plane drives sandboxes (see
Engineering findings). The shape below is otherwise as designed.

## What the person gets

They open `app.archymedes.xyz` on a phone, sign in with GitHub and pick a repository. Friday is
already working on it in a cloud sandbox: the same agent, modes, approvals and questions as on the
desktop, with live tool cards. When they close the phone, the sandbox pauses. When they come back an
hour or three weeks later, it resumes in about a second with the conversation, the files and any
running dev server as they were. The work reaches GitHub as a branch and a pull request.

## Decisions (the user's, 2026-10-19)

| Question | Answer | What follows |
| --- | --- | --- |
| Who pays | **The user, prepaid**: Friday fronts E2B and the model, bills usage plus a margin from a credit balance (2026-10-20, replacing "Friday absorbs it") | Keys never enter a sandbox; metering is the core of the system, not a cap; invite-only until billing is verified against real invoices |
| Sign-in | **GitHub App** | One sign-in is also the repo access. The person picks the repos; tokens are minted per use, scoped to one repo, and expire within an hour |
| Hosting | **archymedes.xyz on Cloudflare** | Workers + Durable Objects + D1, beside the install counter (`~/archymedes-site/workers/`) |
| First version | **Cloud sessions from the phone** | Chat, tool cards, approvals, questions, modes, pause/resume, branch + PR. Desktop pairing and unattended tasks come later |

## Engineering findings (2026-10-20: docs read, spikes run)

Each row is something the first design guessed or did not know, and what the docs or a live run said.

| Question | Finding | Decision |
| --- | --- | --- |
| Can a Worker run the `e2b` SDK? | **No.** E2B's troubleshooting page says the JS SDK does not run on Workers or Vercel Edge (its transport package). | The Worker uses **only E2B's REST API and one plain-HTTP envd call** (`fetch`); no SDK, no extra server. Spike M0b ran the whole lifecycle that way. |
| How does a Worker start the bridge without `commands.run` (a Connect-RPC call)? | The template's **start command runs at build time and is snapshotted**, so the process is already running in every sandbox created from it (verified: pid 364 before and after pause). envd takes files over plain HTTP: `POST https://49983-<id>.e2b.app/files?path=…&username=user` with `X-Access-Token` (the `envdAccessToken` that create returns, unchanged across resume). | The bridge is the template's start command; it **waits for `/etc/friday/session.json`**. The Worker writes that file (URL, secret) after create and again after each resume; the bridge (re)connects on every change. |
| Does a process survive pause? | **Yes**: a full memory snapshot; the same pid kept running (spike M0a, M0b). Pause 1.6–2.5 s on a small sandbox (E2B: about 4 s per GiB of RAM); resume 1.0–2.1 s. A paused sandbox is kept **indefinitely** with no TTL and is killed only by request. Running time resets on resume. Open connections drop, so clients reconnect. A pause can be refused with 503 `ServiceBusyError` (retry). | Bridge reconnects on its own; the DO retries a refused pause; the reaper (below) is ours to build, since E2B never deletes. |
| How is sandbox time metered? | E2B has **no billable-usage API**; metrics are CPU/memory samples. It does send **signed lifecycle webhooks** (`created`, `paused`, `resumed`, `killed`, with vCPU, memory, start time and runtime; `e2b-signature`, dedupe on `e2b-delivery-id`). | Bill from the webhooks (E2B's own clock), cross-checked against the DO's running intervals; a gap above 5% is an alert, not a silent charge. |
| What is E2B's price? | $0.000014 per vCPU-second + $0.0000045 per GiB-second; storage free. Hobby: 20 concurrent, **1 h** max run, $100 one-time credit. Pro: **$150/month** + usage, 100 concurrent, 24 h. | The template is **2 vCPU / 1 GiB**: $0.000032 per second, **$0.117 per running hour**. Production needs Pro (the Hobby cap and concurrency are fine for the spikes only). |
| How is a model call costed? | OpenRouter returns exact `usage.cost` in every response (in the last SSE chunk when streaming); no table to maintain. Not documented: what arrives if a stream is cancelled early. | The proxy bills `usage.cost`. A stream that ends without it is settled from `GET /generation?id=` (retried), and failing that from the reservation's token estimate: a cut stream is never free. |
| Where does the balance live? | D1 is not a safe place for per-call read-modify-write. A Durable Object is single-writer with transactional SQLite. | One **Account Durable Object per user** owns the balance and the ledger; D1 gets an append-only mirror for the admin view. |
| Does the DO stay cheap holding sockets? | Only the Hibernation API (`ctx.acceptWebSocket`) stops duration billing while idle; DO-initiated outbound sockets never hibernate. Incoming messages bill 20:1. Alarms and timers prevent hibernation. | The sandbox dials **in** (as designed); the DO keeps state in attachments and storage, never in memory; one alarm only, for the idle pause. |
| What fees sit under the price? | Stripe 2.9% + $0.30 per card payment (+0.5% with Stripe Tax); OpenRouter about 5.5% on credit purchases (third-party reports; verify). | Prepaid packs from $10 (the fixed $0.30 is 3% of $10, 30% of $1); see Billing. |

**To verify before real money moves** (not answerable from docs): OpenRouter's terms on serving end
users through one key (the alternative is Anthropic/OpenAI keys of our own, or per-user provisioned
keys); Stripe Tax registration for wherever the customers are; E2B's actual invoice against our metering.

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
- **Resume:** a phone that attaches to a paused session causes the DO to `POST /sandboxes/{id}/connect`
  (E2B's REST API; about 1 s), write a fresh `/etc/friday/session.json` (a new secret), and wait for the
  bridge to dial back. A pause refused with 503 (`ServiceBusyError`) is retried after a short wait.

### API Worker (`workers/app/src/api.ts`)
- GitHub App user sign-in (OAuth web flow). An httpOnly, `SameSite=Lax`, signed session cookie
  lasts 30 days and slides on use, with a rotating server-side record in D1, so a lost phone can be
  signed out from anywhere.
- `GET /repos`: the repos the App is installed on that this user can reach.
- `POST /sessions {repo?, branch?}`: checks the balance, creates the sandbox from the Friday template
  (REST, `secure: true`, owner metadata, `autoPause`, a short E2B timeout the DO keeps extending: if our
  server dies the sandbox still pauses itself), writes `/etc/friday/session.json` through envd, and
  tells the bridge (once it dials in) to clone over HTTPS with a fresh installation token passed to
  that one command, then to create the working branch `friday/<slug>`.
- `GET /sessions`, `DELETE /sessions/:id` (kill the sandbox; the branch stays on GitHub).
- `POST /sessions/:id/push`, `POST /sessions/:id/pr`: the server mints the token and tells the bridge
  to run `git push` with it (a control frame, not an E2B command), then opens the PR through the GitHub API. The model
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

## Accounts, keys and where a session's model comes from (2026-10-20)

Scope: hosted credits, free models, and the person's own API keys. Claude and Codex subscriptions
are out (not a sanctioned thing to resell or relay).

- **Vault.** Keys live in the Account DO, AES-256-GCM, a key derived per user and slot (HKDF), the
  user and slot bound as AAD, `VAULT_KEYS` rotatable. Slots: openrouter, anthropic, openai, google,
  xai, deepseek, mistral, groq. A browser can write a key and never read one back (only the last four
  characters are shown).
- **Login scopes.** A browser login holds `vault:write`. A desktop login (`friday login`) holds
  `vault:read` only if the person ticks "let this computer download my keys" when approving it.
- **Device link.** The CLI generates an RSA-OAEP key pair and sends only the public key. The person
  approves the code (`BCDF-GHJK`, or `<app>/#link=CODE`) in the browser. The server seals the login
  token to that public key; it is delivered once; the poll secret is stored only as a hash.
  `friday keys push|pull|list|remove`, `friday account`, `friday logout` use it.
- **Session source:** `hosted` (Friday's models, billed ×1.30 from the balance), `free` (free models
  on the person's own OpenRouter key, through Friday's own free mode in gateway form:
  `ARCHYMEDES_FREE_GATEWAY_URL=<origin>/api/model/free`, free ids only, zero-price routing, a public
  filtered `GET /v1/models`), or a provider name (a pass-through proxy at `/api/model/<source>/…`).
  The sandbox never holds a provider key, only a session token.
- **Billing by source.** Sandbox time is always charged (×1.50 on about $0.117/h raw). Model usage is
  charged only for `hosted`. Minimum to start: $1.00 hosted, $0.25 otherwise.
- **Errors.** `needs_key` (400, with the slot) when the chosen source has no key; `credit` (402) with
  the minimum that applies.

## Billing

**Prepaid credits.** A user buys a pack (Stripe Checkout, one payment, $10 minimum) and every charge
draws it down; nothing is ever billed after the fact, so there is no dunning, no surprise invoice, and
a chargeback can only reach what was bought. Amounts are integer **micro-dollars** (1 000 000 = $1)
everywhere, so no rounding drifts.

**Price = provider cost × multiplier**, set in one table so it can change without a deploy:

| What | Provider cost | Multiplier | Why |
| --- | --- | --- | --- |
| Model tokens | OpenRouter's `usage.cost` | **1.30** | Covers OpenRouter's ~5.5% credit fee, Stripe's ~6% on a $10 pack, and leaves ~15% before fixed costs |
| Sandbox running time | (vCPU × 0.000014 + GiB × 0.0000045) × seconds | **1.50** | Running only; a paused sandbox is free to the user. A typical 10-minute turn is ~$0.10 |
| Storage of paused sandboxes | free at E2B | none yet | Revisit if paused sessions pile up |

Fixed costs to cover each month: E2B Pro $150, Cloudflare Workers paid $5. At 1.30 / 1.50 that is
roughly $450 of customer usage to break even; the admin view shows this, not a guess.

**The flow of one charge.** Before a model call the proxy asks the user's Account DO to **hold** the
worst case (`max_tokens` at the model's output price); after the call it **settles** the held amount
to the reported cost × 1.30 and releases the rest. A call is refused with `402` when the balance
cannot cover the hold, so the balance never goes negative from model use. Sandbox time is charged on
each `paused`/`killed` webhook (and by a periodic tick for a long-running one); when a balance reaches
zero the DO pauses the session, and the person sees "out of credit" with a link to top up, never a
silent stop. Every movement is one ledger row (`topup`, `hold`, `settle`, `release`, `sandbox`,
`refund`, `adjust`) with the id of what caused it, so any balance can be rebuilt and any charge explained.

## Wire contract

One contract, shared by the Worker (`~/archymedes-site/workers/app/src/protocol.ts`), the bridge
(`packages/friday-cli/src/bridge/`) and the phone client (`workers/app/web/`). All amounts are integer
micro-dollars; all times are epoch milliseconds; every body is JSON.

### HTTP (`https://app.archymedes.xyz/api/…`, cookie `friday_session`, httpOnly, SameSite=Lax)

| Request | Answer |
| --- | --- |
| `POST /login {invite}` | `204` and the cookie; `401 {error:"invite"}` for an unknown, used or expired invite |
| `POST /logout` | `204`; the cookie is cleared and this login revoked |
| `GET /me` | `{user:{id,login}, balanceMicros, devices:[{id,userAgent,lastUsedAt,current}]}`; `401` when signed out |
| `DELETE /devices/:id` | `204`; signs that device out |
| `GET /sessions` | `{sessions:[{id,title,repo,state,createdAt,lastActiveAt,costMicros}]}`; state is `starting`, `running`, `pausing`, `paused`, `resuming`, `ended` or `failed` |
| `POST /sessions {repo?, title?}` | `201 {session}`; `402 {error:"credit", balanceMicros, minimumMicros}` when the balance cannot start one |
| `DELETE /sessions/:id` | `204`; the sandbox is killed and billed to the second |
| `GET /sessions/:id/ws?after=<seq>` | WebSocket upgrade (below); `404` for another user's session |
| `POST /billing/checkout {packMicros}` | `{url}`: Stripe Checkout; `packMicros` is one of `10000000`, `25000000`, `50000000`, `100000000` |
| `GET /billing/ledger?before=<id>&limit=50` | `{rows:[{id,at,kind,micros,balanceAfter,ref,detail}]}` newest first |
| `POST /stripe/webhook`, `POST /e2b/webhook` | server to server; signed |
| `POST /admin/invites {login, creditMicros?}` (bearer `ADMIN_TOKEN`) | `{url}`: a one-use sign-in link, optionally with free starting credit |

Errors are `{error:"<code>", message:"<words for a person>"}`.

### WebSocket frames, phone ⇄ Session DO

Server to phone:

```
{t:"hello", session:{id,title,repo,state,acpSessionId,mode,model}, seq, balanceMicros}
{t:"frame", seq, frame, from?:"phone"}   // one JSON-RPC message, verbatim (below); from:"phone" marks one a phone sent, echoed into the stream
{t:"state", state, reason?}        // starting, running, pausing, paused, resuming, ended, failed
{t:"balance", balanceMicros}       // after every charge
{t:"notice", level:"info"|"warn", text}
{t:"error", code, message}
```

Phone to server:

```
{t:"ack", seq}                     // everything up to seq is rendered; the server may drop it
{t:"send", frame}                  // one JSON-RPC message for the agent (a request, or the answer to one)
{t:"wake"}                         // resume a paused session now
{t:"ping"}                         // keepalive; answered with {t:"pong"}
```

`frame` is exactly what `friday acp` writes or reads, so the phone renders the same events as the Go
interface: `session/update` (`agent_message_chunk`, `tool_call`, `tool_call_update`), the extension
notifications `_archymedes/event` (`tool_compose`, `model_turn`, `test_first`, `subagent`, …), and the
agent's requests `session/request_permission` and `_archymedes/session/ask`, which the phone answers
with a `{jsonrpc:"2.0", id, result}` of the same `id`. The phone sends `session/prompt`,
`session/cancel`, `session/set_mode`, `_archymedes/session/steer`, `_archymedes/session/set_model` and
`_archymedes/session/command`. The `initialize` and `session/new` handshake is the bridge's, never the
phone's; `hello.session.acpSessionId` is the id to put in `sessionId`. Request ids the phone makes are
strings starting with `p`; the bridge's own start with `b`. What a phone sends with `{t:"send"}` is also written into the stream (with `from:"phone"`) and broadcast
to every attached phone, so a reloaded or second device sees the person's own prompts and which
approvals were already answered, not only the agent's side. Frames the server keeps for replay carry
`seq`, strictly increasing per session and surviving a Durable Object restart; a phone that reconnects
with `?after=<last seq it rendered>` receives everything after it, in order, then live frames. Message
content is not stored beyond this buffer (2 000 frames or 4 MB, oldest dropped first, and a `notice`
says so when a phone missed some).

### Bridge ⇄ Session DO (`wss://app.archymedes.xyz/api/bridge/<sessionId>`, `Authorization: Bearer <secret>`)

```
bridge → DO   {t:"hello", version, acpSessionId, mode, model}
              {t:"frame", frame}                    // the agent's stdout, one JSON-RPC message
              {t:"result", id, ok, detail?}         // the answer to a control frame
              {"t":"ping"}                           // every 20 s; the DO answers {"t":"pong"} without waking, and a missed pong makes the bridge redial
DO → bridge   {t:"frame", frame}                    // the phone's, verbatim
              {t:"control", id, op:"clone"|"branch"|"push"|"status", args}   // git and housekeeping, with a token in args when needed
              {t:"bye", reason}                     // the session ended; stop
```

The secret is in `/etc/friday/session.json` (`{url, secret, sessionId, cwd, env}`), written by the Worker
through envd, replaced on each resume, and stored only as a hash on the server.

## D1 schema (first cut)

```sql
users     (id, github_id UNIQUE, login, created_at, allowed INTEGER NOT NULL DEFAULT 0, disabled_at)
logins    (id, user_id, token_hash, created_at, last_used_at, expires_at, user_agent)  -- one per signed-in device
sessions  (id, user_id, repo, branch, sandbox_id, state, friday_version, secret_hash,
           created_at, last_active_at, paused_at, ended_at)
ledger    (id, user_id, at, kind, micros, balance_after, ref, detail)   -- append-only mirror of each Account DO
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
| M0 | **Spikes** (a) create / run / pause / resume with the SDK: **done 2026-10-20**; (b) the same with REST + envd only, from a template whose start command waits for a config file: **done**; (c) the real bridge in the real template dialling a Durable Object, through a pause and resume | A turn runs through a DO, the sandbox pauses and resumes, the next turn continues the conversation |
| M1 | **Accounts and billing core**: the Account DO ledger (hold, settle, release, sandbox charges), pricing, Stripe Checkout + webhook, invite sign-in, the admin view; GitHub sign-in when the App's credentials exist | A top-up credits the balance once (replayed webhooks do nothing); a hold over the balance is refused; the ledger rebuilds the balance |
| M2 | **Sessions**: create, list, resume, kill; the Session DO relay with replay; E2B webhooks into the ledger; idle pause; the reaper | Start a session from a phone, watch a turn, close the phone, reopen it, see the same session; the bill matches E2B's webhook runtimes |
| M3 | **Model proxy** on the session token: hold, stream, settle on `usage.cost`; the cut-stream fallback | A user over balance is refused with a clear message; spend matches OpenRouter's own activity within 1% |
| M4 | **The phone**: transcript, tool cards, composer, approvals, questions, modes, cancel, balance and top-up | Everything the Go interface's chat does, from the phone |
| M5 | Git: clone, branch, push, PR (needs the GitHub App) | A PR on GitHub from a phone session |
| M6 | PWA install and Web Push; hardening: the global ceiling, the kill switch, rate limits | The phone buzzes when Friday needs an answer |

## Not decided yet (asked when the milestone needs it)

- Which models the hosted tier offers (M3), and the per-user daily cap that stops a runaway loop (a safety limit, separate from the balance).
- When the invite list opens: after the metering is checked against real E2B and OpenRouter invoices.
- Desktop pairing (driving a Friday running on your own machine from the phone): a later
  workstream. The bridge in this design is the piece it would reuse.
