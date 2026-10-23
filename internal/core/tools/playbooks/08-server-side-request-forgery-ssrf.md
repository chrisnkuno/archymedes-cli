## Server-side request forgery (SSRF)

Consolidated into OWASP's Broken Access Control category for 2025, but worth its own checklist:
the trigger shape is distinct from a normal access-control bug, and it is the one that turns "the
server can reach a URL" into "the server can be made to reach a URL an attacker chose."

- **Any server-side fetch driven by user input**: a webhook URL, an "import from URL" feature, an
  avatar/image fetched by URL, a PDF/document converter that follows links, an RSS/feed reader, or
  a URL passed to an internal HTTP client, all count. Grep for `fetch(`, `axios.get(`,
  `requests.get(`, `urlopen(`, `http.Get(` fed by a request parameter rather than a constant.
- **The cloud metadata pivot**: an SSRF that can reach `169.254.169.254` (AWS/GCP/Azure instance
  metadata) can often retrieve the instance's own IAM credentials — this is the single highest-
  impact SSRF outcome and worth calling out by name whenever a fetchable-URL feature exists on a
  cloud-hosted service.
- **Internal network reach**: whether the vulnerable fetch can reach `localhost`, RFC1918 ranges,
  or internal-only services (an admin panel, a database's HTTP API, an internal microservice with
  no auth of its own because "only internal services call it").
- **Weak allowlisting**: a URL validator that checks the hostname string but not the resolved IP
  (DNS rebinding — the hostname resolves somewhere allowed at check time and somewhere internal at
  fetch time), or one that blocks by string match (`!url.includes("localhost")`) rather than
  parsing and checking the actual host/scheme/port.
- **Redirects**: whether the HTTP client used follows redirects by default — a URL that passes an
  allowlist check can still redirect to an internal address if the client follows the 3xx.

**How to check it**: find every place the server itself makes an outbound request whose target
came from a request, then check whether the target is validated against a real allowlist (parsed
host, not string match) with redirects disabled or re-validated per hop.
