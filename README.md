# Archymedes CLI

A coding agent that runs in your terminal — against your working tree, or inside an isolated
remote sandbox when the work shouldn't touch your machine.

```bash
npm install -g archymedes-cli
archymedes "fix the failing test in src/parser.ts"
```

Archymedes CLI is a fork of the Archymedes coding agent, repackaged under its own name. The runtime,
internal module names, environment variables (`ARCHYMEDES_*`) and the project state directory (`.archymedes/`)
still carry the original name; only the published package, the `archymedes` binary and the
user-facing branding have been renamed so far.

## Layout

| Path | Package | What it is |
| --- | --- | --- |
| `packages/archymedes-cli` | `archymedes-cli` | The terminal app and its `archymedes` binary. |
| `packages/core` | `@archymedes/core` | Provider-neutral agent runtime, model adapters, workspace backends, cost accounting. |
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

## License

MIT. See `LICENSE`.
