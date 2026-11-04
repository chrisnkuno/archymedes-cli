import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
// The npm launcher's decision logic; it ships in packages/friday-cli/bin, where a test file
// would be published, so its tests live here.
import { missingInterfaceNotice, PUBLISHED_PLATFORMS, resolveInterface } from "../../packages/friday-cli/bin/launcher.mjs";
import { TARGETS } from "./build-go";

const join = path.posix.join;

describe("npm launcher", () => {
  it("runs the platform's Go binary when npm installed it", () => {
    const resolution = resolveInterface({ platform: "linux", arch: "x64", resolvePackage: () => "/g/@archymedes/friday-linux-x64", exists: () => true, join });
    expect(resolution).toEqual({ binary: "/g/@archymedes/friday-linux-x64/bin/friday" });
    expect(resolveInterface({ platform: "win32", arch: "x64", resolvePackage: () => "/w", exists: () => true, join })).toEqual({ binary: "/w/bin/friday.exe" });
  });

  it("tells the three ways a binary can be unusable apart, and each says what to do", () => {
    // The 3.0.0 launch: npm asked for the package before the registry served it, and skipped it.
    const missing = resolveInterface({ platform: "linux", arch: "x64", resolvePackage: () => undefined, exists: () => true, join });
    expect(missing).toEqual({ reason: "not-installed", packageName: "@archymedes/friday-linux-x64" });
    expect(missingInterfaceNotice(missing, "linux", "x64").join("\n")).toMatch(/was not installed[\s\S]*npm install -g @archymedes\/friday@latest/);

    const empty = resolveInterface({ platform: "darwin", arch: "arm64", resolvePackage: () => "/d", exists: () => false, join });
    expect(empty).toMatchObject({ reason: "missing-binary" });
    expect(missingInterfaceNotice(empty, "darwin", "arm64").join("\n")).toContain("Fix:");

    const unsupported = resolveInterface({ platform: "freebsd", arch: "x64", resolvePackage: () => "/never", exists: () => true, join });
    expect(unsupported).toMatchObject({ reason: "unsupported" });
    expect(missingInterfaceNotice({ reason: "start-failed", detail: "EACCES" }, "linux", "x64").join("\n")).toContain("EACCES");
    // Every case says the same about what still works, and none promises a substitute interface.
    for (const notice of [missing, empty, unsupported].map((r) => missingInterfaceNotice(r, "linux", "x64").join("\n"))) {
      expect(notice).toContain("only non-interactive modes work");
      expect(notice).not.toMatch(/bundled (one|interface)/);
    }
  });

  it("honours an explicit binary, and publishes exactly the platforms the build produces", () => {
    expect(resolveInterface({ platform: "linux", arch: "x64", override: "/dev/go", resolvePackage: () => undefined, exists: () => false, join })).toEqual({ binary: "/dev/go" });
    expect([...PUBLISHED_PLATFORMS].sort()).toEqual(TARGETS.map((t) => `${t.platform}-${t.arch}`).sort());
  });

  it("imports the bundled agent by file URL, never by path: Windows rejects a drive-letter path", () => {
    // import("C:\dir\friday.mjs") throws ERR_UNSUPPORTED_ESM_URL_SCHEME, and this is the path taken
    // whenever the Go binary cannot be used. The packed-package check (verify:package) runs it for
    // real on Windows; this keeps the mistake out on every platform.
    const source = readFileSync(path.join(__dirname, "../../packages/friday-cli/bin/friday.mjs"), "utf8");
    expect(source).toContain("import(pathToFileURL(");
    expect(source).not.toContain("import(agentEntry)");
  });
});
