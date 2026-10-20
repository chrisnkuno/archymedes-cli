import { describe, expect, it } from "vitest";
import { addModelUsage, emptyModelUsage, type ModelUsage } from "./model";

const usage = (n: number): ModelUsage => ({ inputTokens: n, outputTokens: 2 * n, totalTokens: 3 * n, cachedInputTokens: n, cacheWriteTokens: n, reasoningTokens: n });

describe("model usage arithmetic", () => {
  it("has empty usage as its identity", () => {
    expect(addModelUsage(usage(5), emptyModelUsage())).toEqual(usage(5));
    expect(addModelUsage(emptyModelUsage(), usage(5))).toEqual(usage(5));
  });

  it("adds every field, in any order and grouping", () => {
    expect(addModelUsage(usage(2), usage(3))).toEqual(usage(5));
    expect(addModelUsage(usage(2), usage(3))).toEqual(addModelUsage(usage(3), usage(2)));
    expect(addModelUsage(addModelUsage(usage(1), usage(2)), usage(3))).toEqual(addModelUsage(usage(1), addModelUsage(usage(2), usage(3))));
  });

  it("hands out a fresh empty value each time", () => {
    const first = emptyModelUsage();
    first.inputTokens = 9;
    expect(emptyModelUsage().inputTokens).toBe(0);
  });
});
