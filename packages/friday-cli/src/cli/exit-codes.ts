/**
 * Terminal exit codes, stable across releases.
 *
 * Numbers are part of the contract: a caller branching on 4 must keep meaning "the work was not
 * verified" forever. Add new codes rather than repurposing these, and stay below 125 — the shell
 * reserves 126/127 for "cannot execute" and 128+n for signal deaths, so a code up there would be
 * indistinguishable from Archymedes never having run at all.
 */
export const EXIT_CODES = {
  completed: 0,
  /** An unexpected failure: a crash, a provider error, a malformed model turn. */
  failed: 1,
  /** The invocation itself was wrong — bad flags, no prompt, nothing configured. */
  usage: 2,
  /** The model refused, or a policy or human denied a required action. */
  blocked: 3,
  /** Workspace changed without passing verification evidence. */
  needs_verification: 4,
  /** An action needed a human decision, and headless mode has no one to ask. */
  needs_approval: 5,
  /** An iteration, tool-call or budget ceiling stopped the run. */
  limit: 6,
  /** Interrupted — SIGINT, or a cancellation requested by the caller. */
  cancelled: 7,
} as const;
