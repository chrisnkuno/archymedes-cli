# Free mode: implementation contract

Status: implemented; live keyed tool round trip verified 2026-09-15 (WS-4.4). Updated 2026-09-15. Tracker: WS-4.

## User outcome

Run `archymedes --free` using one locally configured OpenRouter key, with no Archymedes Cloud
account or individual model-vendor setup. This is a model access choice: build/plan/auto modes,
workspace selection and tool permissions retain their existing meanings.

The user has agreed to supply a key. The first implementation uses each installation's key.
A maintainer key must never be bundled into the CLI: distributing sponsored access to other
users requires a separately operated authenticated service and is outside this direct-access design.

## What was verified

- [ClawLabsAI's catalog](https://github.com/ClawLabsAI/free-ai-models) is discovery data, not an
  inference endpoint. A model's publisher is different from the service hosting its API.
- [OpenRouter authentication](https://openrouter.ai/docs/api/reference/authentication) requires a key.
- [Pollinations' current API](https://github.com/pollinations/pollinations#-unified-api) uses keys
  and credits. A live anonymous listing returned `openai-fast`, not the four older aliases described
  as separate models in the supplied dataset. An anonymous completion returned HTTP 200 with a
  budget-exhausted message and zero token usage. No successful inference was verified.
- Therefore do not advertise the full dataset as available without authentication, copy publisher
  rate limits onto OpenRouter routes, or interpret HTTP 200 alone as a successful model turn.

## Interface and access policy

- `--free` selects the dedicated `free` provider; `--provider free` is equivalent. Conflicting
  provider flags produce an actionable error independent of argument order.
- Store `OPENROUTER_API_KEY` using the existing secret settings field mechanism. Never print it,
  include it in a model cache, persist it in session exports, or ask for it in a committed fixture.
- Default to `openrouter/free`. Permit `--model <id>` and `/model` for validated free tool-capable
  text models. Reject paid IDs and router/plugin suffixes that could change billing.
- Route directly to the fixed OpenRouter API host. Do not allow catalog source URLs or a generic
  base URL override to redirect this credential.
- Send zero maximum prompt/completion prices using OpenRouter's
  [provider routing contract](https://openrouter.ai/docs/guides/routing/provider-selection).
  Never silently switch to a paid variant or another configured provider on failure.
- Show free inference as zero-priced, with account quotas and service availability still applying.
  Sandbox, search and other separately configured services can have their own charges.
- Missing key, rejected key, quota exhaustion, unavailable model and no eligible models are
  distinct failures. Reuse bounded runtime retries and cancellation; do not multiply retries in an SDK.

## Modules and dependencies

These modules exist. `free-cache` tests live in `model-fetch.test.ts`; resume and background-job restoration is `app/session-provider.ts`.

| Location | Responsibility | Dependencies |
| --- | --- | --- |
| core `providers/free-catalog.ts` | Parse and normalize discovery records; determine eligibility | Pure data/types only |
| core `providers/free-catalog-fetch.ts` | Fetch and validate current catalog with bounded timeout/size and cache lifetime | Parser, injected fetch/clock/cache |
| core `providers/free-agent.ts` | Enforce free-only policy and translate requests to OpenRouter | Existing wire translation, capability types |
| core `provider-specs.ts` / `agent-matrix.ts` | Identify and construct the free provider | Metadata / adapter respectively |
| CLI `app/args.ts` | Parse free selection and conflicts | Existing argument types |
| CLI `platform/settings.ts` | Accept and redact the local key | Existing settings persistence |
| CLI `session/models.ts` | Offer eligible model choices | Core catalog metadata |
| CLI `app/help.ts` / guide | Explain key setup, quotas and direct access | Existing presentation helpers |

Integrate with existing `model-list.ts` / `model-fetch.ts` caching rather than creating two competing
catalog caches. Keep catalog loading lazy; normal startup and non-model commands must stay offline.
Coordinate edits to `archymedes.ts` with the ongoing handler extraction; new policy does not belong there.

## Catalog contract

Retain `id`, `name`, `provider`, `context_window`, `max_output`, `modalities`, `rate_limit`, `source`
and fetch time. Preserve unknown limits as unknown. Normalize strings and positive integer limits;
reject malformed records, duplicates and unsafe source links. Cap downloaded bytes and record count.

Use ClawLabsAI data as attributed discovery metadata. Cross-check against OpenRouter's own live
model listing for zero prompt and completion prices, text output and tool support. Input modalities
do not imply text output or tool support: music and safety models must not become coding choices
just because they accept text. Keep unavailable or unverified entries distinct from selectable ones.

A cached catalog is a display optimization, never authority to spend. A request must enforce the
zero-price constraint even when metadata is stale. Refresh failure retains a dated last-known-good
display with an error; malformed input must not overwrite a good cache. Unknown or smaller model
limits must not inherit an optimistic 200K context window. Clamp output to verified capabilities.

## Acceptance tests

1. All existing direct/cloud selection tests still pass; free selection never consumes their keys.
2. Missing key names the settings field; credentials remain redacted in logs, errors and snapshots.
3. Catalog tests cover current raw schema, malformed/oversized data, duplicates, stale cache,
   missing prices, text-input/audio-output models, absent tools and empty eligible results.
4. Request tests prove the fixed host, zero-price constraints, supported tool fields, streaming,
   tool-call parsing, output limits, usage accounting, abort propagation and bounded retries.
5. A paid model, modified router ID or unavailable choice fails before inference. No paid fallback.
6. CLI tests cover `--free`, conflicting flags, first-run settings, `/model`, resume and headless
   execution. Model identity and free selection survive resume and compaction.
7. With the locally configured key, perform a tiny text completion and a harmless tool round trip;
   inspect actual selected model and reported usage/cost. A quota error is a failed smoke test.
8. Run `bun run recheck --pty`, then `bun run recheck --full`; record guards, counts and package
   verification in WS-4. Report live access independently of local tests.

## Execution order

WS-4.2: pure catalog policy and adapter, validated with injected responses.
WS-4.3: integrate identity, discovery, settings and CLI journeys after the policy is tested.
WS-4.4: configure the key locally, verify real model/tool behavior, then complete release checks.
No dependency installation, publication or private-service change is required for preparation.
