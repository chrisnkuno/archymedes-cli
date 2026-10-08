type Paint = (text: string) => string;

export type RoutePlanContext<Plan> = {
  /** Asks the exchange how it would route this objective; null on a direct provider. */
  plan(objective: string, signal: AbortSignal): Promise<Plan | null>;
  /** Lets Ctrl+C cancel the network read; called with undefined when it ends. */
  onPendingRead(controller: AbortController | undefined): void;
  render(plan: Plan): string;
  write(text: string): void;
  dim: Paint;
};

/**
 * `/route plan [objective]`. A preflight, not a turn: it calls no model, reserves nothing, and
 * leaves the conversation exactly as it was — so it stays interruptible and never becomes a way
 * to spend money.
 */
export async function runRoutePlanCommand<Plan>(objective: string, context: RoutePlanContext<Plan>): Promise<void> {
  const { write, dim } = context;
  const planning = new AbortController();
  context.onPendingRead(planning);
  let plan: Plan | null;
  try {
    plan = await context.plan(objective, planning.signal);
  } catch (error) {
    write(dim(planning.signal.aborted
      ? "  routing plan cancelled\n"
      : `  routing plan unavailable — ${error instanceof Error ? error.message : String(error)}\n`));
    return;
  } finally {
    context.onPendingRead(undefined);
  }
  if (plan === null) {
    write(dim("  /route plan needs the archymedes-cloud provider — a direct provider has one route\n"));
    return;
  }
  write(`${context.render(plan)}\n`);
}
