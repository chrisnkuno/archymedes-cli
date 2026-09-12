# Platform integration status

This public repository contains the CLI, local runtime, and authenticated hosted-client adapter.
Implementation status for private services is tracked in their private repositories; duplicating
those internals here would weaken the repository boundary.

| Track | Public integration state | Owning repository |
| --- | --- | --- |
| Protocol | Versioned schemas, conformance fixtures, and build artifacts published independently | `archymedes-protocol` (public) |
| Cloud model access | `archymedes-cloud` provider sends authenticated requests with hard per-call caps and policy metadata | `archymedes-cli` (public client), `archymedes-cloud` (private service) |
| Credits and payments | Public wire types only; ledger, settlement, webhooks, tax, fraud, and reconciliation are isolated | `archymedes-billing` (private) |
| Routing and provider health | Public receipt/policy formats; health telemetry, outcome models, learned weights, experiments, and margins are isolated | `archymedes-routing-intelligence` (private) |
| Jobs, messaging, and sync | Public job/message/encrypted-envelope formats; multi-tenant orchestration remains isolated | `archymedes-cloud` (private) |
| Core roles | Open manifests and registry published independently | `archymedes-role-packs` (public) |
| Defender | Open local engine contract and deterministic orchestration published independently | `archymedes-defender` (public) |
| Operations and premium knowledge | No implementation or data is present in public history | `archymedes-operations`, `archymedes-premium-packs` (private) |

## Hosted-beta release gates

Before accepting money or unattended work, the private services must prove concurrent ledger
correctness, webhook replay protection, refund and chargeback handling, exactly-once terminal job
outcomes, provider-invoice reconciliation, regional policy enforcement, backup restoration, worker
failure recovery, and user-visible export/deletion/refund behavior.
