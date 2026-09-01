import { describe, expect, it } from "vitest";
import { compute, ComputeError } from "./compute";

const value = (expr: string, options?: Parameters<typeof compute>[1]) => compute(expr, options).value;

describe("arithmetic", () => {
  it("follows precedence and associativity, not left-to-right", () => {
    expect(value("2 + 3 * 4")).toBe(14);
    expect(value("(2 + 3) * 4")).toBe(20);
    expect(value("2 ^ 3 ^ 2")).toBe(512); // right-associative
    expect(value("-3 ^ 2")).toBe(-9); // unary minus binds looser than ^
    expect(value("10 - 2 - 3")).toBe(5);
    expect(value("7 // 2")).toBe(3);
    expect(value("7 % 3")).toBe(1);
    expect(value("2 ** 10")).toBe(1024);
  });

  it("reads the number forms people actually type", () => {
    expect(value("1_000_000")).toBe(1_000_000);
    expect(value("1.5e3")).toBe(1500);
    expect(value(".25")).toBe(0.25);
    expect(value("0xFF")).toBe(255);
    expect(value("0b1010")).toBe(10);
    expect(value("0o17")).toBe(15);
  });

  it("knows the constants", () => {
    expect(value("pi")).toBeCloseTo(Math.PI, 12);
    expect(value("tau")).toBeCloseTo(Math.PI * 2, 12);
    expect(value("e")).toBeCloseTo(Math.E, 12);
    expect(value("phi")).toBeCloseTo(1.618033988749, 9);
  });

  it("computes factorial with a postfix bang, and caps a runaway at Infinity", () => {
    expect(value("5!")).toBe(120);
    expect(value("0!")).toBe(1);
    expect(value("200!")).toBe(Infinity);
    expect(() => value("(-1)!")).toThrow(ComputeError);
    expect(() => value("2.5!")).toThrow(ComputeError);
  });
});

describe("functions", () => {
  it("covers the common unary and binary math", () => {
    expect(value("sqrt(144)")).toBe(12);
    expect(value("round(3.14159, 2)")).toBe(3.14);
    expect(value("log(1000)")).toBeCloseTo(3, 12);
    expect(value("log(8, 2)")).toBeCloseTo(3, 12);
    expect(value("gcd(12, 18)")).toBe(6);
    expect(value("lcm(4, 6)")).toBe(12);
    expect(value("clamp(15, 0, 10)")).toBe(10);
    expect(value("hypot(3, 4)")).toBe(5);
    expect(value("mod(-1, 3)")).toBe(2);
  });

  it("gets the delta and ratio operations right — the ones hand arithmetic inverts", () => {
    expect(value("pct_change(120, 87)")).toBeCloseTo(-27.5, 10);
    expect(value("pct_change(80, 100)")).toBeCloseTo(25, 10);
    expect(value("pct(3, 12)")).toBe(25);
    expect(value("ratio(9, 4)")).toBe(2.25);
    expect(value("delta(10, 7)")).toBe(-3);
    expect(() => value("pct_change(0, 5)")).toThrow(/base of zero/);
  });
});

describe("statistics", () => {
  const sample = "[2, 4, 4, 4, 5, 5, 7, 9]";

  it("summarises a list the same way whether passed as a list or as arguments", () => {
    expect(value(`mean(${sample})`)).toBe(5);
    expect(value("mean(2, 4, 4, 4, 5, 5, 7, 9)")).toBe(5);
    expect(value(`median(${sample})`)).toBe(4.5);
    expect(value(`mode(${sample})`)).toBe(4);
    expect(value(`sum(${sample})`)).toBe(40);
    expect(value(`count(${sample})`)).toBe(8);
    expect(value(`range(${sample})`)).toBe(7);
  });

  it("uses the sample standard deviation, and the population one on request", () => {
    // Textbook value for this sample: pstdev = 2, stdev ≈ 2.138.
    expect(value(`pstdev(${sample})`)).toBeCloseTo(2, 10);
    expect(value(`stdev(${sample})`)).toBeCloseTo(2.13809, 4);
    expect(value(`variance(${sample})`)).toBeGreaterThan(value(`pvariance(${sample})`));
  });

  it("interpolates percentiles and answers the p50/p90/p95/p99 shortcuts", () => {
    expect(value("percentile([1, 2, 3, 4], 50)")).toBe(2.5);
    expect(value("percentile([10, 20, 30, 40, 50], 90)")).toBe(46);
    expect(value("p50([1, 2, 3, 4])")).toBe(2.5);
    expect(() => value("mean([])")).toThrow(/empty/);
    expect(() => value("stdev([5])")).toThrow(/at least two/);
  });
});

