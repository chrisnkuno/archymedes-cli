import { resolveSessionProvider } from "../setup/session-provider";
import { createExaClient } from "@archymedes/core/providers/exa";
import { loadSettings, mergedEnvironment } from "../platform/settings";
import { appendJobLog, finishJob, getJob } from "@archymedes/core";
import { runJobWorkerForever, workerId } from "./job-worker";
import { modelPriceCatalogFor } from "../cli/providers";

/**
 * The process a spawned job runs as.
 *
 * Everything above `main()` in this file assumes a person is at a terminal: a readline loop, a
 * status bar, approval prompts. None of that exists here — this branch runs the same `ArchymedesAgent`
 * loop headlessly and reports through the job store instead of the screen, which is the entire
 * difference between a foreground turn and a background one.
 */
export async function runJobWorkerProcess(root: string, jobId: string): Promise<number> {
  const savedSettings = await loadSettings(process.env as Record<string, string | undefined>);
  const environment = mergedEnvironment(savedSettings, process.env as Record<string, string | undefined>);
  const job = await getJob(root, jobId);
  const resolved = await resolveSessionProvider(environment, { root, resume: job?.sessionId, ...job?.modelSelection });
  if ("error" in resolved) {
    await appendJobLog(root, jobId, `✗ ${resolved.error}`).catch(() => undefined);
    await finishJob(root, jobId, workerId(), "failed", { error: resolved.error }).catch(() => undefined);
    return 1;
  }

  let cancel: (() => void) | undefined;
  // /jobs cancel sends SIGTERM to this pid; a live turn needs the same clean interrupt Ctrl+C gives
  // an interactive one, not the process simply vanishing mid-write.
  const onSignal = () => cancel?.();
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);
  try {
    const outcome = await runJobWorkerForever({
      root,
      jobId,
      provider: resolved.provider,
      prices: modelPriceCatalogFor(resolved.prices, false),
      search: createExaClient(environment),
      onAgentReady: (agent) => { cancel = () => agent.cancel(); },
    });
    return outcome.outcome === "failed" ? 1 : 0;
  } finally {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }
}
