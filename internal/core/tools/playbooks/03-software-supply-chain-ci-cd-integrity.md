## Software supply chain & CI/CD integrity

The dependencies playbook above is about *what versions are in the manifest*; this is about the
*pipeline that builds, tests and ships them* — its own OWASP Top Ten category for 2025, expanded
from "vulnerable and outdated components" specifically because the pipeline itself is now a
common attack target, not just what it happens to pull in.

- **Unpinned CI actions/steps**: a GitHub Actions workflow referencing a third-party action by a
  mutable tag (`uses: some/action@v3`) rather than a pinned commit SHA — the action's maintainer
  (or anyone who compromises their account) can change what that tag points to and it runs with
  whatever permissions the workflow has, silently, on the next build.
- **Overly broad CI permissions and secrets**: a workflow with `permissions: write-all` (or the
  implicit broad default) when it only needs read access, a publish token (npm, PyPI, container
  registry) with no scoping to the one package it needs to publish, or a secret exposed to a step
  that does not need it (a test job with deploy credentials in its environment).
- **Untrusted code running with trusted permissions**: a workflow triggered by
  `pull_request_target` (which runs with the base repo's secrets and permissions) that checks out
  and executes the PR's own code — lets an external contributor's PR exfiltrate secrets or push
  with the workflow's authority.
- **Missing build provenance**: no way to verify a published artifact was actually built by the
  claimed CI pipeline from the claimed source commit (no SLSA/provenance attestation, no signed
  release) — makes a compromised publish step or a stolen token indistinguishable from a real
  release after the fact.
- **Install-time code execution**: already covered under dependencies (a package's
  `postinstall` script), repeated here because CI is exactly where that script runs with the most
  ambient authority (registry tokens, deploy keys) and the least human observation.
- **Unreviewed auto-merge/auto-update**: a bot that auto-merges dependency-bump PRs with no
  human review and no CI gate that would actually catch a malicious version bump, versus one that
  merges only after tests *and* a diff review pass.

**How to check it**: read the CI/CD workflow files themselves (`.github/workflows/*.yml`,
`.gitlab-ci.yml`, etc.) for the permission and pinning gaps above — this is a small, finite set of
files on most projects and usually faster to fully cover than the application code itself.
