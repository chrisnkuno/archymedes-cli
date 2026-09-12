# Archymedes repository architecture

Repository visibility is a security boundary. Public repositories contain code users must inspect,
extend, or run locally. Money movement, multi-tenant orchestration, proprietary telemetry, licensed
knowledge, credentials, contracts, and production infrastructure remain private.

## Public repositories

| Repository | Contents |
| --- | --- |
| `archymedes-cli` | CLI, provider-neutral local runtime, provider client adapters, local memory, sandbox interfaces, basic voice, and self-hosted local tools |
| `archymedes-protocol` | Runtime schemas, routing requests/receipts, credit commands, job/message events, role/defender formats, sync envelopes, and compatibility fixtures |
| `archymedes-role-packs` | Core developer, designer, architect, deployment, QA, and defensive-security role manifests |
| `archymedes-defender` | Local defender-engine interfaces, deterministic finding orchestration, safe policies, and community knowledge packs |

## Private repositories

| Repository | Contents |
| --- | --- |
| `archymedes-cloud` | Identity, organizations, durable jobs, messaging, regional workers, encrypted sync, and hosted orchestration |
| `archymedes-routing-intelligence` | Provider telemetry, health, outcome models, learned weights, experiments, pricing, capacity, and margin strategy |
| `archymedes-billing` | Ledger, reservations, settlement, payment integrations, tax, refunds, fraud, and reconciliation |
| `archymedes-operations` | Infrastructure, deployment state, monitoring, incident response, provider contracts, and secrets management |
| `archymedes-premium-packs` | Proprietary workforce knowledge, enterprise policies, licensed datasets, and premium evaluations |

## Dependency and release rules

1. Protocol changes are versioned and additive within a major version. Implementations depend on
   released protocol artifacts; the protocol never depends on an implementation.
2. Billing does not import cloud, CLI, or routing implementations. Cloud requests signed billing
   operations; it cannot mutate ledger storage directly.
3. Routing receives a bounded budget and returns a receipt. It does not receive payment credentials,
   customer balances, or raw prompts in telemetry.
4. Public history must never contain payment implementations, merchant configuration, customer
   balances, multi-tenant orchestration, learned weights, aggregate telemetry, licensed data,
   production infrastructure, or credentials.
5. Private packages are delivered through an authenticated registry. Dependency manifests never
   embed access tokens or credential-bearing repository URLs.
6. Billing and operations require protected branches, signed commits, two-person production review,
   secret scanning, backups, and restore drills.

Do not use Git submodules to expose private services from a public checkout.
