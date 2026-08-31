# Contributing

Thanks for helping. A few ground rules keep this maintainable.

## Before a PR

- `bun install`
- `bun run typecheck` — clean
- `bun run test` — the full vitest suite stays green
- New behaviour comes with invariant-style tests, not just a passing build.
- Match the surrounding code: comment density, naming, and idiom.

## Developer Certificate of Origin

This project uses the [DCO](https://developercertificate.org/) instead of a CLA. Every commit
must be signed off, certifying you wrote the change or have the right to submit it under the
project's license:

```
git commit -s -m "your message"
```

which adds a `Signed-off-by: Your Name <you@example.com>` line. Unsigned commits will be asked
to amend.

## License of contributions

By contributing you agree your work is provided under the Apache License, Version 2.0 (see
LICENSE), and that you retain no additional rights beyond those the license grants.

## Scope

Provider adapters, translations, bug fixes and focused features are welcome. For a large or
architectural change, open an issue first so we can agree the shape before you build it.
