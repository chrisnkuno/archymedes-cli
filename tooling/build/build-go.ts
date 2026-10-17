import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Builds the Go interface for every published platform and stages one npm package per binary.
 *
 *   bun run tooling/build/build-go.ts            # all six targets → artifacts/npm/cli-<platform>-<arch>
 *   bun run tooling/build/build-go.ts --host     # only this machine's target (local verification)
 *
 * Go builds static binaries with cgo off, so — unlike archymedes-state — there is no glibc/musl
 * split: one Linux binary per architecture runs on both. The npm `os`/`cpu` fields make each
 * package install only where it runs, and `archymedes-cli` lists all of them as optional
 * dependencies at exactly its own version; this script refuses to build when that list and the
 * version disagree, so a CLI can never point at binaries from another release.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI = path.join(ROOT, "packages/friday-cli");
const OUT = path.join(ROOT, "artifacts", "npm");
export const SCOPE = "@archymedes";

/** npm platform/arch → Go GOOS/GOARCH. */
export const TARGETS = [
  { platform: "linux", arch: "x64", goos: "linux", goarch: "amd64" },
  { platform: "linux", arch: "arm64", goos: "linux", goarch: "arm64" },
  { platform: "darwin", arch: "x64", goos: "darwin", goarch: "amd64" },
  { platform: "darwin", arch: "arm64", goos: "darwin", goarch: "arm64" },
  { platform: "win32", arch: "x64", goos: "windows", goarch: "amd64" },
  { platform: "win32", arch: "arm64", goos: "windows", goarch: "arm64" },
] as const;

export const packageName = (target: { platform: string; arch: string }) => `${SCOPE}/cli-${target.platform}-${target.arch}`;

async function main(): Promise<void> {
  const manifest = JSON.parse(await fs.readFile(path.join(CLI, "package.json"), "utf8"));
  const version: string = manifest.version;
  const listed = manifest.optionalDependencies ?? {};
  for (const target of TARGETS) {
    if (listed[packageName(target)] !== version) {
      throw new Error(`${CLI}/package.json must list ${packageName(target)}@${version} in optionalDependencies (found ${listed[packageName(target)] ?? "nothing"})`);
    }
  }

  const host = process.argv.includes("--host");
  const targets = host ? TARGETS.filter((t) => t.platform === process.platform && t.arch === process.arch) : TARGETS;
  if (targets.length === 0) throw new Error(`No published target for ${process.platform}-${process.arch}`);

  for (const target of targets) {
    const dir = path.join(OUT, `cli-${target.platform}-${target.arch}`);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(path.join(dir, "bin"), { recursive: true });
    const binary = path.join(dir, "bin", target.platform === "win32" ? "archymedes.exe" : "archymedes");
    const built = spawnSync("go", ["build", "-trimpath", "-ldflags", `-s -w -X main.version=${version}`, "-o", binary, "./cmd/friday"], {
      cwd: ROOT,
      stdio: "inherit",
      env: { ...process.env, CGO_ENABLED: "0", GOOS: target.goos, GOARCH: target.goarch },
    });
    if (built.status !== 0) throw new Error(`go build for ${target.goos}/${target.goarch} failed`);
    await fs.writeFile(path.join(dir, "package.json"), `${JSON.stringify({
      name: packageName(target),
      version,
      description: `The Archymedes CLI interface for ${target.platform}-${target.arch}. Installed by archymedes-cli; not meant to be installed directly.`,
      license: "Apache-2.0",
      repository: manifest.repository,
      os: [target.platform],
      cpu: [target.arch],
      files: ["bin", "LICENSE", "NOTICE"],
      preferUnplugged: true,
      publishConfig: { access: "public" },
    }, null, 2)}\n`);
    for (const file of ["LICENSE", "NOTICE"]) await fs.copyFile(path.join(ROOT, file), path.join(dir, file));
    const { size } = await fs.stat(binary);
    console.log(`${packageName(target)}@${version}: ${(size / 1_000_000).toFixed(1)} MB`);
  }
}

if (import.meta.main ?? process.argv[1] === fileURLToPath(import.meta.url)) await main();
