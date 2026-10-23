## Logging, monitoring & deterrence

Detection and deterrence matter as much as prevention: a system that is merely hard to break into
is not the same as one that notices when someone tries, slows them down while they do, and leaves
a record afterward.

- **Security-relevant events actually logged**: authentication success and failure, authorization
  denials, password/email/MFA changes, admin actions, and any input rejected by a validation check
  worth knowing was attempted. If none of these produce a log line, say so — it is the single
  biggest gap in most projects reviewed here.
- **Logs safe to keep**: no password, full token, credit-card number, or other secret ever written
  to a log line (including in a stack trace or an error message that echoes the request body).
- **Rate limiting as deterrence, not just protection**: login, password-reset, and any expensive or
  enumerable endpoint (an endpoint whose response differs for "user exists" vs "user does not")
  should be rate-limited per account and per IP — this is what turns a five-minute brute-force
  attempt into a multi-day one an attacker abandons.
- **Alerting on the events that matter**: a spike in authentication failures, a new admin account
  created, or a privilege escalation should be able to page someone, not just sit in a log nobody
  reads until after an incident.
- **Fail closed, not open**: when an auth check, a rate limiter, or a security-relevant dependency
  (an IAM/policy service, a WAF) is unreachable, the request should be denied, not silently allowed
  through "so the app stays up."
- **Deception as a deterrent** (worth suggesting, rarely worth insisting on): a honeytoken (a
  credential that should never be used, alerting the instant it is) planted where an attacker who
  has already gained some access would find it — cheap to add, and one of the highest-signal alerts
  a system can produce because a legitimate user never triggers it.
- **Response readiness**: is there a documented, current way to revoke a compromised credential,
  roll a leaked secret, or roll back a bad deploy quickly? A defense with no fast undo turns every
  incident into a slow one.

**How to check it**: read the logging/observability setup (or its absence) and the rate-limiting
middleware (or its absence) — this category is usually a smaller code surface than the others, and
often the fastest to give a complete answer on.
