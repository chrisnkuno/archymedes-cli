## Client-side & browser security

The injection playbook above is server-side; this is what runs in the browser, where the attacker
is often another user's malicious input rendered back to a victim, not a request straight from the
attacker to the server.

- **Cross-site scripting (XSS)**: raw HTML insertion from anything user-controlled —
  `innerHTML`/`outerHTML`/`document.write` fed by a variable, React's `dangerouslySetInnerHTML`,
  Vue's `v-html`, a template engine's "raw"/"safe"/unescaped-output marker, or a URL/redirect
  target built from user input and inserted into an `href`/`src` (`javascript:` scheme abuse).
  A framework's default auto-escaping is a real mitigation — the finding is specifically where
  something opts out of it.
- **Stored vs. reflected vs. DOM-based**: stored (saved to a database and rendered to other users
  later — the highest-impact kind) is worth distinguishing from reflected (echoed straight back in
  the same response) and DOM-based (a client-side script reads something like `location.hash` and
  writes it into the page without ever touching the server) — the fix differs by kind.
- **CSRF**: a state-changing endpoint (anything that writes) with no CSRF token, no
  `SameSite=Lax/Strict` cookie, and no check of the `Origin`/`Referer` header — reachable by a
  form or fetch from any other site the victim happens to have open, riding their existing session
  cookie.
- **Clickjacking**: no `X-Frame-Options`/`frame-ancestors` (already listed under security
  misconfiguration, repeated here because it is specifically what stops a sensitive action page
  from being framed invisibly under a decoy UI).
- **Open redirect**: a redirect target taken from a request parameter with no allowlist, useful to
  an attacker as a trusted-looking link in a phishing email that starts on the real domain before
  bouncing.
- **Prototype pollution** (JavaScript/TypeScript specifically): a deep-merge, deep-clone, or
  object-assignment utility (hand-rolled, or an unpatched old version of `lodash`/similar) that
  does not guard against a key named `__proto__`, `constructor`, or `prototype` — can escalate
  from a data-only bug into arbitrary property injection across the whole process.
- **postMessage handling**: a `window.addEventListener("message", ...)` handler that does not
  check `event.origin` before trusting `event.data` — accepts instructions from any embedded or
  embedding frame, not just the one the app intended to talk to.

**How to check it**: find every place user-influenced data reaches the DOM without going through
the framework's default escaping, and every state-changing endpoint, then check each against the
specific gap above rather than a generic "sanitize input" pass.
