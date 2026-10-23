## API security

Aligned to the OWASP API Security Top 10 — worth its own pass on any service with a JSON/REST/
GraphQL/RPC API, because these risks are ranked differently than the general web list: authorization
failures dominate over injection here.

- **Broken object-level authorization (BOLA)**: the single most common API finding — an endpoint
  that takes an id (`/api/orders/:id`, a GraphQL field argument) and returns or mutates the
  record for *whatever id was passed*, checking only that the caller is authenticated, not that
  they own or are permitted to touch that specific object. Already covered under access control;
  named again here because on an API it is the default failure mode, not an edge case.
- **Broken function-level authorization (BFLA)**: an admin-only or elevated operation reachable by
  calling its endpoint directly with a non-admin token, because the check exists in the admin UI's
  routing but not in the API handler itself.
- **Broken object *property*-level authorization**: an endpoint that returns or accepts more
  fields than the caller should see or set — a user object response including a password hash or
  internal flag, or an update endpoint that accepts `role`/`isAdmin`/`balance` in the body
  because it binds the whole request onto the model (mass assignment).
- **Unrestricted resource consumption**: no limit on page size, no cap on a batch operation's
  array length, no request size limit, no timeout on an expensive query — any of which turns a
  single request into a denial-of-service, sometimes billed directly to the account (metered cloud
  resources, LLM token spend).
- **Unrestricted access to sensitive business flows**: an endpoint that is individually authorized
  correctly but has no rate limit or abuse detection on a flow worth protecting at the *business*
  level regardless — bulk account creation, a coupon-redemption endpoint, a "check if this email
  is registered" endpoint usable to enumerate users at scale.
- **Improper inventory management**: an old API version left reachable after a newer one shipped,
  a staging/internal endpoint reachable from the public internet, or an endpoint that exists only
  in the mobile app's compiled code with no corresponding entry in the documented API surface —
  "shadow" endpoints nobody is actively watching.
- **Unsafe consumption of third-party APIs**: a response from an external API trusted without
  validation — its data inserted into a database query, rendered as HTML, or used as a redirect
  target as if it had already been sanitized, when it is just as untrusted as any other input.

**How to check it**: enumerate every route/resolver, and for each one ask "what stops a caller
from acting on an id, field, or volume of requests they should not have"; a route with no such
check anywhere in its handler is the finding, not a hypothetical.
