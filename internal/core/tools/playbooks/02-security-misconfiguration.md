## Security misconfiguration

OWASP's 2025 Top Ten moved this to #2 — misconfiguration now shows up in application testing more
often than any category except broken access control, and unlike a code-level bug it is often a
single wrong setting away from being fixed.

- **Debug/dev features left on in production**: a framework's debug mode (Django `DEBUG=True`,
  Flask `debug=True`, Rails `config.consider_all_requests_local`, a stack-trace-on-error page),
  an admin/debug endpoint with no auth (`/actuator`, `/debug`, `/_profiler`, a GraphQL
  introspection endpoint or playground exposed publicly), or verbose error responses that echo a
  stack trace, a query, or an internal path back to the caller.
- **Default and sample content**: default admin credentials never changed, sample apps or install
  scripts (`install.php`, `setup.jsp`) still deployed, a default TLS certificate, or a database
  left on its default port with its default account.
- **Missing security headers**: no `Content-Security-Policy`, `X-Content-Type-Options: nosniff`,
  `X-Frame-Options`/`frame-ancestors` (clickjacking), or `Strict-Transport-Security` on an
  HTTPS-only service. Absence is the common case worth naming, not a hypothetical.
- **Overly permissive CORS**: covered in depth under access control (SSRF/CORS with credentials),
  but also check for CORS enabled globally "to make the errors go away" rather than scoped to the
  origins that actually need it.
- **Directory listing and unintended exposure**: a web server serving directory indexes, a
  `.git`/`.svn` directory reachable over HTTP, a `.env`, backup file (`*.bak`, `*~`,
  `*.sql`), or editor swap file left inside the web root.
- **Unnecessary features and services enabled**: unused ports, sample plugins, verbose HTTP
  methods (`TRACE`, `OPTIONS` disclosing more than intended), or a dependency's optional
  features (an XML parser's external-entity support, a template engine's raw-eval mode) turned on
  without being used.
- **Cloud and platform defaults**: a storage bucket, queue, or managed database created with the
  provider's permissive default (public-read, no encryption at rest, no network restriction) and
  never tightened for what it actually holds.

**How to check it**: this is usually visible in one pass over config files, deployment manifests,
and framework settings, rather than something that needs deep call-graph tracing — read
`settings.py`/`.env.example`/`docker-compose.yml`/framework config top to bottom once.
