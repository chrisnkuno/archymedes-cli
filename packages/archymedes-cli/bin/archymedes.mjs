#!/usr/bin/env node
// The `archymedes` command, as npm installs it.
//
// The interface is a Go binary, shipped per platform as an optional dependency
// (@archymedes/cli-<platform>-<arch>, one static binary each). The agent behind it is the bundled
// dist/archymedes.mjs, run with this same Node: the binary is told where it is through
// ARCHYMEDES_AGENT, as a JSON array so an install path with spaces survives.
//
// Where no binary matches the platform — an unusual architecture, or optional dependencies turned
// off — the bundled CLI runs directly instead, with one line saying so. A missing binary is never a
// reason for `archymedes` not to start.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const agentEntry = path.join(import.meta.dirname, "..", "dist", "archymedes.mjs");

function interfaceBinary() {
  if (process.env.ARCHYMEDES_GO_BINARY) return process.env.ARCHYMEDES_GO_BINARY;
  const name = `@archymedes/cli-${process.platform}-${process.arch}`;
  try {
    const directory = path.dirname(require.resolve(`${name}/package.json`));
    const binary = path.join(directory, "bin", process.platform === "win32" ? "archymedes.exe" : "archymedes");
    return existsSync(binary) ? binary : undefined;
  } catch {
    return undefined;
  }
}

async function runBundled(reason) {
  if (reason && process.stderr.isTTY) process.stderr.write(`archymedes: ${reason}; using the bundled interface.\n`);
  await import(agentEntry);
}

const binary = interfaceBinary();
if (!binary) {
  await runBundled(`no prebuilt interface for ${process.platform}-${process.arch}`);
} else {
  const env = { ...process.env, ARCHYMEDES_AGENT: process.env.ARCHYMEDES_AGENT || JSON.stringify([process.execPath, agentEntry]) };
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit", env });

  // The terminal sends Ctrl+C and Ctrl+\ to the whole process group, so the interface already has
  // them and decides what they mean (stop a turn, not quit). This process only waits. A signal
  // aimed at this process alone is passed on.
  for (const signal of ["SIGINT", "SIGQUIT"]) process.on(signal, () => {});
  for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));

  child.on("error", (error) => {
    // Present but not runnable (a stripped executable bit, a foreign architecture under emulation).
    void runBundled(`the interface binary could not start (${error.code ?? error.message})`);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
