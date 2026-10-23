## Input validation, fuzzing & invariant-based testing

Validation and testing are the same discipline pointed in two directions: one rejects bad input at
the boundary, the other proves the code behaves correctly across the input space rather than on
the one example that was hand-picked for it.

**Boundary validation**:
- Every value crossing a trust boundary (a request body, a query string, a file upload, an
  environment variable, a message off a queue) is checked for type, length, range and shape before
  use — not implicitly coerced and trusted.
- File uploads: content-type and magic bytes checked (not just the filename extension), a size
  cap enforced, and the file never executed or served from a location that lets it be requested as
  a script.
- Numeric input: integer-overflow and negative-value cases considered wherever a quantity feeds a
  loop bound, an allocation size, or a price/balance calculation.

**Invariant-based testing** — assert what must hold for *every* valid input, not one example:
- **Round-trip**: `decode(encode(x)) == x` for every serializer/parser pair in the project.
- **Idempotence**: calling the same operation twice with the same input produces the same result
  the second time as the first (critical for retried network calls and queue consumers).
- **Conservation**: a total that must balance before and after an operation (money moved between
  accounts, items moved between inventories) — assert the sum is unchanged, not just that each side
  looks plausible.
- **Ordering/monotonicity**: a value that must never decrease (a version counter, a timestamp used
  for ordering) or a sort that must remain stable under a documented tie-break rule.
- **Error-path invariants**: a malformed, oversized, empty, or wrong-type input must fail the same
  way every time — not sometimes throw, sometimes silently coerce, sometimes hang.

**Fuzzing** — when a function parses, deserializes, or otherwise transforms untrusted bytes/text:
- Identify the parsing/deserialization entry points first; those are where a fuzzer earns its
  keep, not business logic that only ever sees already-validated data.
- Use the ecosystem's property-based/fuzz tooling rather than hand-rolling one: `fast-check` or
  `jsverify` for JS/TS property tests, Python's `hypothesis`, Rust's `cargo fuzz`/`proptest`, Go's
  built-in `testing/quick` and native fuzzing (`go test -fuzz`), `AFL++`/`libFuzzer` for C/C++.
  Wire it into the project's existing test runner rather than adding a second one.
- Seed the corpus from real captured inputs (a saved request body, a real file the app parses) —
  a fuzzer starting from nothing spends most of its budget rediscovering syntax the seed would
  have given it for free.
- A crash, hang, or unbounded-memory input the fuzzer finds is a finding on its own, independent of
  whether it is exploitable yet — an unhandled panic on attacker-controlled input is a denial-of-
  service at minimum.

**How to check it**: for the invariant categories above, look for what tests already exist and
whether they assert a property or just one example value; propose the missing property test with a
concrete counterexample where you can construct one, not just "add more tests."
