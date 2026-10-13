#!/usr/bin/env node
// The `archymedes` command, as npm installs it.
//
// The interface is a Go binary, shipped per platform as an optional dependency
// (@archymedes/cli-<platform>-<arch>); launcher.mjs decides whether it is usable. The agent behind
// it is the bundled dist/archymedes.mjs, run with this same Node: the binary is told where it is
// through ARCHYMEDES_AGENT, as a JSON array so an install path with spaces survives.
//
// Where the binary cannot be used, the bundled agent runs alone: every non-interactive mode works as
// before, and asked for the interface it says why there is none and how to get it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { missingInterfaceNotice, resolveInterface } from "./launcher.mjs";

const require = createRequire(import.meta.url);
const agentEntry = path.join(import.meta.dirname, "..", "dist", "archymedes.mjs");
const { platform, arch } = process;

function packageDirectory(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`));
  } catch {
    return undefined;
  }
}

async function runAgentAlone(resolution) {
  // Read by the agent when it is asked for an interface it does not have (src/archymedes.ts).
  process.env.ARCHYMEDES_INTERFACE_MISSING = missingInterfaceNotice(resolution, platform, arch).join("\n");
  await import(agentEntry);
}

const resolution = resolveInterface({
  platform, arch, override: process.env.ARCHYMEDES_GO_BINARY,
  resolvePackage: packageDirectory, exists: existsSync, join: path.join,
});

if (!("binary" in resolution)) {
  await runAgentAlone(resolution);
} else {
  const env = { ...process.env, ARCHYMEDES_AGENT: process.env.ARCHYMEDES_AGENT || JSON.stringify([process.execPath, agentEntry]) };
  const child = spawn(resolution.binary, process.argv.slice(2), { stdio: "inherit", env });

  // The terminal sends Ctrl+C and Ctrl+\ to the whole process group, so the interface already has
  // them and decides what they mean (stop a turn, not quit). This process only waits. A signal
  // aimed at this process alone is passed on.
  for (const signal of ["SIGINT", "SIGQUIT"]) process.on(signal, () => {});
  for (const signal of ["SIGTERM", "SIGHUP"]) process.on(signal, () => child.kill(signal));

  child.on("error", (error) => {
    // Present but not runnable: a stripped executable bit, a foreign architecture under emulation.
    void runAgentAlone({ reason: "start-failed", detail: error.code ?? error.message });
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
