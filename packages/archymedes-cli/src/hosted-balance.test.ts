import { describe, expect, it } from "vitest";
import type { CreditBalance } from "@archymedes/core/providers/credit-balance";
import { renderHostedBalance } from "./balance";

const credits: CreditBalance = {
  accountId: "acct_7", currency: "USD", availableMicros: 4_250_000,
  purchasedMicros: 4_000_000, promotionalMicros: 250_000, reservedMicros: 5_000_000, spentMicros: 1_750_000,
};

describe("renderHostedBalance", () => {
  it("leads with what can be spent now", () => {
    expect(renderHostedBalance(credits)[0]).toBe("Archymedes credits USD 4.25 available");
  });

  it("explains reserved credit as held rather than spent", () => {
    const lines = renderHostedBalance(credits).join("\n");
    expect(lines).toContain("USD 5 is reserved against work in flight");
    expect(lines).toContain("held, not spent");
    expect(lines).toContain("Unused reservation returns");
  });

  it("never presents a total that adds available to reserved or spent", () => {
    // 4.25 + 5 + 1.75 = 11. A combined figure would be meaningless and alarming.
    expect(renderHostedBalance(credits).join("\n")).not.toContain("USD 11");
  });

  it("names promotional credit rather than passing a grant off as purchased", () => {
    expect(renderHostedBalance(credits).join("\n")).toContain("USD 0.25 in promotional credit");
  });

  it("says credits are closed-loop, every time", () => {
    expect(renderHostedBalance(credits).join("\n")).toContain("not transferable or withdrawable");
    expect(renderHostedBalance({ currency: "USD", availableMicros: 0 }).join("\n")).toContain("not transferable or withdrawable");
  });

  it("warns that an empty account cannot start a hosted turn", () => {
    expect(renderHostedBalance({ currency: "USD", availableMicros: 0 }).join("\n")).toContain("cannot reserve its cap");
  });

  it("shows the ledger's own currency and says so, instead of converting", () => {
    const lines = renderHostedBalance(credits, { localCurrency: "RWF" }).join("\n");
    expect(lines).toContain("USD 4.25");
    expect(lines).toContain("the currency the exchange reserves in");
    expect(lines).not.toContain("RWF 4.25");
  });

  it("stays quiet about a currency note when the display currency already matches", () => {
    expect(renderHostedBalance(credits, { localCurrency: "USD" }).join("\n")).not.toContain("reserves in");
  });

  it("omits figures the ledger did not report", () => {
    const lines = renderHostedBalance({ currency: "USD", availableMicros: 1_000_000 }).join("\n");
    expect(lines).not.toContain("reserved");
    expect(lines).not.toContain("settled");
  });
});
