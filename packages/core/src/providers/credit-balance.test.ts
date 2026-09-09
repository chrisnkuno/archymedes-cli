import { describe, expect, it } from "vitest";
import { parseCreditBalance } from "./credit-balance";

/** What `GET /v1/credits/balance` returns: available is already exclusive of anything reserved. */
const wire = {
  account_id: "acct_7",
  balance: { currency: "USD", micros: 4_250_000, purchasedMicros: 4_000_000, promotionalMicros: 250_000, reservedMicros: 5_000_000, spentMicros: 1_750_000 },
};

describe("credit balance parsing", () => {
  it("keeps available, reserved and spent as three separate figures", () => {
    expect(parseCreditBalance(wire)).toEqual({
      accountId: "acct_7", currency: "USD", availableMicros: 4_250_000,
      purchasedMicros: 4_000_000, promotionalMicros: 250_000, reservedMicros: 5_000_000, spentMicros: 1_750_000,
    });
  });

  it("reads a bare balance object as well as the wrapped response", () => {
    expect(parseCreditBalance({ currency: "eur", micros: 10 })).toMatchObject({ currency: "EUR", availableMicros: 10 });
  });

  it("refuses to invent a figure for a response that carries none", () => {
    // Rendering "0 available" for a balance the service never stated is a claim about someone's
    // money that nothing in the response supports.
    expect(parseCreditBalance({ balance: { currency: "USD" } })).toBeNull();
    expect(parseCreditBalance({ balance: { micros: 100 } })).toBeNull();
    expect(parseCreditBalance({ balance: { currency: "USD", micros: -5 } })).toBeNull();
    for (const value of [null, undefined, 7, "USD 5", []]) expect(parseCreditBalance(value)).toBeNull();
  });

  it("keeps a zero balance, which is a fact, distinct from an absent one", () => {
    expect(parseCreditBalance({ balance: { currency: "USD", micros: 0 } })).toMatchObject({ availableMicros: 0 });
  });

  it("drops unusable optional figures rather than failing the whole balance", () => {
    const partial = parseCreditBalance({ balance: { currency: "USD", micros: 10, reservedMicros: "lots", spentMicros: Number.NaN } });
    expect(partial).toEqual({ currency: "USD", availableMicros: 10 });
  });
});
