import { describe, expect, it } from "vitest";
import { BalanceWatch, assessTaskBalance, formatBalance } from "./balance";
import type { Balance } from "@archymedes/core/cli/balance";

const balanceOf = (amount: number, currency = "USD"): Balance => ({ amount, currency, asOf: Date.now() });

describe("formatting", () => {
  it("shows an amount in its own currency, the same way every time", () => {
    expect(formatBalance(5_000, "USD")).toContain("5,000");
    expect(formatBalance(1_234.5, "EUR")).toMatch(/1,234/);
  });
});

describe("assessing a task against the balance", () => {
  it("blocks when even the low estimate is above what remains", () => {
    const gate = assessTaskBalance(balanceOf(10), { low: 12, high: 20 });
    expect(gate?.blocked).toBe(true);
    expect(gate?.lines.join(" ")).toContain("cannot start");
  });

  it("warns without blocking when only the high estimate is above what remains", () => {
    const gate = assessTaskBalance(balanceOf(10), { low: 5, high: 15 });
    expect(gate?.blocked).toBe(false);
  });

  it("says nothing when the whole range fits", () => {
    expect(assessTaskBalance(balanceOf(100), { low: 5, high: 20 })).toBeUndefined();
  });

  it("speaks in the balance's currency", () => {
    const gate = assessTaskBalance(balanceOf(1_000, "INR"), { low: 1_200, high: 2_000 });
    expect(gate?.lines.join(" ")).toMatch(/₹|INR/);
  });
});

describe("BalanceWatch", () => {
  const watch = () => new BalanceWatch({ lowBalance: 2, criticalBalance: 0.5 });

  it("stays quiet while the balance is comfortable", () => {
    expect(watch().observe(balanceOf(50))).toBeUndefined();
  });

  it("warns once the balance is low, and not again immediately", () => {
    const w = watch();
    const first = w.observe(balanceOf(1.5), { now: 0 });
    expect(first?.kind).toBe("low");
    expect(w.observe(balanceOf(1.4), { now: 60_000 })).toBeUndefined();
  });

  it("escalates to critical below the critical floor", () => {
    expect(watch().observe(balanceOf(0.4))?.kind).toBe("critical");
  });

  it("reports an empty balance distinctly", () => {
    expect(watch().observe(balanceOf(0))?.kind).toBe("empty");
  });

  it("flags a rapid decline between two readings", () => {
    const w = watch();
    w.observe({ amount: 100, currency: "USD", asOf: 1 }, { now: 0 });
    const alert = w.observe({ amount: 60, currency: "USD", asOf: 2 }, { now: 5 * 60_000 });
    expect(alert?.kind).toBe("rapid");
  });

  it("ignores a stale reading that predates the last one", () => {
    const w = watch();
    w.observe({ amount: 10, currency: "USD", asOf: 100 }, { now: 0 });
    expect(w.observe({ amount: 1, currency: "USD", asOf: 50 }, { now: 1 })).toBeUndefined();
  });
});
