import type { Job, JobSummary } from "@archymedes/core/cli/jobs";
import type { GlyphSet } from "../text/glyphs";
import { INITIAL_TABLE_STATE, renderTable, type TablePaint } from "../ui/table";
import { buildJobsTable } from "../ui/tables";
import type { JobsCommand } from "./jobs-command";

type ApprovalDecision = Extract<JobsCommand, { kind: "approve" }>["decision"];

export type JobsContext = {
  listJobs(): Promise<JobSummary[]>;
  getJob(id: string): Promise<Job | undefined | null>;
  cancelJob(id: string): Promise<{ ok: boolean }>;
  resolveApproval(id: string, decision: ApprovalDecision, actionDigest: string): Promise<boolean>;
  startJob(objective: string): Promise<{ id: string }>;
  /** Signals the worker process that held the job, if it is still running. */
  signalWorker(pid: number): void;
  write(text: string): void;
  paint: TablePaint & { yellow(text: string): string };
  glyphs: GlyphSet;
  width: number;
};

/** `/jobs [run|cancel|approve]`: durable background work. */
export async function runJobsCommand(command: JobsCommand, context: JobsContext): Promise<void> {
  const { paint, write } = context;
  try {
    switch (command.kind) {
      case "invalid":
        write(paint.yellow(`  ${command.reason}\n`));
        return;
      case "list": {
        const jobs = await context.listJobs();
        if (jobs.length === 0) { write(paint.dim("  no background jobs — /jobs run <task>, /detach <task>, or /wander daily to start one\n")); return; }
        const listed = buildJobsTable(jobs, { paint, glyphs: context.glyphs });
        write(`${renderTable(listed.columns, listed.rows, INITIAL_TABLE_STATE, { paint, width: context.width, glyphs: context.glyphs, legend: "", cursor: false })}\n`);
        return;
      }
      case "run": {
        const job = await context.startJob(command.objective);
        write(`  ${paint.cyan("started")} job ${job.id} in the background. /attach ${job.id} to watch it.\n`);
        return;
      }
      case "cancel": {
        // The lease owner (host:pid) is cleared the moment the job is marked cancelled, so read it first.
        const before = await context.getJob(command.id);
        const { ok } = await context.cancelJob(command.id);
        if (!ok) { write(paint.yellow(`  No job ${command.id} to cancel — it may already be finished.\n`)); return; }
        const pid = Number(before?.lease?.workerId.split(":").pop());
        if (Number.isInteger(pid)) context.signalWorker(pid);
        write(`  cancelled ${command.id}.\n`);
        return;
      }
      case "approve": {
        // The id names a job, not an action: show the action and bind the decision to its digest,
        // so this never authorizes whatever the job happens to be asking for by the time it lands.
        const pending = (await context.getJob(command.id))?.pendingApproval;
        if (!pending) { write(paint.yellow(`  ${command.id} has no pending approval.\n`)); return; }
        write(paint.dim(`  ${command.decision === "deny" ? "denying" : "approving"}: ${pending.summary}\n`));
        const delivered = await context.resolveApproval(command.id, command.decision, pending.actionDigest);
        write(delivered ? "  delivered — the worker will pick it up shortly.\n" : paint.yellow("  that request changed before your answer arrived — nothing was authorized.\n"));
        return;
      }
    }
  } catch (error) {
    write(paint.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
  }
}
