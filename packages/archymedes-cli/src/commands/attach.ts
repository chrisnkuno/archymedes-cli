import type { Job } from "@archymedes/core/cli/jobs";

type Paint = (text: string) => string;

export type AttachContext = {
  getJob(id: string): Promise<Job | undefined | null>;
  readLog(id: string, offset: number): Promise<{ text: string; nextByte: number }>;
  resolveApproval(id: string, decision: "allow" | "deny", actionDigest: string): Promise<boolean>;
  isTerminal(status: Job["status"]): boolean;
  describe(job: Job): string;
  ask(question: string): Promise<string>;
  /** Replaces the session's Ctrl+C handling with `onInterrupt` until the returned function is called. */
  takeInterrupt(onInterrupt: () => void): () => void;
  sleep(ms: number): Promise<void>;
  write(text: string): void;
  paint: { dim: Paint; yellow: Paint };
};

/**
 * `/attach <id>`: follow a background job's log live, answering its approvals as they come. Ctrl+C
 * ends only the view; the job keeps running.
 */
export async function runAttach(id: string, context: AttachContext): Promise<void> {
  const { paint, write } = context;
  const first = await context.getJob(id);
  if (!first) { write(paint.yellow(`  No job ${id}. /jobs lists what exists.\n`)); return; }
  write(paint.dim(`  attached to ${id} (${context.describe(first)}) — Ctrl+C returns to the prompt without stopping it\n`));
  let detached = false;
  const release = context.takeInterrupt(() => { detached = true; });
  try {
    let offset = 0;
    for (;;) {
      const chunk = await context.readLog(id, offset);
      if (chunk.text) write(chunk.text);
      offset = chunk.nextByte;
      if (detached) break;
      const current = await context.getJob(id);
      if (!current) break;
      if (current.pendingApproval) {
        // The digest read here is the one shown; re-reading after the question would race a worker
        // that parked a different call meanwhile and silently redirect the answer onto it.
        const { summary, actionDigest } = current.pendingApproval;
        const answer = (await context.ask(`  ${paint.yellow("approval needed:")} ${summary} [y/N]: `)).trim().toLowerCase();
        const applied = await context.resolveApproval(id, answer === "y" || answer === "yes" ? "allow" : "deny", actionDigest);
        if (!applied) write(paint.yellow("  That request changed before your answer arrived — nothing was authorized.\n"));
        continue;
      }
      if (context.isTerminal(current.status)) { write(paint.dim(`  job ${current.status}\n`)); break; }
      await context.sleep(500);
    }
  } finally {
    release();
  }
}
