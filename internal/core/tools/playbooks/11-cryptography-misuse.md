## Cryptography misuse

- **Weak or broken primitives**: MD5 or SHA-1 used for anything security-relevant (not just
  passwords — also file-integrity checks meant to detect tampering), DES/3DES/RC4 for encryption,
  ECB mode for a block cipher (it leaks plaintext structure).
- **Hardcoded or derived-from-nothing keys/IVs**: an encryption key or initialization vector that is
  a string literal, a hash of a short/predictable value, or reused across every encryption call
  instead of freshly random per operation (a reused IV/nonce is often a complete break, not a
  weakness).
- **Home-grown crypto**: any custom implementation of encryption, signing, or key derivation instead
  of a vetted library — this is close to always a finding on its own, regardless of how it looks.
- **Insecure randomness**: `Math.random()`, `rand()`, or another non-cryptographic PRNG used to
  generate a token, session id, password-reset code, or key, instead of the platform's CSPRNG
  (`crypto.randomBytes`, `secrets` module, `SecureRandom`).
- **TLS configuration**: certificate validation disabled (`rejectUnauthorized: false`,
  `verify=False`, a custom trust-everything `TrustManager`) — almost always committed as a
  "temporary" fix for a local dev cert problem and then shipped.

**How to check it**: grep for the primitive names above and for `random` used near anything named
token/session/key/nonce/salt. A finding here is usually a one-line fix (swap the function), so
propose the exact replacement, not just the diagnosis.
