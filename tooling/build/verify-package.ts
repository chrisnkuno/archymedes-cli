import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageRoot = path.join(root, "packages/archymedes-cli");
const artifactRoot = path.join(root, "artifacts");
const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
const archive = path.join(artifactRoot, `${manifest.name}-${manifest.version}.tgz`);

function run(command: string[], cwd: string, env = process.env): string {
  const result = spawnSync(command[0], command.slice(1), {
    cwd, env, encoding: "utf8", timeout: 180_000, maxBuffer: 30 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command[0]} ${command.slice(1).join(" ")}\n${result.stderr}\n${result.stdout}`);
  return result.stdout;
}

await mkdir(artifactRoot, { recursive: true });
run([process.execPath, "pm", "pack", "--ignore-scripts", "--filename", archive], packageRoot);
const entries = run(["tar", "-tzf", archive], root).trim().split(/\r?\n/);
for (const entry of entries) {
  assert.match(entry, /^package\/(?:package\.json$|README\.md$|I18N\.md$|NOTICE$|LICENSE$|bin\/(?:archymedes\.mjs|launcher\.mjs|launcher\.d\.mts)$|dist(?:\/|$))/);
  assert(!entry.split("/").some((part) => ["..", ".private", ".env", ".archymedes", "node_modules"].includes(part)), `Unexpected packed path: ${entry}`);
  assert(!/\.(?:test\.[cm]?[jt]sx?|map)$/.test(entry), `Development artifact: ${entry}`);
}
for (const required of ["package.json", "LICENSE", "NOTICE", "README.md", "I18N.md", "bin/archymedes.mjs", "bin/launcher.mjs", "bin/launcher.d.mts", "dist/archymedes.mjs"]) {
  assert(entries.includes(`package/${required}`), `Missing ${required}`);
}

// Install the exact archive in a separate directory; no workspace imports or symlinked dependencies.
const consumer = await mkdtemp(path.join(os.tmpdir(), "archymedes-consumer-"));
try {
  // The Go interface for this machine, staged by `tooling/build/build-go.ts --host`, installed beside
  // the CLI the way npm would install the matching optional dependency.
  const platformPackage = `@archymedes/cli-${process.platform}-${process.arch}`;
  const staged = path.join(artifactRoot, "npm", `cli-${process.platform}-${process.arch}`);
  assert.equal(manifest.optionalDependencies?.[platformPackage], manifest.version, `${platformPackage} must be an optional dependency at ${manifest.version}`);
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, dependencies: { "archymedes-cli": `file:${archive}`, [platformPackage]: `file:${staged}` } }));
  run([process.execPath, "install", "--ignore-scripts"], consumer);
  const installed = path.join(consumer, "node_modules/archymedes-cli");
  const installedManifest = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(installedManifest.version, manifest.version);
  assert.equal(installedManifest.license, "Apache-2.0");
  assert.match(await readFile(path.join(installed, "LICENSE"), "utf8"), /Apache License/);
  assert.equal(await readFile(path.join(installed, "NOTICE"), "utf8"), await readFile(path.join(root, "NOTICE"), "utf8"));
  const executable = path.join(installed, "dist/archymedes.mjs");
  const env = { ...process.env, NO_COLOR: "1", ARCHYMEDES_CONFIG_DIR: path.join(consumer, "config"), ARCHYMEDES_AUTO_UPDATE: "off", ARCHYMEDES_FX_OFFLINE: "true" };
  const version = run(["node", executable, "--version"], consumer, env).trim();
  assert(version.includes(manifest.version), `Wrong executable version: ${version}`);
  const help = run(["node", executable, "--help"], consumer, env);
  assert(help.includes("--theme") && help.includes("--resume") && help.includes("--json"));
  assert(!help.includes("\x1b"), "Piped help must not contain terminal escapes");
  const providers = run(["node", executable, "--providers"], consumer, env);
  assert.match(providers, /anthropic/i);
  // The installed command: the shim, which runs the Go interface, which hands one-shot modes to the
  // bundled agent with this same Node.
  const command = path.join(installed, "bin/archymedes.mjs");
  const goVersion = run(["node", command, "--version"], consumer, env).trim();
  assert.equal(goVersion, `archymedes ${manifest.version}`, `Go interface version: ${goVersion}`);
  const goHelp = run(["node", command, "--help"], consumer, env);
  assert(goHelp.includes("--theme") && goHelp.includes("--resume") && goHelp.includes("--json") && !goHelp.includes("\x1b"));
  assert.match(run(["node", command, "--providers"], consumer, env), /anthropic/i, "--providers must reach the agent through the interface");
  // No binary for the platform: the agent still serves non-interactive modes, and asked for the
  // interface it says why there is none — the launcher's notice, not a stand-in interface.
  await rm(path.join(consumer, "node_modules", ...platformPackage.split("/")), { recursive: true, force: true });
  assert.match(run(["node", command, "--version"], consumer, env), new RegExp(manifest.version.replace(/\./g, "\\.")));
  assert.match(run(["node", command, "--providers"], consumer, env), /anthropic/i, "--providers must work without the interface");
  const alone = spawnSync("node", [command], { cwd: consumer, env, encoding: "utf8", input: "" });
  assert.equal(alone.status, 2, `asked for the interface without one: exit ${alone.status}`);
  assert.match(alone.stderr, /was not installed[\s\S]*only non-interactive modes work/, `missing-interface notice: ${alone.stderr}`);
} finally {
  await rm(consumer, { recursive: true, force: true });
}

const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
console.log(`Verified ${path.basename(archive)}: ${entries.length} entries; clean install, Go interface, agent passthrough, the no-interface notice and providers passed.\nSHA256 ${sha256}`);
