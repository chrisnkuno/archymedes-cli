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
| `POST` | `/v1/jobs` | user | Enqueue a disconnected cloud task |
| `GET` | `/v1/jobs/:id` | user | Read an owned task |
| `GET` | `/v1/conversations/:id/messages?after=N` | user | Resume ordered messages from a cursor |
| `POST` | `/v1/conversations/:id/messages` | user | Add a user message |
| `POST` | `/v1/workers/claim` | worker | Claim or reclaim the oldest eligible task |
| `POST` | `/v1/jobs/:id/heartbeat` | worker | Renew an owned lease |
| `POST` | `/v1/jobs/:id/complete` | worker | Persist a successful terminal outcome |
| `POST` | `/v1/jobs/:id/fail` | worker | Persist a failed terminal outcome |

Mutation endpoints that create user-owned resources require an `Idempotency-Key` header.

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
    "routing_receipt": {},
    "usage_event": {}
  }
}
```

The routing receipt includes every considered route, eligibility reason, bounded attempt, estimated
cost, and actual charged cost. It never contains the raw prompt.

Streaming is currently rejected by the hosted boundary until reservation-safe streaming can
guarantee a final usage event and release or settle credits after client disconnects.

## CLI integration

Select the hosted path with `ARCHYMEDES_PROVIDER=archymedes-cloud` and configure
`ARCHYMEDES_CLOUD_TOKEN` plus `ARCHYMEDES_CLOUD_BASE_URL`. Optional controls are
`ARCHYMEDES_CLOUD_MAXIMUM_MICROS`, `ARCHYMEDES_CLOUD_CURRENCY`, `ARCHYMEDES_CLOUD_REGION`,
`ARCHYMEDES_CLOUD_DATA_POLICY`, and `ARCHYMEDES_CLOUD_QUALITY_FLOOR`. Direct provider configuration
continues to be the BYOK/offline path.
