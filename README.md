# Archymedes CLI

A coding agent that runs in your terminal — against your working tree, or inside an isolated
remote sandbox when the work shouldn't touch your machine.

```bash
npm install -g archymedes-cli
archymedes "fix the failing test in src/parser.ts"
```

Open source under the Apache License 2.0. Archymedes CLI began as a fork of the Nova coding agent
(MIT) and has since been rebranded end to end; see `NOTICE`.

## Providers

Direct providers use their native or OpenAI-compatible APIs. Archymedes Cloud instead sends a
capped request to the execution exchange, which selects the provider and returns a routing receipt:

| Provider | Key | Default model |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.6-terra` |
| Archymedes Cloud | `ARCHYMEDES_CLOUD_TOKEN` + `ARCHYMEDES_CLOUD_BASE_URL` | `auto` (policy routed) |
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.5-pro` |
| xAI Grok | `XAI_API_KEY` | `grok-4` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| Mistral | `MISTRAL_API_KEY` | `mistral-large-latest` |
| Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| Ollama (local) | — | `llama3.1` |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` | your choice |

Set `<PROVIDER>_MODEL` to pick a model; the defaults are conservative and recorded once.

## Cost and balance

For direct/BYOK providers, costs are shown in your local currency and `/balance` tracks a local
spend figure you set yourself. On `archymedes-cloud`, `/balance` instead reads the account's real
credit ledger: what is available now, what is reserved against work in flight, and what has settled.
The two are never combined — one is a pacing limit you chose, the other is money. Archymedes credits
are closed-loop: usable for Archymedes services, not transferable and not withdrawable.

When `archymedes-cloud` is selected, every model call reserves a configurable hard cap
(`ARCHYMEDES_CLOUD_MAXIMUM_MICROS`, default 5,000,000 USD micros); the exchange settles measured
usage and releases the remainder. Each hosted turn prints a routing receipt — the chosen model, the
alternatives weighed and why each was passed over, the policy it was held to, and the estimate
against the actual charge — and `/route` recalls them. `/route plan` asks the same question in
advance: what the next turn would be routed to and what the whole task would be expected to cost,
before any of it is spent. It calls no model and reserves nothing. `/route summary` shows session totals by currency, retries, route switches,
and calls without settlement data. `ARCHYMEDES_CLOUD_TASK_KIND` (coding,
design, architecture, security, research, deployment) tells the exchange what kind of work it is
routing. Billing and hosted execution are operated from isolated private services; this public
repository contains only their client contract.

## Languages

The control surfaces are localized into 16 languages — `archymedes --language <code>` or
`/settings`. See [`packages/archymedes-cli/I18N.md`](packages/archymedes-cli/I18N.md).

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `packages/archymedes-cli` | `archymedes-cli` | The terminal app and its `archymedes` binary. |
| `packages/core` | `@archymedes/core` | Provider-neutral agent runtime, model adapters, workspace backends, cost accounting. Internal CLI-only code lives under `src/cli/`. |
| `packages/archymedes-state` | `archymedes-state` (Rust) | The local, rebuildable history and memory index. Optional at runtime — the CLI falls back to a portable TypeScript projection. |
| `tooling/build` | — | Builds the packages into something npm can install. |

## Develop

```bash
bun install
bun run archymedes            # run the CLI from source
bun run test                  # vitest
bun run typecheck             # tsc --noEmit
bun run build:packages        # emit packages/*/dist
bun run build:state           # cargo build the Rust state binary (optional)
```

See [`docs/PLATFORM_STATUS.md`](docs/PLATFORM_STATUS.md) for repository ownership and integration
status. The authenticated hosted boundary is documented
in [`docs/EXCHANGE_API.md`](docs/EXCHANGE_API.md).

## Contributing

See `CONTRIBUTING.md`. Commits are signed off under the [DCO](https://developercertificate.org/)
(`git commit -s`); there is no CLA.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`. The Apache license does not grant rights to the
"Archymedes" name or marks — see `TRADEMARK.md`.


## Terminal identity and release checks

For the fixed workspace, run `archymedes --layout fixed` or switch with `/layout` mid-session.
The mode bar and composer stay anchored while the transcript scrolls. `/mode` opens a permission
picker, Ctrl+G opens the command menu, and Page Up / Page Down browse retained history.
Set `ARCHYMEDES_LAYOUT=fixed` to use it on every launch and `ARCHYMEDES_NO_MOTION=1` for still frames.
Try the actual interface offline with `bun run preview:workspace` (temporary project, local model fixture).

Archymedes now opens with a graduated-ring instrument and a bronze, limestone and olive palette. The input
composer and workspace follow the selected theme; light terminals retain parchment. Preview the
interface without credentials or model requests:

```bash
bun run preview:tui
bun run preview:tui parchment
bun run release:check
bun run bench:journeys
```

The release check validates the packed CLI in a separate consumer project. `bench:journeys`
drives the real terminal binary against a deterministic stub and times five installed journeys
(first prompt, first edit, verified turn, cancel, resume) on a small and a large repository,
writing `benchmarks/journeys/latest.json`. See the
[release assessment](docs/RELEASE_ASSESSMENT.md) for findings, priorities and publishing requirements.

## Continuing development

See the [agent handoff](docs/continuation/START_HERE.md), [architecture map](docs/continuation/ARCHITECTURE.md), and [prioritized roadmap](docs/continuation/PRIORITIES.md) for current work, validation status, and concrete follow-up tasks.
