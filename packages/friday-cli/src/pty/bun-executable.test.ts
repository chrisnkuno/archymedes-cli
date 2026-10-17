import { describe, expect, it } from "vitest";
import path from "node:path";
import { bunExecutable } from "./bun-executable";

const existing = (...files: string[]) => (file: string) => files.includes(file);

describe("bunExecutable", () => {
  it("finds bun on a POSIX PATH, and falls back to the bare name", () => {
    expect(bunExecutable({ PATH: "/usr/bin:/home/a/.bun/bin" }, "linux", existing("/home/a/.bun/bin/bun"))).toBe("/home/a/.bun/bin/bun");
    expect(bunExecutable({ PATH: "/usr/bin" }, "darwin", existing())).toBe("bun");
  });

  it("prefers a native bun.exe on Windows", () => {
    const native = path.win32.join("C:\\Users\\a\\.bun\\bin", "bun.exe");
    expect(bunExecutable({ PATH: "C:\\Windows;C:\\Users\\a\\.bun\\bin" }, "win32", existing(native))).toBe(native);
  });

  it("looks past npm's bun.cmd shim to the bun.exe it wraps, which spawn can run without a shell", () => {
    const npm = "C:\\Users\\a\\AppData\\Roaming\\npm";
    const shim = path.win32.join(npm, "bun.cmd");
    const real = path.win32.join(npm, "node_modules", "bun", "bin", "bun.exe");
    expect(bunExecutable({ Path: npm }, "win32", existing(shim, real))).toBe(real);
    expect(bunExecutable({ Path: npm }, "win32", existing(shim))).toBe(shim);
    expect(bunExecutable({ Path: npm }, "win32", existing())).toBe("bun");
  });
});
