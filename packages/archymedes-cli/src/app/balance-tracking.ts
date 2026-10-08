/**
 * The tracked account balance and the session's spend against it.
 *
 * The tracked balance is a figure the user sets with /balance, kept in the session's display
 * currency and drawn down by the measured cost of each turn. It is deliberately separate from
 * the session cap: the cap is a hard local guard, this is a soft "am I running low" watch.
 */
import { CRITICAL_BALANCE_USD, LOW_BALANCE_USD, type Balance } from "@archymedes/core/cli/balance";
import type { SessionRecord } from "@archymedes/core/cli/session";
import { catalogPrices } from "@archymedes/core/providers/agent-matrix";
import { convertTo, fromUnits, isCurrency, toUnits, type FxRate } from "@archymedes/core/money";
import { BalanceWatch, formatBalance } from "../commands/balance";
import { saveSettings } from "../platform/settings";
import { priceSessionModelTurns, readSessionModelTurns } from "../session/resumed-spend";
import type { Environment, SessionState } from "./session-state";
import { out, style } from "./transcript";

export type BalanceTracking = ReturnType<typeof createBalanceTracking>;

export function createBalanceTracking(options: {
  root: string;
  environment: Environment;
  processEnvironment: Environment;
  rates: FxRate[];
  state: Pick<SessionState, "display" | "savedSettings" | "manualBalance" | "ledger" | "spec" | "prices" | "resolvedModelId">;
}) {
  const { environment, processEnvironment, rates, state } = options;
  const usdInDisplay = (usd: number): number => {
    const converted = convertTo(fromUnits(usd, "USD"), state.display, rates);
    return converted ? toUnits(converted) : usd;
  };
  const configuredLowBalance = Number(environment.ARCHYMEDES_LOW_BALANCE);
  const configuredCriticalBalance = Number(environment.ARCHYMEDES_CRITICAL_BALANCE);
  const lowBalance = Number.isFinite(configuredLowBalance) && configuredLowBalance >= 0 ? configuredLowBalance : usdInDisplay(LOW_BALANCE_USD);
  const criticalBalance = Number.isFinite(configuredCriticalBalance) && configuredCriticalBalance >= 0 ? configuredCriticalBalance : usdInDisplay(CRITICAL_BALANCE_USD);
  const balanceWatch = new BalanceWatch({ lowBalance, criticalBalance });

  const parseManualBalance = (value: string | undefined, currencyValue?: string): Balance | undefined => {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount < 0) return undefined;
    const currency = currencyValue?.trim().toUpperCase();
    return { amount, currency: currency && isCurrency(currency) ? currency : state.display, asOf: Date.now() };
  };
  const currentBalance = (): Balance | undefined => state.manualBalance;
  const persistManualBalance = async (next: Balance | undefined): Promise<string> => {
    const savedSettings = state.savedSettings;
    if (next === undefined) {
      delete savedSettings.ARCHYMEDES_ACCOUNT_BALANCE;
      delete savedSettings.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY;
    } else {
      savedSettings.ARCHYMEDES_ACCOUNT_BALANCE = String(next.amount);
      savedSettings.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY = next.currency;
    }
    const file = await saveSettings(state.savedSettings, processEnvironment);
    state.manualBalance = next;
    if (next === undefined) {
      delete environment.ARCHYMEDES_ACCOUNT_BALANCE;
      delete environment.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY;
    } else {
      environment.ARCHYMEDES_ACCOUNT_BALANCE = String(next.amount);
      environment.ARCHYMEDES_ACCOUNT_BALANCE_CURRENCY = next.currency;
    }
    return file;
  };
  const sessionSpend = (): number | undefined => {
    const total = state.ledger.displayTotal;
    return total ? toUnits(convertTo(total, state.display, rates) ?? total) : undefined;
  };

  const balanceHeader = (): { full: string; compact: string } => {
    const balance = currentBalance();
    if (!balance) return { full: "", compact: "" };
    const paintBalance = balance.amount < criticalBalance ? style.red : balance.amount <= lowBalance ? style.yellow : style.green;
    const text = formatBalance(balance.amount, balance.currency);
    return { full: `${style.dim("balance")} ${paintBalance(text)}`, compact: paintBalance(`~${text}`) };
  };
  const checkBalance = async (silent = false): Promise<void> => {
    const balance = currentBalance();
    if (!balance) return;
    const alert = balanceWatch.observe(balance, {
      sessionSpend: sessionSpend(),
      sessionTurns: state.ledger.history.length,
      silent,
    });
    if (alert) for (const line of alert.lines) out.write(`  ${style.yellow(line)}\n`);
  };

  /**
   * Tells the current tab's ledger what the session being resumed has already spent.
   *
   * Without this a budget is a per-process cap wearing a per-session label: the ledger the cap is
   * checked against starts this process at zero, so every resume hands back the whole allowance.
   * Rebuilt from the session's event journal rather than read off the record — see
   * `resumed-spend.ts` for why the record's own running total is not a currency. Reads `ledger`
   * and `prices` at call time rather than capturing them, because switching tabs replaces both.
   */
  const carryResumedSpend = async (record: SessionRecord): Promise<void> => {
    const turns = await readSessionModelTurns(options.root, record.id).catch((error: unknown) => {
      // A journal that fails its integrity check is a reason to distrust the figure, not to
      // invent one. Say so: a budget silently starting over is the failure this exists to prevent.
      out.write(style.yellow(`  Could not read this session's earlier spend (${error instanceof Error ? error.message : String(error)}); the budget below counts only this run.\n`));
      return null;
    });
    if (!turns || turns.length === 0) return;
    const { spent, unpriced } = priceSessionModelTurns(turns, {
      display: state.display,
      rates,
      // The catalog first, since it knows what each model the session actually used costs; the
      // current session's own rate card only as a fallback for a model it has never heard of.
      pricesFor: (model) => catalogPrices(state.spec.id, model) ?? (model === state.resolvedModelId ? state.prices : undefined),
    });
    if (unpriced.length > 0) {
      out.write(style.yellow(`  No published rate for ${unpriced.join(", ")}; this session's earlier spend is counted as at least what is shown.\n`));
    }
    if (spent && spent.micros > 0) state.ledger.carryForward(record.id, spent);
  };

  return { lowBalance, criticalBalance, balanceWatch, parseManualBalance, currentBalance, persistManualBalance, sessionSpend, balanceHeader, checkBalance, carryResumedSpend };
}
