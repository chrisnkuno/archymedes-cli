import type { Balance } from "@archymedes/core/cli/balance";
import { describe, expect, it } from "vitest";
import { runBalanceCommand, type BalanceCommandContext } from "./balance-command";

function context(overrides: Partial<BalanceCommandContext> = {}) {
  const written: string[] = [];
  let stored: Balance | undefined;
  const pending: Array<AbortController | undefined> = [];
  const same = (text: string) => text;
  const ctx: BalanceCommandContext = {
    display: "USD",
    onPendingRead: (controller) => pending.push(controller),
    currentBalance: () => stored,
    persistBalance: async (next) => { stored = next; return "/cfg/balance.json"; },
    criticalBalance: 1,
    sessionSpend: () => undefined,
    now: () => 1_000,
    write: (text) => written.push(text),
    paint: { dim: same, yellow: same, green: same },
    ...overrides,
  };
  return { ctx, written, pending, stored: () => stored };
}

describe("/balance", () => {
  it("sets, shows and clears a locally tracked balance", async () => {
    const { ctx, written, stored } = context();
    await runBalanceCommand({ kind: "set", amount: 20 }, ctx);
    expect(stored()).toEqual({ amount: 20, currency: "USD", asOf: 1_000 });
    await runBalanceCommand({ kind: "show" }, ctx);
    expect(written.join("")).toContain("Local estimate");
    await runBalanceCommand({ kind: "clear" }, ctx);
    expect(stored()).toBeUndefined();
  });

  it("reads the hosted ledger first, clears the pending read, and reports a failure plainly", async () => {
    const failing = context({ readHostedBalance: async () => { throw new Error("offline"); } });
    await runBalanceCommand({ kind: "show" }, failing.ctx);
    expect(failing.written[0]).toContain("Could not read the hosted balance — offline");
    expect(failing.pending.at(-1)).toBeUndefined();
    const empty = context({ readHostedBalance: async () => null });
    await runBalanceCommand({ kind: "show" }, empty.ctx);
    expect(empty.written[0]).toContain("did not return a readable balance");
  });
});
