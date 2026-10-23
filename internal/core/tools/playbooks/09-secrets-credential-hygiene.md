## Secrets & credential hygiene

- **Hardcoded credentials**: API keys, database URLs with embedded passwords, private keys, or
  OAuth client secrets committed as string literals — not just in application code, but in test
  fixtures, seed scripts, CI config, and Dockerfiles (`ENV`/`ARG` with a real value).
  Recognizable shapes worth grepping for: `AKIA[0-9A-Z]{16}` (AWS access key), `ghp_[A-Za-z0-9]{36}`
  (GitHub token), `sk-[A-Za-z0-9]{20,}` (OpenAI/Anthropic-style key), `-----BEGIN (RSA|EC|OPENSSH)
  PRIVATE KEY-----`, `xox[baprs]-[0-9A-Za-z-]+` (Slack token), a JWT (`eyJ...` — decode it, it may
  itself embed a secret in a claim).
- **Secrets in history, not just HEAD**: a key that was committed and later removed is still live
  in git history and must be rotated, not just deleted from the current tree.
- **Client-exposed secrets**: a server-only secret bundled into frontend JS, a mobile app binary, or
  a public repository's CI logs (printed by an over-verbose build step).
- **.env handling**: a `.env` file that is not in `.gitignore`, or a `.env.example` that contains
  real values instead of placeholders.
- **Secret rotation and scope**: a key with far broader permissions than the one call site that uses
  it needs (an admin database credential used by a read-only reporting job).

**How to check it**: run `scan_secrets` first — it matches the shapes above deterministically and
masks whatever it finds, so its own report never puts a live credential in the transcript. It is a
pattern match, not proof: verify every finding by reading the surrounding code before reporting it
as real. Then check `.gitignore` actually covers every env/secret file the project uses. A scan
that only checks the current checkout misses history — say so explicitly rather than implying a
clean scan means a clean repo.
