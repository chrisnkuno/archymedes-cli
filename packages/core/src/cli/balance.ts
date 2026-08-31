/**
 * The shape of a locally tracked spend balance, shared by the terminal and any other surface.
 *
 * Archymedes has no hosted wallet: a balance is a number the user sets with `/balance`, kept in
 * whatever currency their session displays costs in, and drawn down by the measured cost of each
 * turn. The type and the thresholds live here so the CLI's balance watcher and any other surface
 * cannot drift into disagreeing about what "low" means.
 */

import type { Currency } from "../money";

export type Balance = {
  /** The amount remaining, a plain number in `currency` (not micros). */
  amount: number;
  currency: Currency;
  /** Epoch ms this figure was set or last adjusted, so a stale reading can be shown as stale. */
  asOf: number;
};

/**
 * Where a balance stops being comfortable, and where it stops being usable.
 *
 * Recorded as USD reference amounts; the CLI converts them to the session's display currency with
 * the same dated FX rate it prices everything else with. A user can override the low threshold
 * outright with `ARCHYMEDES_LOW_BALANCE` (in the display currency).
 */
export const CRITICAL_BALANCE_USD = 0.5;
export const LOW_BALANCE_USD = 2;

export class BalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BalanceError";
  }
}
