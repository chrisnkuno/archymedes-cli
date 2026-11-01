# Contributing

Thanks for helping. A few ground rules keep this maintainable.

## Before a PR

- `bun install`
- `bun run typecheck` — clean
- `bun run test` — the full vitest suite stays green
- New behaviour comes with invariant-style tests, not just a passing build.
- Match the surrounding code: comment density, naming, and idiom.

## Contributor License Agreement and DCO

Contributions need both:

1. **The CLA** ([`CLA.md`](CLA.md), currently a draft under counsel review). On your first pull
   request the CLA check asks you to sign by commenting the sentence it shows; that covers all your
   future contributions. Contributing for your employer? Ask for the entity form (Part B) first.
   You keep ownership of your work; the CLA licenses it to Archymedes, Inc., including patents and
   the right to relicense, so the project can stay open source and be defended.
2. **The [DCO](https://developercertificate.org/)** on every commit, certifying you wrote the change
   or have the right to submit it:

   ```
   git commit -s -m "your message"
   ```

   which adds a `Signed-off-by: Your Name <you@example.com>` line. Unsigned commits will be asked
   to amend.

## License of contributions

Friday is, and stays, open source under the Apache License, Version 2.0 (see LICENSE). Your
contribution is distributed under that license, and licensed to Archymedes, Inc. on the terms of
the CLA. The names "Friday" and "Archymedes" are covered by [`TRADEMARK.md`](TRADEMARK.md), not by
the code license.

## Scope

Provider adapters, translations, bug fixes and focused features are welcome. For a large or
architectural change, open an issue first so we can agree the shape before you build it.
