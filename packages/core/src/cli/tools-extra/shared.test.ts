import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_WORKSPACE_LIMITS, WorkspaceViolation } from "../workspace";
import {
  boundedInteger,
  directoryPrefix,
  oneOf,
  optionalString,
  requiredString,
  resolvedLimits,
  truncateText,
} from "./shared";

describe("argument validation", () => {
  it("requires a non-empty string and names the argument when it is missing", () => {
    expect(requiredString("src", "path")).toBe("src");
    expect(() => requiredString("  ", "path")).toThrow("path must be a non-empty string");
    expect(() => requiredString(3, "path")).toThrow("path must be a non-empty string");
  });

  it("treats an absent or blank optional string as not given, and rejects a non-string", () => {
    expect(optionalString(undefined, "ref")).toBeUndefined();
    expect(optionalString(null, "ref")).toBeUndefined();
    expect(optionalString("   ", "ref")).toBeUndefined();
    expect(optionalString("main", "ref")).toBe("main");
    expect(() => optionalString(1, "ref")).toThrow("ref must be a string");
  });

  it("clamps integers into range, falls back when absent and rejects fractions", () => {
    expect(boundedInteger(undefined, "limit", 20, 1, 100)).toBe(20);
    expect(boundedInteger(500, "limit", 20, 1, 100)).toBe(100);
    expect(boundedInteger(-4, "limit", 20, 1, 100)).toBe(1);
    expect(boundedInteger(42, "limit", 20, 1, 100)).toBe(42);
    expect(() => boundedInteger(1.5, "limit", 20, 1, 100)).toThrow("limit must be an integer");
    expect(() => boundedInteger("5", "limit", 20, 1, 100)).toThrow("limit must be an integer");
  });

  it("accepts only a listed value, with the fallback for an empty one", () => {
    const modes = ["short", "full"] as const;
    expect(oneOf(undefined, "mode", modes, "short")).toBe("short");
    expect(oneOf("", "mode", modes, "short")).toBe("short");
    expect(oneOf("full", "mode", modes, "short")).toBe("full");
    expect(() => oneOf("huge", "mode", modes, "short")).toThrow("mode must be one of: short, full");
  });

  it("uses the default workspace limits unless given its own", () => {
    expect(resolvedLimits({ root: "/r" })).toBe(DEFAULT_WORKSPACE_LIMITS);
    const limits = { ...DEFAULT_WORKSPACE_LIMITS };
    expect(resolvedLimits({ root: "/r", limits })).toBe(limits);
  });
});

describe("truncateText", () => {
  it("leaves short text alone", () => {
    expect(truncateText("hello", 10, "narrow it")).toEqual({ text: "hello", truncated: false });
  });

  it("cuts at a nearby line boundary and says how much it showed", () => {
    const text = `${"a".repeat(45)}\n${"b".repeat(100)}`;
    const result = truncateText(text, 50, "narrow it");
    expect(result.truncated).toBe(true);
    expect(result.text.startsWith(`${"a".repeat(45)}\n[truncated: showed 45 of ${text.length} chars. narrow it]`)).toBe(true);
  });

  it("cuts mid-line when no line boundary is close", () => {
    const result = truncateText("x".repeat(100), 30, "narrow it");
    expect(result.text).toBe(`${"x".repeat(30)}\n[truncated: showed 30 of 100 chars. narrow it]`);
  });
});

describe("directoryPrefix", () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-shared-")));
    await fs.mkdir(path.join(root, "src", "lib"), { recursive: true });
    await fs.writeFile(path.join(root, "README.md"), "hi");
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("maps the root, spelled any way, to the empty prefix", async () => {
    expect(await directoryPrefix(root, undefined)).toBe("");
    expect(await directoryPrefix(root, ".")).toBe("");
    expect(await directoryPrefix(root, "./")).toBe("");
  });

  it("returns a workspace-relative path for a directory inside the root", async () => {
    expect((await directoryPrefix(root, "src/lib")).replace(/\\/g, "/")).toBe("src/lib");
  });

  it("refuses a missing path, a file, and a path that escapes the root", async () => {
    await expect(directoryPrefix(root, "nope")).rejects.toThrow(WorkspaceViolation);
    await expect(directoryPrefix(root, "README.md")).rejects.toThrow("is not a directory");
    await expect(directoryPrefix(root, "../")).rejects.toThrow();
  });
});
