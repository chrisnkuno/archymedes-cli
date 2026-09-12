# Hosted exchange client API

This is the public client contract for the private Archymedes hosted services. It documents what a
CLI or self-hosted client may send and receive without exposing service implementation, production
identity, ledger storage, routing intelligence, payment handling, or operational configuration.

## Authentication

Bearer tokens resolve to an account-scoped principal with one or more capabilities:

- `user`: balances, reservations, completions, jobs, and owned conversations.
- `worker`: claiming, heartbeating, completing, or failing leased jobs.
- `billing`: reserved for verified payment and settlement service endpoints.

Worker identity always comes from the authenticated principal. A request body cannot choose or
impersonate a worker. Cross-account job, reservation, and conversation lookups return `404` so ids
cannot be enumerated.

All non-health responses use `Cache-Control: no-store`.

## Endpoints

| Method | Path | Scope | Purpose |
| --- | --- | --- | --- |
| `GET` | `/healthz` | public | Liveness and protocol version |
| `GET` | `/v1/credits/balance?currency=USD` | user | Account credit projection |
| `POST` | `/v1/credits/reservations` | user | Reserve an integer-micro task cap |
| `GET` | `/v1/credits/reservations/:id` | user | Read an owned reservation |
| `POST` | `/v1/credits/reservations/:id/release` | user | Return unused reserved credits |
| `POST` | `/v1/chat/completions` | user | Route, meter, settle, and return an OpenAI-compatible completion |
| `POST` | `/v1/routes/plan` | user | Rank the routes a completion would be offered, without running one |
| `POST` | `/v1/jobs` | user | Enqueue a disconnected cloud task |
| `GET` | `/v1/jobs/:id` | user | Read an owned task |
| `GET` | `/v1/conversations/:id/messages?after=N` | user | Resume ordered messages from a cursor |
| `POST` | `/v1/conversations/:id/messages` | user | Add a user message |
| `POST` | `/v1/workers/claim` | worker | Claim or reclaim the oldest eligible task |
| `POST` | `/v1/jobs/:id/heartbeat` | worker | Renew an owned lease |
| `POST` | `/v1/jobs/:id/complete` | worker | Persist a successful terminal outcome |
| `POST` | `/v1/jobs/:id/fail` | worker | Persist a failed terminal outcome |

Mutation endpoints that create user-owned resources require an `Idempotency-Key` header. Planning
creates nothing, so it takes none.

## Routing preflight

`POST /v1/routes/plan` answers what a completion *would* be routed to. It reserves no credit, calls
no provider and settles nothing, so it is safe to call before deciding whether to spend at all.

Ranking reads one property of the prompt: its size. A client may therefore send the token count its
own estimator produced instead of the conversation, and asking what a turn would cost never uploads
the turn:

```json
{
  "model": "auto",
  "max_completion_tokens": 4096,
  "archymedes": {
    "estimated_input_tokens": 8421,
    "maximum": { "currency": "USD", "micros": 5000000 },
    "profile": { "kind": "coding", "requiredCapabilities": ["tools"], "dataPolicy": "zero-retention" }
  }
}
```

`messages` remains accepted in place of `estimated_input_tokens`, and the exchange then measures
them itself. A request carrying neither is rejected. A completion is unaffected: it always sends
messages, because it has to run them.

The response ranks the eligible routes best-first and lists separately the routes that were removed
before ranking — a provider with no configured credential was never weighed, so presenting it as a
losing candidate would misstate why it is missing:

```json
{
  "object": "routing_plan",
  "policy": { "id": "outcome-per-dollar", "version": 3 },
  "ranked": [
    { "candidate": { "provider": "anthropic", "model": "claude-sonnet-5" },
      "eligible": true, "reason": "highest predicted outcome within budget", "score": 0.86,
      "estimated_charged": { "currency": "USD", "micros": 12000 },
      "expected_total_micros": 31000, "expected_attempts": 1.1, "expected_latency_ms": 4200,
      "completed_quality": 0.88, "outcome_per_dollar": 28.4, "funding_source": "platform" }
  ],
  "excluded": [
    { "provider": "groq", "model": "llama-3.3-70b-versatile",
      "eligible": false, "reason": "provider credential is unavailable" }
  ]
}
```

Every figure in a plan is a forecast. `completed_quality` is a prediction, never an evaluation, and
`expected_total_micros` prices the whole task — expected retries and context movement included —
which is not the same number as the single-call estimate in `estimated_charged`.

An empty `ranked` array means no route can run the work. It is not a successful selection, and a
client must not render it as one; the reasons are in `excluded`.

## Completion request

The standard OpenAI fields remain at the top level. Archymedes-specific budget and policy inputs are
contained in `archymedes` and are removed before the selected provider receives the request.

