import { listSessions, loadSession } from "@archymedes/core/cli/session";
import { sessionHolder } from "@archymedes/core/cli/session-lease";
import { resolveProvider } from "@archymedes/core/providers/agent-matrix";

/** Restore free access before constructing any agent; an explicit provider may override it. */
export async function resolveSessionProvider(environment: Record<string, string | undefined>, options: {
  root: string; resume?: string | null; provider?: string; model?: string;
}) {
  if (options.provider || !options.resume) return resolveProvider(environment, options);
  const id = options.resume === "latest" ? await newestNotOpen(options.root) : options.resume;
  const selection = id ? (await loadSession(options.root, id))?.modelSelection : undefined;
  return resolveProvider(environment, selection?.provider === "free"
    ? { provider: "free", model: options.model ?? selection.model } : options);
}

/** What `latest` resumes: the newest session no other terminal has open (session-lease.ts). */
async function newestNotOpen(root: string): Promise<string | undefined> {
  for (const { id } of await listSessions(root, 5)) if (!(await sessionHolder(root, id))) return id;
  return undefined;
}
