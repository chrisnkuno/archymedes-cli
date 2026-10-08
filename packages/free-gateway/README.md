# @archymedes/free-gateway

The hosted side of `archymedes --free`. It holds one OpenRouter key on the server so users can run
free mode without a key of their own. The CLI never receives the key.

```
archymedes --free ──► free gateway ──► OpenRouter (verified :free models only)
   (no key)            key, limits,       zero max_price, no fallbacks
                       request policy
```

A user who sets their own `OPENROUTER_API_KEY` bypasses the gateway and goes to OpenRouter directly.

## What it enforces

- **Models:** only models OpenRouter's live listing shows at zero price with text output and tool
  support (`GET /v1/models`). The list is loaded once per process (warmed at startup), shared by
  every request, and refreshed hourly in the background: requests are answered from the cached
  list while one refresh runs. If a refresh fails, the last good list is kept and retried a minute later.
- **Request policy:** every request body is rebuilt from an allowlist: `model`, `messages`,
  `tools`, `max_tokens` (clamped), `stream`. The provider cap is always
  `max_price: 0` with `allow_fallbacks: false`, so a client cannot choose a paid model, enable
  plugins or fallbacks, or override the price cap.
- **Budget:** tokens are the main daily budget (100,000 model tokens a day per install, or per
  address without a token), charged from the usage the model reports. Request caps (300 a day,
  20 a minute) are sized for agent loops, which send one request per tool call, and only stop
  runaway or scripted clients. A refused request is refunded from every counter, so hitting the
  per-minute burst limit costs no daily allowance.
- **Rate limits:** fixed windows per install token (when the client sends one), then per IP
  address, then global. Each scope is charged only if the previous one passed, so one client past
  its own limit cannot use up the shared capacity. IPs are stored only as salted hashes. If the
  counter store is down, requests are refused rather than sent.
- **Timeouts:** a deadline for the model's first byte (120 s), then an idle timeout between
  streamed chunks (90 s). A stalled stream is aborted upstream and the client stream ends with an
  SSE error event, so clients fail over instead of hanging.
