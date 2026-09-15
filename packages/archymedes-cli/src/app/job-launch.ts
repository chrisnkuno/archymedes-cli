import path from "node:path";
import { ArchymedesAgent } from "@archymedes/core/cli/agent";
import { screen } from "./transcript";
import { resolveSessionProvider } from "./session-provider";
import { createExaClient } from "@archymedes/core/providers/exa";
import { loadSettings, mergedEnvironment } from "../platform/settings";
import { appendJobLog, finishJob, getJob, jobLogPath } from "@archymedes/core";
import { runJobWorkerForever, workerId } from "../job-worker";
import { modelPriceCatalogFor } from "./providers";

/**
 * Starting the background job worker, detached or in this process.
 */

/**
 * Launches a job's worker as its own detached process.
 *
 * Detached and unreferenced, so it outlives this terminal closing — the entire point of a durable
 * job is that it does not depend on the process that queued it. Its own stdio is redirected to the
 * job's log file rather than inherited, since there is nobody left to read a shared stdout once
 * this process exits, and inheriting it would tie the child's lifetime to a pipe that goes away
 * with the parent.
 */
export async function spawnJobWorker(root: string, jobId: string): Promise<number | undefined> {
  const { spawn } = await import("node:child_process");
  const { openSync, mkdirSync } = await import("node:fs");
  const logFile = jobLogPath(root, jobId);
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  try {
    const child = spawn(process.execPath, [process.argv[1], "--archymedes-job-worker", root, jobId], {
      detached: true,
      stdio: ["ignore", fd, fd],
      cwd: root,
    });
    child.unref();
    return child.pid;
  } finally {
    const { closeSync } = await import("node:fs");
    closeSync(fd);
  }
}

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