```json
{
  "model": "auto",
  "messages": [{ "role": "user", "content": "Review this change" }],
  "archymedes": {
    "task_id": "task_01",
    "maximum": { "currency": "USD", "micros": 5000000 },
    "expires_at": "2026-09-01T13:00:00.000Z",
    "profile": {
      "kind": "coding",
      "requiredCapabilities": ["tools"],
      "dataPolicy": "zero-retention",
      "region": "us",
      "qualityFloor": 0.8
    }
  }
}
```

The response retains the provider’s OpenAI-compatible body and adds:

```json
{
  "archymedes": {
    "reservation_id": "rsv_...",
    "routing_receipt": {
      "task_id": "cli_...",
      "chosen": { "model": "claude-sonnet-5", "provider": "anthropic" },
      "considered": [
        { "model": "claude-sonnet-5", "provider": "anthropic", "eligible": true,
          "reason": "highest predicted outcome within budget", "estimatedMicros": 12000, "score": 0.86 },
        { "model": "gpt-5.6-terra", "provider": "openai", "eligible": true,
          "reason": "cheaper, below the quality floor", "estimatedMicros": 9000, "score": 0.81 },
        { "model": "gemini-2.5-pro", "provider": "google", "eligible": false,
          "reason": "data-residency policy: not available in region us" }
      ],
      "policy": { "dataPolicy": "zero-retention", "region": "us", "qualityFloor": 0.8, "maximumMicros": 5000000 },
      "currency": "USD",
      "estimatedMicros": 12000,
      "actualMicros": 9800,
      "retries": 1,
      "latencyMs": 1420,
      "outcomeScore": 0.9
    },
    "usage_event": {}
  }
}
```

The routing receipt records every route the exchange weighed (`considered`), why each was chosen or
passed over (`reason`, `eligible`), the policy the choice was held to (`policy`), the estimate
against the actual charge (`estimatedMicros` / `actualMicros`), bounded provider retries
(`retries`), wall latency (`latencyMs`), and — when scored — Archymedes' evaluation of the
completed outcome (`outcomeScore`). It never contains the raw prompt. Every field except `chosen`
is optional; a client tolerates `snake_case` on the wire-level fields and a thinned receipt. The
CLI renders it after a hosted turn and stores normalized receipts in the session snapshot for `/route`.

Streaming is currently rejected by the hosted boundary until reservation-safe streaming can
guarantee a final usage event and release or settle credits after client disconnects.

## CLI integration

Select the hosted path with `ARCHYMEDES_PROVIDER=archymedes-cloud` and configure
`ARCHYMEDES_CLOUD_TOKEN` plus `ARCHYMEDES_CLOUD_BASE_URL`. Optional controls are
`ARCHYMEDES_CLOUD_MAXIMUM_MICROS`, `ARCHYMEDES_CLOUD_CURRENCY`, `ARCHYMEDES_CLOUD_REGION`,
`ARCHYMEDES_CLOUD_DATA_POLICY`, `ARCHYMEDES_CLOUD_QUALITY_FLOOR`, and `ARCHYMEDES_CLOUD_TASK_KIND`
(one of `coding`, `design`, `architecture`, `security`, `research`, `deployment`; default
`coding`). Direct provider configuration continues to be the BYOK/offline path.

### Routing inspection in the CLI

`/route` shows the latest receipt, `/route all` shows this session's receipts, and
`/route summary` aggregates calls, retries, route switches, estimates and settled spend.
These commands read the active session, including receipts restored on resume. Tabs and new
threads have separate histories. Identified calls are deduplicated; older unidentified receipts
remain separate. Snapshots are saved at turn completion: this does not recover paid work lost
before the snapshot was saved.
Spend is grouped by currency; calls without settlement data are counted explicitly.
These figures describe receipts saved for the active session, not an account balance.

The client accepts both the hosted `chosen` receipt and protocol receipts containing
`selectedProvider`, `selectedModel`, `requestId`, `policyId`, `policyVersion`, `attempts`,
`estimated` and `actual`. Protocol attempts supply the fallback trail and summed attempt duration.
Ranking scores are preserved as finite utilities; they are not necessarily probabilities.
Outcome quality remains a separate value in the range zero to one.


### Transport retries and logical request identity

`AgentModelRequest.requestId` identifies one logical model call. The bounded runtime creates it
before the retry loop and retains it for transport retries; a later model iteration receives a new
identity. The hosted adapter sends the same identity in the idempotency header and request body.
Embedders calling the adapter directly should supply a stable ID when retrying the same request.
Do not reuse an ID for changed request content.

The runtime honors bounded server retry delays and stops on terminal hosted conflicts or spend
limits. `request_in_progress` remains retryable; `request_previously_failed` and
`idempotency_conflict` are terminal for the existing logical call. This supports in-process replay,
not durable recovery of an interrupted client process.

Hosted forecasts may include `expectedTotalMicros`, `predictedOutcomeScore`, and economic
`factors`. The CLI labels these as forecasts. `finalOutcomeScore`, when supplied, is treated as
evaluated evidence; a null final outcome must not be replaced with the prediction. Total request
latency can be supplied as `totalLatencyMs`.
