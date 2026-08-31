import { fromUnits, formatMoney, type Currency } from "@archymedes/core/money";
import { BalanceError, CRITICAL_BALANCE_USD, type Balance } from "@archymedes/core/cli/balance";

/**
 * `/balance` — the command grammar and everything it prints.
 *
 * Split from the flow in archymedes.ts on purpose. This file is where the wording of a money
 * screen lives, and money wording is exactly the kind of thing that should be asserted in tests
 * rather than eyeballed once: an amount must be shown the same way in a warning and in the
 * running header, because a user comparing the two is checking whether the number moved.
 *
 * There is no gateway and no top-up. A balance is a figure the user sets, tracked locally in the
 * session's display currency and drawn down by the measured cost of each turn.
 */

export type ManualBalanceCommand =
  | { kind: "show" }
  | { kind: "set"; amount: number; currency?: Currency }
  | { kind: "clear" }
  | { kind: "invalid"; reason: string };

/** `/balance` sets, shows, or clears the locally tracked spend balance. */
export function parseManualBalanceCommand(input: string): ManualBalanceCommand | null {
  const match = /^\/balance(?:\s+([\s\S]*))?$/.exec(input.trim());
  if (!match) return null;
  const argument = (match[1] ?? "").trim();
  if (!argument) return { kind: "show" };
  if (/^(?:clear|off|none)$/i.test(argument)) return { kind: "clear" };

  // An optional trailing ISO currency: `/balance 50 usd`, `/balance 5000 inr`. Without one the
  // session's display currency is assumed.
  const parts = argument.split(/\s+/);
  let currency: Currency | undefined;
  if (parts.length > 1 && /^[A-Za-z]{3}$/.test(parts[parts.length - 1])) {
    currency = parts.pop()!.toUpperCase();
  }
  const cleaned = parts.join("").replace(/[,_\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    return { kind: "invalid", reason: "Use an amount, for example /balance 5000, /balance 50 usd, or /balance clear." };
  }
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e12) {
    return { kind: "invalid", reason: "That balance is outside the range this can track safely." };
  }
  return { kind: "set", amount, ...(currency ? { currency } : {}) };
}

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
 * The watcher never derives a balance from local spend on its own — archymedes.ts subtracts a
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
          "Archymedes checks a task's estimate before sending it. Nothing tops up automatically; use /balance when you choose.",
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

/** The balance, and the one thing worth saying about it. */
export function renderBalance(balance: Balance, criticalBalance: number, options: { sessionSpend?: number } = {}): string[] {
  const money = (amount: number) => formatBalance(amount, balance.currency);
  const lines = [`Balance ${money(balance.amount)}`];
  if (options.sessionSpend !== undefined && options.sessionSpend > 0) {
    lines.push(`This session has used ${money(options.sessionSpend)}.`);
  }
  if (balance.amount <= 0) lines.push("Set a new figure before the next turn: /balance 5000.");
  else if (balance.amount < criticalBalance) lines.push(`Critical balance: below ${money(criticalBalance)}. A demanding task may not be able to start.`);
  if (balance.amount > 0 && options.sessionSpend !== undefined && options.sessionSpend > 0 && balance.amount < options.sessionSpend) {
    lines.push("That is less than this session has already used — consider /balance before starting more work.");
  }
  return lines;
}
