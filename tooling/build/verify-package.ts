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
  assert.match(entry, /^package\/(?:package\.json$|README\.md$|I18N\.md$|NOTICE$|LICENSE$|dist(?:\/|$))/);
  assert(!entry.split("/").some((part) => ["..", ".private", ".env", ".archymedes", "node_modules"].includes(part)), `Unexpected packed path: ${entry}`);
  assert(!/\.(?:test\.[cm]?[jt]sx?|map)$/.test(entry), `Development artifact: ${entry}`);
}
for (const required of ["package.json", "LICENSE", "NOTICE", "README.md", "I18N.md", "dist/archymedes.mjs"]) {
  assert(entries.includes(`package/${required}`), `Missing ${required}`);
}

// Install the exact archive in a separate directory; no workspace imports or symlinked dependencies.
const consumer = await mkdtemp(path.join(os.tmpdir(), "archymedes-consumer-"));
try {
  await writeFile(path.join(consumer, "package.json"), JSON.stringify({ private: true, dependencies: { "archymedes-cli": `file:${archive}` } }));
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
  // The optional workspace renderer is external to the bundle; verify installed resolution too.
  await writeFile(path.join(installed, "smoke.mjs"), 'await import("@termuijs/core"); await import("@termuijs/jsx"); await import("@termuijs/widgets");');
  run(["node", path.join(installed, "smoke.mjs")], consumer, env);
} finally {
  await rm(consumer, { recursive: true, force: true });
}

const sha256 = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(`${archive}.sha256`, `${sha256}  ${path.basename(archive)}\n`);
console.log(`Verified ${path.basename(archive)}: ${entries.length} entries; clean install, Node startup, providers and TUI dependencies passed.\nSHA256 ${sha256}`);
