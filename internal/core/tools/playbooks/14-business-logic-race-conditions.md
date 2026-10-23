## Business logic & race conditions

Not a single OWASP category by name — the risks here are specific to what *this* application is
for, which is exactly why a generic scanner misses them and a careful read of the actual workflow
does not.

- **Time-of-check to time-of-use (TOCTOU) races**: a balance check followed by a deduction, a
  stock-quantity check followed by a decrement, or an "already used" check on a coupon/invite
  code — each as two separate steps with no lock, transaction, or atomic
  compare-and-set between them. Two concurrent requests can both pass the check before either
  applies its effect, doubling what should have been a single use. Grep for a read followed later
  by a write to the same record with no transaction/lock spanning both.
- **Workflow step skipping**: a multi-step process (checkout → payment → fulfillment,
  or signup → email verification → account active) where a later step's endpoint can be called
  directly without the earlier steps having actually completed, because the server trusts a client-
  supplied "step complete" flag instead of its own record of what happened.
- **Price, quantity or parameter manipulation**: a price, discount, or quantity value taken from
  the client and trusted rather than recomputed server-side from the actual catalog/rules — a
  request body edited to change `price` or `quantity` before submission.
- **Negative or overflow quantities**: a quantity or amount field with no lower bound (a negative
  purchase quantity that becomes a refund) or no upper bound (an integer overflow that wraps a
  huge number into a small or negative one).
- **Idempotency gaps on retried requests**: a payment, order-creation, or send-once operation with
  no idempotency key — a client retry (or an attacker replaying a captured request) after a slow
  or ambiguous response can execute the operation twice.

**How to check it**: walk the actual user-facing workflow end to end (not just individual
endpoints) and ask, at each step, "what does the server actually verify happened, versus what does
it just trust the client to say happened" — and for anything involving a shared counter or
balance, whether concurrent requests are excluded by a real lock or transaction.
