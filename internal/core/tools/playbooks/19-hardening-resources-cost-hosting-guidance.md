## Hardening resources, cost & hosting guidance

A finding without a realistic path to fixing it is a report nobody acts on. Once you have real
findings, close the review by telling the user *what it actually takes to fix them* — grounded in
this project, not a generic checklist.

- **Read what this project actually runs on before recommending anything.** A Dockerfile, compose
  file, Terraform/CloudFormation/Pulumi source, `vercel.json`, `fly.toml`, a Kubernetes manifest,
  or a CI workflow all say where this project is actually deployed. Recommend the tool or practice
  that fits that target — a managed secret manager for a project already on the cloud provider that
  offers one, a `.env` + `git-crypt`/`sops` pattern for one that deploys from a single box, a
  reverse-proxy rate limit for one fronted by nginx/Caddy already. A recommendation that assumes
  infrastructure the project does not have is not actionable.
- **Name specific resources, not categories.** "Add a WAF" is a category; "Cloudflare's free tier
  covers basic WAF rules for this domain, or `fail2ban` if this stays on a single VPS" is a
  resource the user can actually go get. Prefer free or already-configured-provider options first —
  the cheapest real fix beats an expensive ideal one nobody will buy.
- **Calculate cost when it is knowable.** For anything with a real price (a managed service, a
  paid scanning tool, additional compute for a hardened build step), give a concrete estimate — use
  `web_search` for current pricing rather than guessing, and show the arithmetic (unit price ×
  the project's actual scale) rather than a bare number so the user can sanity-check it against
  their own traffic or usage.
- **Call out the local-vs-cloud tradeoff explicitly when it is live.** If the project could harden
  the same gap either by self-hosting (more control, more operational burden, no recurring fee) or
  by adopting a managed/cloud service (less to run, a bill, a new trust boundary), say so as a real
  choice with its actual tradeoff for this project's size and team — not as a rule of thumb that
  applies to every project the same way.
- **Rank resourcing suggestions by the findings they close.** A recommendation that fixes the
  highest-severity finding on the list belongs first; do not let a cheap, easy suggestion crowd out
  the one that actually matters.
