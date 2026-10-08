/**
 * Jobs whose output is flowing into this session without owning the prompt.
 *
 * A watched job writes into a sink of its own, so it keeps producing while you work on something
 * else, and `/watch show` prints what it has said. That is the difference from `/attach`, which
 * is still here and still the way to *answer* a job — an approval is a question for a person, and
 * a question nobody is looking at is worse than a blocking prompt.
 */
import { enqueueJob, getJob, jobLogPath, newJobId, readJobLog } from "@archymedes/core";
import type { SandboxBackend } from "../session/location";
import type { WorkspaceController } from "../session/tabs";
import { TabSink } from "../terminal/output";
import { JobStream, WatchRegistry, sandboxWarning } from "../terminal/job-stream";
import { spawnJobWorker } from "./job-launch";
import type { SessionState } from "./session-state";
import type { TabPayload } from "./tab-switching";
import { glyphs, out, sessionStream, style } from "./transcript";

export function createBackgroundJobs(options: {
  root: string;
  backend: SandboxBackend;
  tabs: WorkspaceController<TabPayload>;
  state: Pick<SessionState, "model">;
}) {
  const { root } = options;
  const watched = new WatchRegistry();

  const startWatching = async (id: string, objective: string): Promise<void> => {
    if (watched.has(id)) { out.write(style.dim(`  already watching ${id}\n`)); return; }
    const sink = new TabSink(sessionStream);
    const stream = new JobStream({
      root,
      id,
      sink,
      readLog: (jobRoot, jobId, fromByte) => readJobLog(jobRoot, jobId, fromByte),
      readState: async (jobRoot, jobId) => {
        const job = await getJob(jobRoot, jobId);
        return job ? { status: job.status, ...(job.pendingApproval ? { pendingApproval: { summary: job.pendingApproval.summary } } : {}) } : undefined;
      },
      format: (line) => `${style.dim(`${id.slice(-6)} ${glyphs.boxVertical}`)} ${line}`,
      onApproval: (summary) => {
        // Written to the session, not to the job's own sink: an approval nobody reads is a job
        // stopped forever, so this is the one thing a background stream is allowed to interrupt with.
        out.write(`  ${style.yellow("approval needed")} ${style.dim(`${glyphs.middot} ${id}`)} ${summary}\n`);
        out.write(`  ${style.dim(`/attach ${id} to answer it`)}\n`);
      },
      onFinished: (status) => {
        out.write(`  ${status === "completed" ? style.green(status) : style.yellow(status)} ${style.dim(`${glyphs.middot} job ${id}`)} ${style.dim(`${glyphs.middot} /watch show ${id}`)}\n`);
      },
    });
    watched.add(id, { stream, sink, objective, startedAt: Date.now() });
    stream.start();
  };

  /** Enqueues a fresh (non-continuation) job and starts its worker — the shared tail of `/jobs run` and `/detach <task>`. */
  const startBackgroundJob = async (objective: string) => {
    // Said every time, because it changes where code executes: a job worker builds its own local
    // workspace and does not inherit this session's sandbox.
    const warning = sandboxWarning(options.tabs.size > 0 ? options.tabs.active.payload.backend : options.backend);
    if (warning) out.write(`  ${style.yellow(warning)}\n`);
    const id = newJobId();
    const job = await enqueueJob(root, { id, objective, logPath: jobLogPath(root, id), modelSelection: options.state.model.selection });
    await spawnJobWorker(root, job.id);
    // Watched from the moment it starts. A job you have to remember to subscribe to is a job whose
    // first minute — the part that usually explains the rest — is the part nobody ever sees.
    await startWatching(job.id, objective);
    return job;
  };

  return { watched, startWatching, startBackgroundJob };
}
