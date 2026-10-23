## Access control

- **IDOR (insecure direct object reference)**: an endpoint takes an id (`/orders/:id`,
  `?userId=`) and fetches or mutates the record by that id alone, with no check that the
  authenticated caller actually owns or is permitted to see it.
- **Missing function-level authorization**: an admin or privileged action reachable by any
  authenticated (or unauthenticated) request because the check exists on the UI but not on the
  endpoint itself.
- **Mass assignment**: a create/update endpoint that binds the whole request body onto a model,
  letting a caller set fields it should never control (`role`, `isAdmin`, `price`, `ownerId`).
- **Privilege escalation via client-trusted state**: a role, tenant id, or permission read from a
  cookie, header, or request body that the client controls, rather than derived server-side from
  the authenticated session.
- **CORS misconfiguration**: `Access-Control-Allow-Origin: *` (or a reflected origin) combined
  with `Access-Control-Allow-Credentials: true` — the combination that lets any site read
  authenticated responses on a victim's behalf.
- **Multi-tenancy leaks**: a query missing a `WHERE tenant_id = ?`/`workspace_id = ?` clause that
  every sibling query includes — the single most common way one customer sees another's data.

**How to check it**: for every endpoint that takes an id or identifier, ask "what stops caller A
from passing caller B's id?" If the answer is "nothing but the UI doesn't offer it," that is a
finding.
