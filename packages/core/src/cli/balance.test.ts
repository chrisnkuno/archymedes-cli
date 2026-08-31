import { describe, expect, it } from "vitest";
import { BalanceError, CRITICAL_BALANCE_USD, LOW_BALANCE_USD } from "./balance";

describe("balance thresholds", () => {
  it("keeps the critical floor below the low floor", () => {
    expect(CRITICAL_BALANCE_USD).toBeGreaterThan(0);
    expect(CRITICAL_BALANCE_USD).toBeLessThan(LOW_BALANCE_USD);
  });

  it("carries a named error type distinct from a plain Error", () => {
    const error = new BalanceError("nope");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("BalanceError");
  });
});