- **Error privacy:** upstream error metadata (including the operator's OpenRouter user id) is
  removed. Errors the gateway produces itself carry `x-free-gateway-error`, which tells the CLI not to
  retry other models against the same limit.

## Client contract

Base URL: the deployment root (for example `https://free.example.com`). All responses are JSON
unless a stream was requested. Errors are always `{"error": {"message": string, "code": number, "type"?: string}}`;
limit refusals (429) add the fields described under [Allowance headers and limit errors](#allowance-headers-and-limit-errors).

### `POST /v1/install` — get an anonymous install token

No body, no auth. Call once per installation and store the token (it does not expire unless the
operator sets `FREE_GATEWAY_INSTALL_MAX_AGE_DAYS`).

```json
200 {
  "token": "v1.<payload>.<signature>",
  "install_id": "22-char random id",
  "issued_at": "2026-10-07T12:00:00.000Z",
  "header": "x-archymedes-install"
}
```

| Status | Meaning | Client action |
| --- | --- | --- |
| `200` | Token issued | Store `token`; send it on every chat request |
| `429` + `x-free-gateway-error` | Issuance limit for this address (default 5/day) | Continue without a token; retry after `retry-after` / `x-free-reset-utc` |
| `503` + `x-free-gateway-error` | Tokens not enabled on this gateway (or limiter down) | Continue without a token |

The token holds only a random install id and the issue time, signed with HMAC-SHA256. It contains
no personal data and nothing about the machine.

### `POST /v1/chat/completions` — with the token

Send the stored token in a request header:

```
x-archymedes-install: v1.<payload>.<signature>
```

The header is optional; requests without it work exactly as before, under the per-address limits.
When the header is sent and tokens are enabled, the response (success or error) carries:

| `x-archymedes-install-status` | Meaning | Client action |
| --- | --- | --- |
| `valid` | Limited per install, with relaxed per-address limits | None |
| `invalid` | Token rejected (tampered, other deployment, rotated secret, expired); this request was served under the anonymous per-address limits | Discard the token and `POST /v1/install` again |
| _(absent)_ | No header sent, or tokens not enabled | None |

### Failing over

| Response | Origin | Retry another model? |
| --- | --- | --- |
| `429` / `503` with `x-free-gateway-error` | gateway limit or outage | No: every model is behind the same limit |
| `504` JSON, `type: "upstream_timeout"` | no first byte within the deadline | Yes |
| `504` JSON, `type: "upstream_idle_timeout"` (non-streamed reply stalled) | model | Yes |
| `502` JSON, `type: "upstream_unreachable"` / `"upstream_stream_failed"` | model service | Yes |
| other 4xx/5xx without `x-free-gateway-error` | that model | Yes |
| SSE event `data: {"error":{"code":504,"type":"upstream_idle_timeout","retryable":true,...}}` then a normal close | stream stalled mid-answer | Yes (the partial answer is incomplete) |
| SSE event `data: {"error":{"code":502,"type":"upstream_stream_failed","retryable":true,...}}` then a normal close | upstream connection broke mid-answer | Yes |

The SSE error event follows OpenAI's convention, so the OpenAI SDKs raise an `APIError` for it.

### Allowance headers and limit errors

Successful chat responses carry the allowance **as it stood before this request** (its own usage
is only known once the model has answered, so it shows on the next response):

| Header | On | Value |
| --- | --- | --- |
| `x-free-remaining-tokens` | 200, 429 | Model tokens left today (tightest of the client's token allowances); `0` on a token-limit 429 |
| `x-free-remaining-requests` | 200, 429 | Requests left today, counting this one (tightest of the client's own daily request limits; global capacity is not included). Absent when no daily request rule applied |
| `x-free-reset-utc` | 200, 429 | ISO-8601 time the allowance resets: the next UTC midnight on 200; on 429, the end of the window that refused (the next minute for a per-minute limit) |
| `x-free-allowance-warning` | 200 | Present once 80% of the daily token allowance is used |
| `x-archymedes-install-status` | any | See above |
| `retry-after` | 429, some 503 | Seconds to wait: at most 60 for a per-minute limit, seconds until reset for a daily one |
| `x-free-gateway-error` | gateway errors | The status code; marks an error the gateway produced (do not retry other models) |

A 429 body is machine-readable; the message text is for showing to the user:

```json
{"error": {
  "message": "You've reached today's free usage limit (100,000 tokens). Your allowance resets at 2026-10-09T00:00:00.000Z. Type /upgrade to use your own OpenRouter API key.",
  "code": 429,
  "kind": "daily_tokens",
  "rule": "install-token-day",
  "scope": "install",
  "limit": 100000,
  "reset_utc": "2026-10-09T00:00:00.000Z",
  "retry_after_seconds": 41234,
  "remaining_tokens": 0,
  "remaining_requests": 280
}}
```

| `kind` | Meaning | Client action |
| --- | --- | --- |
| `per_minute` | A burst limit (`rule` ends in `-minute`) | Wait `retry_after_seconds` (at most 60) and continue the same task |
| `daily_requests` | A daily request limit | Stop free mode until `reset_utc` (or `/upgrade`) |
| `daily_tokens` | The daily token allowance | Stop free mode until `reset_utc` (or `/upgrade`) |

`scope` is `install`, `ip` or `global`: `global` (and `ip` with a `rule` starting `ip-shared`) means
shared capacity rather than the user's own allowance. `remaining_tokens` and `remaining_requests`
are present when known. `POST /v1/install` refusals use the same shape (`rule` starts with `issue-`).

## Capacity

OpenRouter limits free-model use per account (about 20 requests a minute; the daily allowance
depends on the account's credit balance). An agent task is often 5–30 requests. The global
defaults (20 a minute, 1,000 a day) assume a funded account; set them from your own account's limits.

## Run

```sh
OPENROUTER_API_KEY=sk-or-... GATEWAY_TOKEN_SECRET=$(openssl rand -hex 32) \
  bun packages/free-gateway/src/server.ts                                           # http://0.0.0.0:8787

docker build -f packages/free-gateway/Dockerfile -t archymedes-free-gateway .   # from the repo root
docker run -p 8787:8787 -e OPENROUTER_API_KEY=sk-or-... -e GATEWAY_TOKEN_SECRET=... archymedes-free-gateway
```

Point a CLI at it for testing: `ARCHYMEDES_FREE_GATEWAY_URL=http://localhost:8787 archymedes --free`.
Plain `http` is accepted only for localhost. Once the official deployment exists, set
`FREE_GATEWAY_URL` in `packages/core/src/providers/free-catalog.ts` so `--free` works with no setup.

## Deploy

1. **Secrets.** In the host's secret store set `OPENROUTER_API_KEY`, `GATEWAY_TOKEN_SECRET`
   (`openssl rand -hex 32`; at least 32 characters, the same value on every instance) and
   `FREE_GATEWAY_SALT` (any random string, so per-address counts survive restarts).
2. **Counters.** For more than one instance, or any serverless/autoscaled host, create an Upstash
   Redis database and set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (the REST URL
   and token from the database's console), plus `FREE_GATEWAY_INSTANCES` to the instance count.
   Every limit (per install, per address, global, issuance, token allowances) uses the same store;
   keys look like `free:<rule>:<scope>:<id>:<window>` and expire with their window.
3. **Proxy / client address.** By default the socket address is used and no header is trusted.
   Behind a platform proxy, opt in to exactly one source the proxy controls:
   - Fly.io: `FREE_GATEWAY_CLIENT_IP_HEADER=fly-client-ip` (Fly overwrites it on every request).
   - Render, nginx, most load balancers: `FREE_GATEWAY_TRUST_PROXY=true`. `X-Forwarded-For` is read
     **from the right** (`FREE_GATEWAY_PROXY_HOPS`, default 1 = the entry the last proxy appended);
     the leftmost entries are whatever the client sent and are never used.
   - Cloudflare in front of your own origin: `FREE_GATEWAY_CLIENT_IP_HEADER=cf-connecting-ip`.

   Verify once with `FREE_GATEWAY_DEBUG_IP=true` (see "Verify the client address" below), then
   unset it. Disable response buffering for `text/event-stream` (the gateway sends
   `X-Accel-Buffering: no` for nginx) and allow idle connections of at least the idle timeout.
4. **Check.** `curl -X POST https://<host>/v1/install` returns a token; `curl https://<host>/v1/models`
   lists models; `curl https://<host>/health` returns `{"ok":true}` (use it as the host's health check).
5. **Rotating the secret** invalidates every token; clients see `x-archymedes-install-status: invalid`
   and re-register automatically (subject to the issuance limit).

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | required | The shared key. Keep it in the host's secret store. |
| `GATEWAY_TOKEN_SECRET` | unset (tokens disabled) | HMAC secret for install tokens; ≥ 32 characters, same on every instance |
| `FREE_GATEWAY_INSTALL_MAX_AGE_DAYS` | unset (no expiry) | Reject install tokens older than this |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |
| `FREE_GATEWAY_CLIENT_IP_HEADER` | unset | Single-value header holding the client address, set by your proxy (`fly-client-ip`, `cf-connecting-ip`). Takes precedence over `TRUST_PROXY` |
| `FREE_GATEWAY_TRUST_PROXY` | `false` | Use `X-Forwarded-For`, read from the right; enable only behind a proxy that appends to it |
| `FREE_GATEWAY_PROXY_HOPS` | `1` | Which `X-Forwarded-For` entry from the right is the client (the number of trusted proxies) |
| `FREE_GATEWAY_DEBUG_IP` | `false` | Serves `GET /debug/ip` returning `{"ip": "..."}` (the address limits would count) to verify proxy settings |
| **Anonymous (no token)** | | |
| `FREE_GATEWAY_IP_TOKENS_PER_DAY` | `100000` | Model tokens per address per day: **the main budget** |
| `FREE_GATEWAY_IP_PER_DAY` / `_IP_PER_MINUTE` | `300` / `20` | Requests per address (anti-abuse caps sized for agent loops) |
| **With a valid install token** | | |
| `FREE_GATEWAY_INSTALL_TOKENS_PER_DAY` | `100000` | Model tokens per install per day: **the main budget** |
| `FREE_GATEWAY_INSTALL_PER_DAY` / `_INSTALL_PER_MINUTE` | `300` / `20` | Requests per install |
| `FREE_GATEWAY_IP_PER_MINUTE_WITH_INSTALL` / `_IP_PER_DAY_WITH_INSTALL` | `120` / `3000` | Relaxed per-address ceiling shared by all installs behind one IP |
| `FREE_GATEWAY_IP_TOKENS_PER_DAY_WITH_INSTALL` | `2000000` | Model tokens per address per day, across installs |
| **Issuance** | | |
| `FREE_GATEWAY_INSTALLS_PER_IP_PER_DAY` | `5` | Tokens issued per address per day |
| `FREE_GATEWAY_INSTALLS_GLOBAL_PER_DAY` | `5000` | Tokens issued per day in total |
| **Shared** | | |
| `FREE_GATEWAY_GLOBAL_PER_MINUTE` / `_GLOBAL_PER_DAY` | `20` / `1000` | Whole-gateway request limits (all clients) |
| `FREE_GATEWAY_FIRST_BYTE_TIMEOUT_MS` | `120000` | Wait for the model's response to start |
| `FREE_GATEWAY_IDLE_TIMEOUT_MS` | `90000` | Longest gap between streamed chunks before aborting |
| `FREE_GATEWAY_CATALOG_TTL_MS` | `3600000` | How often the model list is refreshed (in the background) |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | in-memory | Shared counters; required when running more than one instance |
| `FREE_GATEWAY_INSTANCES` | `1` | Refuses to start above 1 without Upstash |
| `FREE_GATEWAY_SALT` | random per process | Set to keep IP counts stable across restarts |
| `FREE_GATEWAY_REFERER` | repository URL | OpenRouter app attribution |

Limit values that are missing, zero, negative or not integers fall back to the default.

In-memory counters are correct only for a single long-running instance (a container or VM). On
serverless or autoscaled hosts, each instance keeps its own counts; use Upstash there.

## Deploy in 10 minutes

Both recipes run one always-on instance with in-memory counters, which is correct for a single
instance; to run more, add Upstash (see [Deploy](#deploy)). Run every command from the
**repository root**: the image builds `packages/core` into the gateway.

You need an OpenRouter key for the shared account (`sk-or-...`) and `openssl` (or any random
generator) for the secrets.

### Fly.io (`packages/free-gateway/fly.toml`)

```sh
# 1. Install flyctl (https://fly.io/docs/flyctl/install/) and sign in: fly auth login
# 2. Create the app without deploying (accept or change the app name/region it proposes)
fly launch --no-deploy --copy-config -c packages/free-gateway/fly.toml --dockerfile packages/free-gateway/Dockerfile
# 3. Secrets (never put these in fly.toml)
fly secrets set -c packages/free-gateway/fly.toml \
  OPENROUTER_API_KEY=sk-or-... \
  GATEWAY_TOKEN_SECRET=$(openssl rand -hex 32) \
  FREE_GATEWAY_SALT=$(openssl rand -hex 16)
# 4. Deploy exactly one machine (in-memory counters)
fly deploy -c packages/free-gateway/fly.toml --dockerfile packages/free-gateway/Dockerfile --ha=false
fly scale count 1 -c packages/free-gateway/fly.toml
# 5. Check
curl https://<app>.fly.dev/health
curl -X POST https://<app>.fly.dev/v1/install
```

`fly.toml` already sets `FREE_GATEWAY_CLIENT_IP_HEADER=fly-client-ip`, a `/health` check, and
`auto_stop_machines = "off"` (a stopped machine would forget its counters).

### Render (`packages/free-gateway/render.yaml`)

1. Push the repository to GitHub or GitLab.
2. Render dashboard: **New > Blueprint**, pick the repository, set **Blueprint path** to
   `packages/free-gateway/render.yaml`, then **Apply**.
3. Enter `OPENROUTER_API_KEY` when prompted. `GATEWAY_TOKEN_SECRET` and `FREE_GATEWAY_SALT` are
   generated for you.
4. When the deploy is live: `curl https://<service>.onrender.com/health`.

The blueprint uses the `starter` plan (the free plan sleeps and resets in-memory counters), one
instance, and `FREE_GATEWAY_TRUST_PROXY=true` with `FREE_GATEWAY_PROXY_HOPS=1`.

### Verify the client address (both hosts, once)

Set `FREE_GATEWAY_DEBUG_IP=true` (`fly secrets set -c packages/free-gateway/fly.toml FREE_GATEWAY_DEBUG_IP=true`,
or the Render dashboard's Environment tab), then:

```sh
curl https://<host>/debug/ip                                                              # must print YOUR public IP
curl -H "X-Forwarded-For: 6.6.6.6" -H "Fly-Client-IP: 6.6.6.6" https://<host>/debug/ip   # must still print YOUR IP
```

If the first prints a proxy address, adjust `FREE_GATEWAY_PROXY_HOPS` (or switch to the header
your platform sets). If the second prints `6.6.6.6`, the setting trusts a forgeable value. Then
remove `FREE_GATEWAY_DEBUG_IP` (`fly secrets unset ...`, or delete it on Render).

### Point the clients at it

- Testing: `ARCHYMEDES_FREE_GATEWAY_URL=https://<host> archymedes --free` (the CLI and the desktop
  app both read this variable).
- Shipping: set `FREE_GATEWAY_URL = "https://<host>"` in
  `packages/core/src/providers/free-catalog.ts` (CLI) and in the desktop app's
  `src/main/agent/free-adapter.ts`, then release new builds. Plain `http` is accepted only for localhost.
