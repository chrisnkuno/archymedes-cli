# Releasing Friday

How a version of Friday is checked, built, published and recorded. Seven packages make one
release: `@archymedes/friday` and one binary package per platform.

- [What a release is](#what-a-release-is)
- [Before](#before)
- [Check](#check)
- [Build](#build)
- [Publish](#publish)
- [After](#after)

## What a release is

| Package | Holds | Built by |
| --- | --- | --- |
| `@archymedes/friday` | the launcher, the TypeScript agent, the docs; lists the six below as optional dependencies | `bun run build:packages` |
| `@archymedes/friday-<os>-<arch>` | the `friday` binary for one platform: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64` | `bun run build:go` |

npm installs only the binary package that fits the machine. All seven carry the same version.

## Before

1. The version is in `packages/friday-cli/package.json`, twice: `version`, and each
   `@archymedes/friday-*` entry of `optionalDependencies`. `build:go` refuses a mismatch.
2. Every workstream in the release is `done` in the [tracker](continuation/TRACKER.md), and a
   `## Release <version>` entry above them says what it brings, in words for people.
3. The documents say what the release does. `go test -run '^TestConform' ./...` holds them to the
   [documentation rules](mechanisms/README.md#8-documentation): links, names and numbers.

## Check

```bash
bun run release:check
```

It runs every TypeScript test (the terminal suites included), every Go test, the type check, and
the package build. It then installs the packed `@archymedes/friday` in a separate project and runs
the Go interface, the agent behind it, and what an install without the interface says. It ends by
printing the archive's SHA-256, which is also written beside it.

A test that fails once and passes alone is a flake: run it again three times
(`go test -count=3 -run <name> ./<package>`) and record it if it repeats.

## Build

```bash
bun run build:go
```

It builds the binary for all six platforms into `artifacts/npm/friday-<os>-<arch>/bin/`, with the
version from `package.json` (`friday --version` prints it). `release:check` builds only this
machine's. Build after the last change to Go code; a binary older than the source ships the old
code.

## Publish

The binary packages first, so the main package never names a version npm does not have:

```bash
for p in darwin-arm64 darwin-x64 linux-arm64 linux-x64 win32-arm64 win32-x64; do
  npm publish artifacts/npm/friday-$p --access public
done
npm publish artifacts/archymedes-friday-<version>.tgz --access public
```

Publish the archive `release:check` verified; do not build it again in between.

## After

1. In a new folder: `npm install -g @archymedes/friday@<version>`, then `friday --version` and
   `friday --help`.
2. Tag the release commit with its notes, and push the tag:
   `git tag -a v<version> -F <notes>`, then `git push origin v<version>`. The notes are the
   tracker's release entry, as a list of what changed for people.
