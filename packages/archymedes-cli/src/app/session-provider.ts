import { listSessions, loadSession } from "@archymedes/core/cli/session";
import { resolveProvider } from "@archymedes/core/providers/agent-matrix";

/** Restore free access before constructing any agent; an explicit provider may override it. */
export async function resolveSessionProvider(environment: Record<string, string | undefined>, options: {
  root: string; resume?: string | null; provider?: string; model?: string;
}) {
  if (options.provider || !options.resume) return resolveProvider(environment, options);
  const id = options.resume === "latest" ? (await listSessions(options.root, 1))[0]?.id : options.resume;
  const selection = id ? (await loadSession(options.root, id))?.modelSelection : undefined;
  return resolveProvider(environment, selection?.provider === "free"
    ? { provider: "free", model: options.model ?? selection.model } : options);
}
