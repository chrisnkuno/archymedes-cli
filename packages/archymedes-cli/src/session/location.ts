import path from "node:path";

/**
 * Where a piece of work runs, and how that reads in prose.
 */

/** Where a piece of work actually runs: this machine, a throwaway remote sandbox, or a container. */
export type SandboxBackend = "local" | "e2b" | "docker";

/** How a tab's location reads in prose — the answer to "where are these edits landing?". */
export function describeLocation(backend: SandboxBackend): string {
  if (backend === "e2b") return "in a remote E2B sandbox";
  if (backend === "docker") return "in a local container";
  return "on this machine";
}
