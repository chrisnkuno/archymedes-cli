
/**
 * Where a piece of work runs, and how that reads in prose.
 */

/** Where a piece of work actually runs: this machine, a throwaway remote sandbox, or a container. */
export type SandboxBackend = "local" | "e2b" | "docker";
