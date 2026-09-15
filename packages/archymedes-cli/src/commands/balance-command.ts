import type { Balance } from "@archymedes/core/cli/balance";
import type { Currency } from "@archymedes/core/money";
import type { CreditBalance } from "@archymedes/core/providers/credit-balance";
import { formatBalance, renderBalance, renderHostedBalance, type ManualBalanceCommand } from "./balance";

type Paint = (text: string) => string;

export type BalanceCommandContext = {
  display: Currency;
  /** The hosted exchange's real ledger, when the session is on it. */
  readHostedBalance?: (signal: AbortSignal) => Promise<CreditBalance | null>;
  /** Lets Ctrl+C cancel the network read; called with undefined when it ends. */
  onPendingRead(controller: AbortController | undefined): void;
  currentBalance(): Balance | undefined;
  persistBalance(next: Balance | undefined): Promise<string>;
  criticalBalance: number;
  sessionSpend(): number | undefined;
  now(): number;
  write(text: string): void;
  paint: { dim: Paint; yellow: Paint; green: Paint };
};

/**
 * `/balance [amount [currency] | clear]`. On the exchange the account's own ledger is what the next
 * turn reserves against, so it is read first and never confused with a locally tracked figure.
 */
export async function runBalanceCommand(command: ManualBalanceCommand, context: BalanceCommandContext): Promise<void> {
  const { paint, write } = context;
  if (command.kind === "invalid") { write(paint.yellow(`  ${command.reason}\n`)); return; }
  if (command.kind === "set") {
    const currency = command.currency ?? context.display;
    const next: Balance = { amount: command.amount, currency, asOf: context.now() };
    const file = await context.persistBalance(next);
    write(paint.green(`  Balance set to ${formatBalance(next.amount, currency)}. Archymedes will subtract each turn's measured cost from it.\n`));
    write(paint.dim(`  This is a local estimate, not a provider statement. Saved to ${file}; /balance clear stops tracking.\n`));
    return;
  }
  if (command.kind === "clear") {
    await context.persistBalance(undefined);
    write(paint.dim("  Balance tracking cleared. Set a new figure any time with /balance <amount>.\n"));
    return;
  }
  const local = context.currentBalance();
  if (context.readHostedBalance) {
    const reading = new AbortController();
    context.onPendingRead(reading);
    try {
      const credits = await context.readHostedBalance(reading.signal);
      if (credits) for (const line of renderHostedBalance(credits, { localCurrency: context.display })) write(`  ${line}\n`);
      else write(paint.yellow("  The exchange did not return a readable balance.\n"));
    } catch (error) {
      write(reading.signal.aborted ? paint.dim("  balance check cancelled\n") : paint.yellow(`  Could not read the hosted balance — ${error instanceof Error ? error.message : String(error)}\n`));
    } finally {
      context.onPendingRead(undefined);
    }
    // Both exist, so both are shown — labelled, never summed.
    if (local) write(paint.dim(`  Separately, you are tracking ${formatBalance(local.amount, local.currency)} locally as a pacing limit.\n`));
    return;
  }
  if (local) {
    for (const line of renderBalance(local, context.criticalBalance, { sessionSpend: context.sessionSpend() })) write(`  ${line}\n`);
    write(paint.dim("  Local estimate: the figure you set minus Archymedes's measured token costs. /balance <amount> resets it.\n"));
  } else {
    write(paint.dim("  No balance is being tracked. Use /balance <amount> [currency] to track one locally.\n"));
  }
}
