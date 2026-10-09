# Free gateway operations runbook

What an operator needs to run `@archymedes/free-gateway` in production, in the order they need it.
The package README covers the client contract and configuration reference; this covers operating it.

**Status: not deployed.** `FREE_GATEWAY_URL` is `""` in `packages/core/src/providers/free-catalog.ts`
and in the desktop app's `src/main/agent/free-adapter.ts`, so shipped builds have no gateway and
`--free` requires the user's own `OPENROUTER_API_KEY`. Everything below has been verified locally;
nothing in it has been run against a deployed instance. Deploying requires an OpenRouter account and
an explicit decision by the project owner — see [Capacity](#capacity-what-you-are-actually-promising)
before committing to it.

## 1. Required secrets and environment

Set in the host's secret store, never in a file in this repository.

| Variable | Required | Notes |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | yes | The shared account key. The only copy; clients never receive it. |
| `GATEWAY_TOKEN_SECRET` | strongly recommended | HMAC secret for install tokens, ≥ 32 characters (`openssl rand -hex 32`), identical on every instance. Unset disables `/v1/install` and every client falls back to the tighter per-address limits. |
| `FREE_GATEWAY_SALT` | yes | Salts the hashes IP addresses are counted under. Unset means a random value per process, so per-address counts reset on every restart. |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | only for >1 instance | Shared counters. Without them every instance counts separately and the global ceiling is multiplied by the instance count. |
| `FREE_GATEWAY_INSTANCES` | if >1 | The process refuses to start above 1 without Upstash. Verified locally. |

The process validates these at startup and exits non-zero rather than starting misconfigured.
Verified 2026-10-09 on Windows/Bun 1.3.14 — all three refusals fire:

```
$ OPENROUTER_API_KEY= bun packages/free-gateway/src/server.ts
free-gateway: OPENROUTER_API_KEY is required.                                    # exit 1
$ OPENROUTER_API_KEY=… FREE_GATEWAY_INSTANCES=2 bun …/server.ts
free-gateway: several instances need UPSTASH_REDIS_REST_URL and …                # exit 1
$ OPENROUTER_API_KEY=… GATEWAY_TOKEN_SECRET=short bun …/server.ts
free-gateway: GATEWAY_TOKEN_SECRET must be at least 32 characters …              # exit 1
```

## 2. Build and deploy

Run from the repository root — the image builds `packages/core` into the gateway.

```sh
docker build -f packages/free-gateway/Dockerfile -t archymedes-free-gateway .
```

Fly.io and Render recipes are in the package README. Both default to **one always-on instance with
in-memory counters**, which is correct for one instance and wrong for any autoscaled or serverless
host — there, add Upstash first.

Whichever host: disable response buffering for `text/event-stream` (the gateway sends
`X-Accel-Buffering: no` for nginx) and allow idle connections of at least `FREE_GATEWAY_IDLE_TIMEOUT_MS`
(default 90 s), or streamed turns will be cut mid-answer.

## 3. Health verification

```sh
curl https://<host>/health                 # {"ok":true}  — use as the platform health check
curl -X POST https://<host>/v1/install     # a token, install_id, issued_at, header
curl https://<host>/v1/models | head -c 200   # the filtered zero-price listing
```

Then point a client at it before announcing it:

```sh
ARCHYMEDES_FREE_GATEWAY_URL=https://<host> archymedes --doctor      # the free row must name <host>
ARCHYMEDES_FREE_GATEWAY_URL=https://<host> archymedes --free --json "read README.md"
```

`--doctor` naming the gateway rather than `openrouter.ai` is the check that the client is really
routing through it. A successful `--free` turn is the only thing that proves the whole path; it
cannot be verified without a funded key, so treat it as the launch gate, not a formality.

## 4. Client address configuration — do this before launch

Per-address limits are the only thing standing between one abusive client and the shared allowance,
and by default the gateway trusts nothing and uses the socket address. Behind a proxy, opt into
exactly one source the proxy controls:

- Fly.io: `FREE_GATEWAY_CLIENT_IP_HEADER=fly-client-ip`
- Render / nginx / most load balancers: `FREE_GATEWAY_TRUST_PROXY=true`, with
  `FREE_GATEWAY_PROXY_HOPS` = the number of trusted proxies (read from the right)
- Cloudflare in front of your origin: `FREE_GATEWAY_CLIENT_IP_HEADER=cf-connecting-ip`

Verify once, then turn the probe off:

```sh
# with FREE_GATEWAY_DEBUG_IP=true
curl https://<host>/debug/ip                                        # must print YOUR public IP
curl -H "X-Forwarded-For: 6.6.6.6" https://<host>/debug/ip          # must STILL print your IP
```

If the second prints `6.6.6.6`, the configuration trusts a client-supplied value and per-address
limiting is defeated. Fix it before launch, then unset `FREE_GATEWAY_DEBUG_IP`.

## 5. Budgets and rate limits

Tokens are the budget that binds; request caps only stop runaways. Defaults, per day unless noted:

| Scope | Tokens | Requests | Burst |
| --- | --- | --- | --- |
| Per install token | 100,000 | 300 | 20/min |
| Per address (no token) | 100,000 | 300 | 20/min |
| Per address (across installs) | 2,000,000 | 3,000 | 120/min |
| Whole gateway | — | 1,000 | 20/min |
| Token issuance | — | 5/address, 5,000 global | — |

Set the **global** figures from the upstream account's real limits, not from these defaults. They
assume a funded account; an unfunded one is far lower (OpenRouter's free tier is roughly 50 requests
a day until credits are purchased, then about 1,000).

Counters fail closed: if the store is unreachable the gateway refuses requests rather than sending
them unmetered. A request refused before upstream execution is refunded from every counter it was
charged against; usage the upstream actually reported is never refunded, including when the client
disconnects mid-stream.

## 6. Secret rotation

- **`OPENROUTER_API_KEY`** — set the new value, restart, revoke the old one. No client state
  depends on it.
- **`GATEWAY_TOKEN_SECRET`** — rotating invalidates every issued token at once. Clients see
  `x-archymedes-install-status: invalid`, discard their token and call `/v1/install` again, which is
  automatic but is subject to the issuance limit (5 per address per day). Rotate during a quiet
  period, and consider raising `FREE_GATEWAY_INSTALLS_PER_IP_PER_DAY` temporarily.
- **`FREE_GATEWAY_SALT`** — rotating resets every per-address count, briefly granting everyone a
  fresh allowance. Rotate only if the salt is believed exposed.

## 7. Monitoring and abuse response

Watch, in order of how much damage they do:

1. **Upstream 401/402** — the shared key is invalid or out of credit. Every client sees "Free
   capacity is unavailable"; nothing recovers without operator action.
2. **Global daily/minute limit hit early in the day** — capacity exhausted by a few clients, or the
   global figures are set above what the account supports.
3. **Install issuance at its ceiling** — a client cycling tokens to escape per-install limits.
4. **Sustained upstream timeouts** — a model or OpenRouter degradation; clients fail over, so this
   shows as latency before it shows as errors.

Responses: lower the per-install and per-address limits first (they take effect on restart and do
not invalidate tokens); lower the global figures to protect the account; rotate
`GATEWAY_TOKEN_SECRET` to invalidate a population of abusive tokens, accepting that it resets
everyone; as a last resort unset `OPENROUTER_API_KEY` and let the service refuse to start.

The gateway stores no raw IP addresses and no prompt content — only salted hashes and counters — so
there is nothing to purge after an incident and nothing to subpoena.

## 8. Rollback

The gateway is stateless apart from its counters. Roll back by deploying the previous image; in-memory
counters reset (clients briefly get a fresh allowance), Upstash counters survive. There is no schema
and no migration.

## 9. Outage behavior

An unreachable gateway is not silent and never falls back to a paid provider. Clients report
"Could not reach the free gateway. Check connectivity and retry, or set your own OPENROUTER_API_KEY"
and the turn fails. Errors the gateway produces itself carry `x-free-gateway-error`, which tells the
client router not to try other models against the same limit.

If an outage will be long, the honest move is to tell users to set their own `OPENROUTER_API_KEY`
(`/upgrade` in the CLI does exactly this) rather than leaving them retrying.

## 10. Launch and shutdown

**Before launch**, all of these must be true — none is optional:

- [ ] `/health`, `/v1/install` and `/v1/models` answer over HTTPS
- [ ] `/debug/ip` verified, then disabled
- [ ] A real `archymedes --free` turn completes through the gateway
- [ ] Global limits set from the upstream account's actual limits
- [ ] Alerting on upstream 401/402 and on the global daily limit
- [ ] `FREE_GATEWAY_URL` set in **both** clients (core `free-catalog.ts` and desktop
      `free-adapter.ts`) and released — until then users must set `ARCHYMEDES_FREE_GATEWAY_URL`
      themselves

**Shutdown** is the reverse and should be announced: ship client builds with `FREE_GATEWAY_URL`
emptied first, so new installs stop depending on it, then drain and stop. Clients still pointing at
a dead gateway get the outage message above, which already names the way out.
