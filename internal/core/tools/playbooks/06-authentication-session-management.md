## Authentication & session management

- **Password storage**: anything but a slow, salted hash (bcrypt, scrypt, argon2). MD5, SHA-1,
  SHA-256 alone, or a fixed/short salt are all findings.
- **Token comparison**: session tokens, API keys, HMAC signatures or password-reset tokens compared
  with `==`/`===`/`.equals` instead of a constant-time comparison — a timing side channel that
  lets an attacker recover the value byte by byte.
- **Session fixation**: a session id issued *before* login is still valid *after* login, instead of
  being rotated on privilege change.
- **Session/cookie flags**: cookies carrying a session or auth token missing `HttpOnly`, `Secure`,
  or a `SameSite` policy appropriate to the app (client-rendered SPA hitting a separate API domain
  is the one case `SameSite=None` is actually required, and then `Secure` is mandatory).
- **JWT handling**: `alg: none` accepted, the algorithm not pinned server-side (letting an RS256
  token be re-signed as HS256 using the public key as the HMAC secret), or the signature never
  actually verified before the claims are trusted.
- **Password reset / MFA**: a reset token that does not expire, is not single-use, or is
  predictable (sequential, timestamp-derived); an MFA flow whose second factor can be skipped by
  calling a later step directly.
- **Credential stuffing / brute force**: no rate limit or lockout on the login endpoint at all.

**How to check it**: find the login, session-creation, and token-verification code paths and read
them end to end — most findings here are "the check exists but a branch skips it," not "the check
is entirely missing."
