import { fromUnits, formatMoney, type Currency } from "@archymedes/core/money";
import { BalanceError, CRITICAL_BALANCE_USD, type Balance } from "@archymedes/core/cli/balance";

/** One formatter, so a quote and a header cannot disagree on how an amount reads. */
export function formatBalance(amount: number, currency: Currency): string {
  return formatMoney(fromUnits(amount, currency));
}

export { BalanceError, CRITICAL_BALANCE_USD };

export type BalanceAlert = {
  kind: "empty" | "critical" | "low" | "rapid";
  lines: string[];
};

export type TaskBalanceGate = {
  blocked: boolean;
  lines: string[];
};

/**
 * Compares a token-based task forecast with the tracked balance before the model sees the request.
 * The low end may block; the high end may only warn, because a forecast range is not a bill.
 */
export function assessTaskBalance(
  balance: Balance,
  estimate: { low: number; high: number },
): TaskBalanceGate | undefined {
  const remaining = formatBalance(balance.amount, balance.currency);
  if (estimate.low > balance.amount) {
    return {
      blocked: true,
      lines: [
        `This task cannot start with the current balance. Its conservative estimate begins at ${formatBalance(estimate.low, balance.currency)}, but ${remaining} remains.`,
        "Nothing was sent to the model. Raise the balance with /balance, use /slow, or ask for a smaller first step.",
      ],
    };
  }
  if (estimate.high > balance.amount) {
    return {
      blocked: false,
      lines: [
        `This task may need up to ${formatBalance(estimate.high, balance.currency)}, above the tracked ${remaining} balance.`,
        "You can keep control by using /slow, splitting the task, or raising the balance with /balance.",
      ],
    };
  }
  return undefined;
}

export type BalanceWatchOptions = {
  /** The low-balance floor, in the balance's own currency. */
  lowBalance: number;
  /** The critical floor, in the balance's own currency. */
  criticalBalance: number;
  /** Two readings inside this window may describe a rapid decline. */
  rapidWindowMs?: number;
  /** Ignore movements below this absolute size even when they are a large percentage. */
  minimumRapidDrop?: number;
  /** The fraction of the previous balance that counts as a rapid decline. */
  rapidDropFraction?: number;
  /** Do not repeat the same level of warning every turn. */
  repeatAfterMs?: number;
};

type BalanceObservation = { balance: Balance; observedAt: number };

/**
 * Turns balance readings into quiet, actionable notifications.
 *
 * The watcher never derives a balance from local spend on its own — friday.ts subtracts a
 * turn's measured cost and hands the new figure here. It compares two such figures and only uses
 * the session average to label an explicitly approximate runway.
 */
export class BalanceWatch {
  private previous: BalanceObservation | undefined;
  private lastAlert: { kind: BalanceAlert["kind"]; at: number } | undefined;
  private readonly options: Required<BalanceWatchOptions>;

  constructor(options: BalanceWatchOptions) {
    this.options = {
      rapidWindowMs: 30 * 60_000,
      minimumRapidDrop: 0.1,
      rapidDropFraction: 0.25,
      repeatAfterMs: 30 * 60_000,
      ...options,
    };
  }

  observe(
    balance: Balance,
    context: { sessionSpend?: number; sessionTurns?: number; now?: number; silent?: boolean } = {},
  ): BalanceAlert | undefined {
    const now = context.now ?? Date.now();
    const prior = this.previous;
    if (prior && balance.asOf < prior.balance.asOf) return undefined;
    this.previous = { balance, observedAt: now };
    if (context.silent) return undefined;

    const money = (amount: number) => formatBalance(amount, balance.currency);
    const averageTurn = context.sessionSpend && context.sessionTurns
      ? context.sessionSpend / context.sessionTurns
      : undefined;
    const turnsLeft = averageTurn && averageTurn > 0 ? Math.floor(balance.amount / averageTurn) : undefined;
    const isLow = balance.amount <= this.options.lowBalance || (turnsLeft !== undefined && turnsLeft <= 2);
    const drop = prior ? prior.balance.amount - balance.amount : 0;
    const elapsed = prior ? Math.max(0, now - prior.observedAt) : Number.POSITIVE_INFINITY;
    const rapid = Boolean(
      prior
      && elapsed <= this.options.rapidWindowMs
      && drop >= this.options.minimumRapidDrop
      && drop / Math.max(1e-9, prior.balance.amount) >= this.options.rapidDropFraction,
    );

    const kind: BalanceAlert["kind"] | undefined = balance.amount <= 0
      ? "empty"
      : balance.amount < this.options.criticalBalance
        ? "critical"
        : rapid
          ? "rapid"
          : isLow
            ? "low"
            : undefined;
    if (!kind) {
      this.lastAlert = undefined;
      return undefined;
    }
    if (this.lastAlert?.kind === kind && now - this.lastAlert.at < this.options.repeatAfterMs) return undefined;
    this.lastAlert = { kind, at: now };

    if (kind === "empty") {
      return {
        kind,
        lines: [
          "Balance watch: the tracked balance is spent.",
          "Nothing tops up automatically. Set a new figure with /balance <amount> when you choose.",
        ],
      };
    }
    if (kind === "critical") {
      return {
        kind,
        lines: [
          `Balance watch: only ${money(balance.amount)} remains — below the ${money(this.options.criticalBalance)} critical level.`,
          "Friday checks a task's estimate before sending it. Nothing tops up automatically; use /balance when you choose.",
        ],
      };
    }

    const runway = turnsLeft !== undefined
      ? ` At this session's average, that is about ${turnsLeft} more turn${turnsLeft === 1 ? "" : "s"}.`
      : "";
    if (kind === "rapid") {
      const minutes = Math.max(1, Math.round(elapsed / 60_000));
      const percent = prior ? Math.round((drop / Math.max(1e-9, prior.balance.amount)) * 100) : 0;
      return {
        kind,
        lines: [
          `Balance watch: down ${money(drop)} (${percent}%) in about ${minutes} min; ${money(balance.amount)} remains.${runway}`,
          "You are still in control: use /cost to review it, /slow to reduce the pace, or /balance when you choose.",
        ],
      };
    }
    return {
      kind,
      lines: [
        `Balance watch: getting low — ${money(balance.amount)} remains.${runway}`,
        "Use /cost to review spending, /slow to reduce the pace, or /balance to set a new figure.",
      ],
    };
  }
}
