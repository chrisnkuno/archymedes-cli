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
  support (`GET /v1/models`). The list is refreshed hourly; if a refresh fails, the last good list is kept.
- **Request policy:** every request body is rebuilt from an allowlist: `model`, `messages`,
  `tools`, `max_tokens` (clamped), `stream`. The provider cap is always
  `max_price: 0` with `allow_fallbacks: false`, so a client cannot choose a paid model, enable
  plugins or fallbacks, or override the price cap.
- **Rate limits:** fixed windows per IP address, then global. Per-IP limits are checked first, so one
  client past its own limit cannot use up the shared capacity. IPs are stored only as salted hashes.
  If the counter store is down, requests are refused rather than sent.
- **Error privacy:** upstream error metadata (including the operator's OpenRouter user id) is
  removed. Errors the gateway produces itself carry `x-free-gateway-error`, which tells the CLI not to
  retry other models against the same limit.

## Capacity

OpenRouter limits free-model use per account (about 20 requests a minute; the daily allowance
depends on the account's credit balance). An agent task is often 5–20 requests. The defaults
(`10/min` and `150/day` per IP, `20/min` and `1000/day` globally) assume a funded account; set them
from your own account's limits.

## Run

```sh
OPENROUTER_API_KEY=sk-or-... bun packages/free-gateway/src/server.ts      # http://0.0.0.0:8787

docker build -f packages/free-gateway/Dockerfile -t archymedes-free-gateway .   # from the repo root
docker run -p 8787:8787 -e OPENROUTER_API_KEY=sk-or-... archymedes-free-gateway
```

Point a CLI at it for testing: `ARCHYMEDES_FREE_GATEWAY_URL=http://localhost:8787 archymedes --free`.
Plain `http` is accepted only for localhost. Once the official deployment exists, set
`FREE_GATEWAY_URL` in `packages/core/src/providers/free-catalog.ts` so `--free` works with no setup.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | required | The shared key. Keep it in the host's secret store. |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | Listen address |
| `FREE_GATEWAY_TRUST_PROXY` | `false` | Use `X-Forwarded-For`; enable only behind a proxy that sets it |
| `FREE_GATEWAY_IP_PER_MINUTE` / `_IP_PER_DAY` | `10` / `150` | Per-address limits |
| `FREE_GATEWAY_GLOBAL_PER_MINUTE` / `_GLOBAL_PER_DAY` | `20` / `1000` | Whole-gateway limits |
| `UPSTASH_REDIS_REST_URL` / `_TOKEN` | in-memory | Shared counters; required when running more than one instance |
| `FREE_GATEWAY_INSTANCES` | `1` | Refuses to start above 1 without Upstash |
| `FREE_GATEWAY_SALT` | random per process | Set to keep IP counts stable across restarts |
| `FREE_GATEWAY_REFERER` | repository URL | OpenRouter app attribution |

In-memory counters are correct only for a single long-running instance (a container or VM). On
serverless or autoscaled hosts, each instance keeps its own counts; use Upstash there.
