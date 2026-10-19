import { describe, expect, it } from "vitest";
import { optionalInteger, optionalStringArray, requiredString } from "./tool-args";

describe("tool argument readers", () => {
  it("refuses an empty required string and a non-positive integer", () => {
    expect(requiredString("a", "path")).toBe("a");
    expect(() => requiredString("  ", "path")).toThrow(/path must be a non-empty string/);
    expect(optionalInteger(undefined, "limit")).toBeUndefined();
    expect(() => optionalInteger(0, "limit")).toThrow(/positive integer/);
  });

  it("reads an all-empty array as no filter", () => {
    expect(optionalStringArray(["", " "], "domains")).toBeUndefined();
    expect(optionalStringArray([" a "], "domains")).toEqual(["a"]);
    expect(() => optionalStringArray([1], "domains")).toThrow(/array of strings/);
  });
});
