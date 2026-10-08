import { describe, expect, it } from "vitest";
import { runRoutePlanCommand, type RoutePlanContext } from "./route-plan";

function context(plan: RoutePlanContext<string>["plan"]) {
  const written: string[] = [];
  const pending: Array<AbortController | undefined> = [];
  const ctx: RoutePlanContext<string> = {
    plan,
    onPendingRead: (controller) => { pending.push(controller); },
    render: (value) => `PLAN ${value}`,
    write: (text) => { written.push(text); },
    dim: (text) => text,
  };
  return { ctx, written, pending };
}

describe("runRoutePlanCommand", () => {
  it("plans the objective it was given and prints the rendered plan", async () => {
    const asked: string[] = [];
    const { ctx, written, pending } = context(async (objective) => { asked.push(objective); return "cheap-model"; });
    await runRoutePlanCommand("refactor the parser", ctx);
    expect(asked).toEqual(["refactor the parser"]);
    expect(written).toEqual(["PLAN cheap-model\n"]);
    // Registered for cancellation while it runs, and released afterwards.
    expect(pending[0]).toBeInstanceOf(AbortController);
    expect(pending.at(-1)).toBeUndefined();
  });

  it("says a direct provider has nothing to plan", async () => {
    const { ctx, written } = context(async () => null);
    await runRoutePlanCommand("", ctx);
    expect(written.join("")).toContain("needs the archymedes-cloud provider");
  });

  it("reports a failure with its reason, and releases the pending read", async () => {
    const { ctx, written, pending } = context(async () => { throw new Error("exchange offline"); });
    await runRoutePlanCommand("", ctx);
    expect(written.join("")).toContain("routing plan unavailable — exchange offline");
    expect(pending.at(-1)).toBeUndefined();
  });

  it("reports a cancellation as a cancellation, not as a failure", async () => {
    const { ctx, written, pending } = context((_objective, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const running = runRoutePlanCommand("", ctx);
    pending[0]!.abort();
    await running;
    expect(written).toEqual(["  routing plan cancelled\n"]);
  });
});