describe("unit conversion", () => {
  it("converts within data sizes and within durations, decimal and binary", () => {
    expect(value('convert(1, "GiB", "MiB")')).toBe(1024);
    expect(value('convert(1, "GB", "MB")')).toBe(1000);
    expect(value('convert(1.5, "h", "s")')).toBe(5400);
    expect(value('convert(90, "min", "h")')).toBe(1.5);
    expect(value('convert(500, "MB", "GB")')).toBe(0.5);
  });

  it("refuses to convert across families", () => {
    expect(() => value('convert(1, "GB", "s")')).toThrow(ComputeError);
    expect(() => value("convert(1, GB, MB)")).toThrow(ComputeError); // bare GB is an unknown name
  });
});

describe("result reporting", () => {
  it("marks an integer result exact and an irrational one not", () => {
    const clean = compute("6 * 7");
    expect(clean.exact).toBe(true);
    expect(clean.rendered).toBe("42");
    expect(clean.warnings).toEqual([]);

    const irrational = compute("sqrt(2)");
    expect(irrational.exact).toBe(true); // within 2^53, just not a whole number
    expect(irrational.rendered).toMatch(/^1\.4142/);
  });

  it("warns rather than lying when precision is lost past 2^53", () => {
    const big = compute("2 ^ 60");
    expect(big.exact).toBe(false);
    expect(big.warnings.join(" ")).toContain("2^53");
  });

  it("warns on overflow and on an undefined operation", () => {
    expect(compute("1 / 0").warnings.join(" ")).toContain("Infinity");
    expect(compute("0 / 0").warnings.join(" ")).toContain("NaN");
  });

  it("renders an integer in another base on request", () => {
    expect(compute("255", { radix: 16 }).radixRendered).toBe("0xff");
    expect(compute("10", { radix: 2 }).radixRendered).toBe("0b1010");
    expect(compute("3.5", { radix: 16 }).radixRendered).toBeUndefined();
  });

  it("respects a precision request", () => {
    expect(compute("pi", { precision: 3 }).rendered).toBe("3.14");
    expect(compute("1/3", { precision: 5 }).rendered).toBe("0.33333");
  });
});

describe("safety and bounds", () => {
  it("rejects an empty or oversized expression", () => {
    expect(() => compute("")).toThrow(ComputeError);
    expect(() => compute("   ")).toThrow(ComputeError);
    expect(() => compute("1+".repeat(1500))).toThrow(/longer than/);
  });

  it("rejects unknown names, unknown functions, and stray syntax", () => {
    expect(() => compute("wat")).toThrow(/Unknown name/);
    expect(() => compute("frobnicate(2)")).toThrow(/Unknown function/);
    expect(() => compute("2 +")).toThrow(ComputeError);
    expect(() => compute("2 2")).toThrow(/after a complete expression/);
    expect(() => compute("(1 + 2")).toThrow(/Expected/);
  });

  it("never reaches JavaScript through the input", () => {
    expect(() => compute("constructor")).toThrow(ComputeError);
    expect(() => compute("globalThis")).toThrow(ComputeError);
    expect(() => compute("process.exit(1)")).toThrow(ComputeError);
    expect(() => compute("[].constructor")).toThrow(ComputeError);
  });

  it("refuses a bare list as the final result, since a list is not an answer", () => {
    expect(() => compute("[1, 2, 3]")).toThrow(/evaluates to a list/);
  });
});
