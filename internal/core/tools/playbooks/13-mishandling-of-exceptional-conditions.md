## Mishandling of exceptional conditions

OWASP's newest 2025 category — the pattern underneath it is code that behaves correctly on the
happy path and then does something unsafe specifically *because* something else already went
wrong, which is why it survives so much testing: the tests that would catch it are the ones
nobody wrote.

- **Fail open on a security check**: an authorization, rate-limit, or validation check wrapped in
  a try/catch that, on any exception (a timeout calling an auth service, a malformed input the
  parser did not expect), falls through to *allowing* the action rather than denying it. Grep for
  a catch block near an auth/permission check and read what it does on failure.
  "`catch { return true; }`" next to a permission check is close to always a finding on its own.
- **Swallowed exceptions**: an empty catch block, or one that only logs, around code whose failure
  should have stopped the operation — the caller proceeds believing something succeeded (a payment
  was recorded, a file was written, a webhook was verified) when it did not.
- **Inconsistent error responses leaking information**: a login or lookup endpoint that returns a
  different error for "user does not exist" versus "wrong password" (or a different status code,
  or a different response time) — lets an attacker enumerate valid accounts one probe at a time
  even though each individual response looks like a refusal.
- **Retry and fallback logic bypassing a check**: a retry wrapper, a circuit breaker, or a
  fallback path that re-executes an operation without re-running the validation/authorization the
  first attempt had already passed through once — the retry path is the one nobody re-reviewed.
- **Partial failure left uncommitted or half-applied**: a multi-step operation (charge a card,
  then provision a resource) where a failure partway through leaves state inconsistent with no
  compensation or rollback, and the exceptional path was never exercised by a test.

**How to check it**: search for catch/except/rescue blocks near anything security-relevant —
authorization, payment, file/command execution — and read what each one does on failure, not just
whether one exists.
