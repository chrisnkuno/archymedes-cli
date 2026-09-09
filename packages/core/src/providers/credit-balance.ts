/**
 * The client's view of a hosted credit balance.
 *
 * This is not the locally tracked spend figure `/balance` has always kept. That number is something
 * the user typed to pace themselves; this one is the exchange's double-entry ledger reporting what
 * the account can actually spend. The two must never be added together or shown as one figure —
 * they answer different questions, and a total that mixes them is simply wrong.
 *
 * Three quantities matter and are easy to conflate, so they are kept apart here and in the
 * renderer:
 *
 *  - `availableMicros` — spendable right now.
 *  - `reservedMicros` — held against work that is in flight. Reserving moves credit *out* of the
 *    available figure, so this is neither spendable nor yet spent; unused reservation comes back.
 *  - `spentMicros` — settled and gone.
 *
 * Credits are closed-loop: usable for Archymedes services, not transferable and not withdrawable.
 * Nothing here should present them as stored value.
 *
 * As elsewhere in this directory the exchange is a network peer, so a malformed body parses to
 * `null` rather than throwing.
 */

export type CreditBalance = {
  accountId?: string;
  currency: string;
  /** Spendable now, exclusive of anything reserved. */
  availableMicros: number;
  /** Of the available figure, the part that came from promotional grants rather than purchase. */
  promotionalMicros?: number;
  purchasedMicros?: number;
  /** Held against in-flight work. Returns to available if the work costs less than its cap. */
  reservedMicros?: number;
  /** Settled lifetime spend on this account, in this currency. */
  spentMicros?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonNegativeInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Reads a `GET /v1/credits/balance` response, or returns null for anything that is not one.
 *
 * A balance without a currency or without a spendable figure is not a balance: showing "0" for a
 * response that never carried an amount would invent a fact about someone's money.
 */
export function parseCreditBalance(value: unknown): CreditBalance | null {
  if (!isRecord(value)) return null;
  const balance = isRecord(value.balance) ? value.balance : value;
  const currency = trimmedString(balance.currency);
  const available = nonNegativeInt(balance.micros ?? balance.availableMicros ?? balance.available_micros);
  if (!currency || available === undefined) return null;
  const promotional = nonNegativeInt(balance.promotionalMicros ?? balance.promotional_micros);
  const purchased = nonNegativeInt(balance.purchasedMicros ?? balance.purchased_micros);
  const reserved = nonNegativeInt(balance.reservedMicros ?? balance.reserved_micros);
  const spent = nonNegativeInt(balance.spentMicros ?? balance.spent_micros);
  return {
    ...(trimmedString(value.account_id ?? value.accountId) ? { accountId: trimmedString(value.account_id ?? value.accountId) } : {}),
    currency: currency.toUpperCase(),
    availableMicros: available,
    ...(promotional !== undefined ? { promotionalMicros: promotional } : {}),
    ...(purchased !== undefined ? { purchasedMicros: purchased } : {}),
    ...(reserved !== undefined ? { reservedMicros: reserved } : {}),
    ...(spent !== undefined ? { spentMicros: spent } : {}),
  };
}
