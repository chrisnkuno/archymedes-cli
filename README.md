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

One OpenAI-compatible client drives every provider except Anthropic, each with a default host you
can override with `<PROVIDER>_BASE_URL`:

| Provider | Key | Default model |
| --- | --- | --- |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.6-terra` |
| Google Gemini | `GOOGLE_API_KEY` | `gemini-2.5-pro` |
| xAI Grok | `XAI_API_KEY` | `grok-4` |
| DeepSeek | `DEEPSEEK_API_KEY` | `deepseek-chat` |
| Mistral | `MISTRAL_API_KEY` | `mistral-large-latest` |
| Groq | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| Ollama (local) | — | `llama3.1` |
| OpenAI-compatible | `OPENAI_COMPATIBLE_API_KEY` + `OPENAI_COMPATIBLE_BASE_URL` | your choice |

Set `<PROVIDER>_MODEL` to pick a model; the defaults are conservative and recorded once.

## Cost and balance

Costs are shown in your local currency (`--location`, `--currency`, or auto-detected). `/balance`
tracks a spend figure you set — in that currency or an explicit one (`/balance 50 usd`) — and
subtracts each turn's measured cost from it, warning as it runs low. There is no hosted wallet.

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

## Contributing

See `CONTRIBUTING.md`. Commits are signed off under the [DCO](https://developercertificate.org/)
(`git commit -s`); there is no CLA.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`. The Apache license does not grant rights to the
"Archymedes" name or marks — see `TRADEMARK.md`.
