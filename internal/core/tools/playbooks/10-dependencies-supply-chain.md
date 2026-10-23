## Dependencies & supply chain

- **Known-vulnerable versions**: run the ecosystem's own auditor and read its output rather than
  guessing from the manifest — `npm audit`/`pnpm audit`/`yarn audit` for Node, `pip-audit` or
  `safety check` for Python, `cargo audit` for Rust, `govulncheck` for Go, `bundler-audit` for
  Ruby. Report the actual CVE, the affected version range, and the fixed version — not just "some
  dependencies are outdated."
- **Unpinned/floating versions**: a lockfile that is missing entirely, or a manifest using `^`/`*`
  ranges for a security-sensitive dependency (an auth library, a crypto library) rather than an
  exact or narrowly-pinned version.
- **Typosquatting / install-time code execution**: a dependency name that is a near-miss of a
  popular package, or a `postinstall`/`preinstall` script in a dependency that runs arbitrary code
  at install time — worth a second look when it appears in a dependency added recently.
- **Abandoned or unmaintained packages**: a security-relevant dependency with no release in years
  and open, unpatched vulnerability reports.
- **License risk** (report, don't block on it): a copyleft license (GPL/AGPL) pulled into code that
  will be distributed, which is a legal question for the user, not a security one — flag it and
  move on.

**How to check it**: prefer the project's own audit tool output to reading changelogs by hand; it is
faster and it is what the project's own CI (if any) is checking. If no lockfile exists, say that
first — it undermines every other finding in this category, since "the vulnerable version" cannot
be pinned down without one.
