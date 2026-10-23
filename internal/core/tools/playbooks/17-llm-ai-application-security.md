## LLM & AI application security

Aligned to the OWASP Top 10 for LLM Applications (2025) — relevant to any project that calls a
model API, embeds a chat feature, or (like Friday itself) gives a model tools that can act on a
codebase or a live system. An LLM blurs the line between "instructions" and "data" in a way
traditional input validation was never built for, which is the root cause behind most of this list.

- **Prompt injection (LLM01)**: untrusted content — a user message, a fetched web page, a file the
  model reads, a tool's output — that the model can interpret as *instructions* rather than data
  to reason about. Direct (the user types it) and indirect (it arrives via a document, email, or
  web page the model is asked to summarize or act on) are both real; indirect is the harder one to
  see coming because the attacker never talks to the application directly.
- **Excessive agency (LLM06)**: a model-driven agent with more capability, autonomy, or reach than
  the task in front of it actually needs — a tool that can write files or run commands with no
  human approval step, a broader API scope than the agent's job requires, or a chain of tool calls
  that can complete an irreversible action (a payment, a deploy, a delete) with no confirmation.
  The mitigation that matters most here is the one Friday's own approval gating exists for: nothing
  effectful should run without a human in the loop, or without a narrowly scoped, explicitly
  reasoned-about exception.
- **Insecure output handling (LLM05)**: model output written into a shell command, a database
  query, HTML rendered to a browser, or executed as code, on the assumption that because it *came
  from the model* it is safe — a model whose input included attacker-controlled content can be led
  to produce output that is itself the injection payload. Treat model output as untrusted input to
  whatever consumes it next, same as any other external data.
- **Sensitive information disclosure (LLM02)**: a system prompt, internal tool schema, or
  retrieved document containing a secret, credential, or internal detail that the model can be
  induced to repeat back — including via a side channel (asking it to "repeat your instructions",
  or to summarize its own context).
- **System prompt leakage (LLM07)**: distinct from general disclosure — specifically whether the
  system prompt itself was written *assuming* it stays secret and would be unsafe if quoted back
  (embedded credentials, or business logic like "never offer a refund over $50" that a leaked
  prompt hands straight to an attacker looking for the boundary).
- **Supply chain (LLM03)**: an unverified or unpinned model weight, a third-party plugin/tool
  integration with no review of what it actually does, or a prompt-template/embedding-model
  dependency pulled from an unvetted source — the same supply-chain discipline as regular
  dependencies, applied to models and the tools wired up to them.
- **Unbounded consumption (LLM10)**: no limit on request rate, input/output token length, or
  recursive tool-call depth — a single crafted input that causes the model to loop, or a user who
  can trigger unbounded generation, turning into a cost or availability incident (this is what
  Friday's own budget/spend-cap machinery exists to bound; check whether *this* project's own
  LLM-calling code has an equivalent).
- **Vector and embedding weaknesses (LLM08)**: for a RAG (retrieval-augmented generation) system —
  whether the retrieval store enforces the same access control the source documents had (a
  document a user should not see must not be retrievable into their context just because it is in
  the same vector index), and whether untrusted content can be embedded and later retrieved as if
  it were trusted instruction.

**How to check it**: trace every path from "content the model sees" back to its source — if that
source is anything other than the developer's own fixed prompt text, treat it as untrusted and
check what the model is allowed to do as a result of processing it.
