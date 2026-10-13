import { describe, expect, it } from "vitest";
import path from "node:path";
// The npm launcher's decision logic; it ships in packages/archymedes-cli/bin, where a test file
// would be published, so its tests live here.
import { fallbackNotice, PUBLISHED_PLATFORMS, resolveInterface } from "../../packages/archymedes-cli/bin/launcher.mjs";
import { TARGETS } from "./build-go";

const join = path.posix.join;

describe("npm launcher", () => {
  it("runs the platform's Go binary when npm installed it", () => {
    const resolution = resolveInterface({ platform: "linux", arch: "x64", resolvePackage: () => "/g/@archymedes/cli-linux-x64", exists: () => true, join });
    expect(resolution).toEqual({ binary: "/g/@archymedes/cli-linux-x64/bin/archymedes" });
    expect(resolveInterface({ platform: "win32", arch: "x64", resolvePackage: () => "/w", exists: () => true, join })).toEqual({ binary: "/w/bin/archymedes.exe" });
  });

  it("tells the three ways a binary can be unusable apart, and each says what to do", () => {
    // The 3.0.0 launch: npm asked for the package before the registry served it, and skipped it.
    const missing = resolveInterface({ platform: "linux", arch: "x64", resolvePackage: () => undefined, exists: () => true, join });
    expect(missing).toEqual({ reason: "not-installed", packageName: "@archymedes/cli-linux-x64" });
    expect(fallbackNotice(missing, "linux", "x64").join("\n")).toMatch(/was not installed[\s\S]*npm install -g archymedes-cli@latest/);

    const empty = resolveInterface({ platform: "darwin", arch: "arm64", resolvePackage: () => "/d", exists: () => false, join });
    expect(empty).toMatchObject({ reason: "missing-binary" });
    expect(fallbackNotice(empty, "darwin", "arm64").join("\n")).toContain("Fix:");

    const unsupported = resolveInterface({ platform: "freebsd", arch: "x64", resolvePackage: () => "/never", exists: () => true, join });
    expect(unsupported).toMatchObject({ reason: "unsupported" });
    expect(fallbackNotice({ reason: "start-failed", detail: "EACCES" }, "linux", "x64").join("\n")).toContain("EACCES");
  });

  it("honours an explicit binary, and publishes exactly the platforms the build produces", () => {
    expect(resolveInterface({ platform: "linux", arch: "x64", override: "/dev/go", resolvePackage: () => undefined, exists: () => false, join })).toEqual({ binary: "/dev/go" });
    expect([...PUBLISHED_PLATFORMS].sort()).toEqual(TARGETS.map((t) => `${t.platform}-${t.arch}`).sort());
  });
});
