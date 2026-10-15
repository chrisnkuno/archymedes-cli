import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { runLocalCommand } from "./command";
import { LocalWorkspace } from "./backends";
import { bubblewrapArgs, commandSandboxFor, looksSandboxDenied, probeBubblewrap } from "./os-sandbox";

describe("the command sandbox's settings", () => {
  it("is off unless asked for, unavailable with the reason when it cannot run, on with the policy otherwise", () => {
    expect(commandSandboxFor("/p", {})).toEqual({ state: "off" });
    expect(commandSandboxFor("/p", { ARCHYMEDES_SANDBOX: "on" }, () => "no bwrap")).toEqual({ state: "unavailable", reason: "no bwrap" });
    const on = commandSandboxFor("/p", { ARCHYMEDES_SANDBOX: "on" }, () => undefined);
    expect(on).toEqual({ state: "on", policy: { writable: ["/p", os.tmpdir()], readOnly: ["/p/.archymedes"], network: false } });
    expect(commandSandboxFor("/p", { ARCHYMEDES_SANDBOX: "on", ARCHYMEDES_SANDBOX_NETWORK: "on" }, () => undefined)).toMatchObject({ policy: { network: true } });
  });

  it("builds bubblewrap's arguments: everything read-only, the writable places bound, no network", () => {
    expect(bubblewrapArgs({ writable: ["/p"], readOnly: [], network: false }, "/p")).toEqual([
      "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--bind", "/p", "/p", "--unshare-net", "--unshare-pid", "--die-with-parent", "--chdir", "/p", "--",
    ]);
    expect(bubblewrapArgs({ writable: ["/p"], readOnly: [], network: true }, "/p")).not.toContain("--unshare-net");
  });

  it("reads a failure as the sandbox's when it says read-only or no network", () => {
    expect(looksSandboxDenied({ exitCode: 1, stdout: "", stderr: "touch: cannot touch '/x': Read-only file system" })).toBe(true);
    expect(looksSandboxDenied({ exitCode: 1, stdout: "", stderr: "npm ERR! getaddrinfo EAI_AGAIN registry.npmjs.org" })).toBe(true);
    expect(looksSandboxDenied({ exitCode: 1, stdout: "", stderr: "1 test failed" })).toBe(false);
    expect(looksSandboxDenied({ exitCode: 0, stdout: "", stderr: "Read-only file system" })).toBe(false);
  });
});

// Real bubblewrap where this machine has it: the point is what the kernel actually refuses.
describe.skipIf(probeBubblewrap() !== undefined)("commands under bubblewrap", () => {
  let base: string;
  let root: string;
  let outside: string;
  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), "sandbox-"));
    root = path.join(base, "project");
    outside = path.join(base, "outside");
    await fs.mkdir(path.join(root, ".archymedes"), { recursive: true });
    await fs.mkdir(outside);
  });
  afterEach(() => fs.rm(base, { recursive: true, force: true }));
  const run = (command: string, network = false) => runLocalCommand(command, { cwd: root, timeoutMs: 15_000, sandbox: { writable: [root], readOnly: [path.join(root, ".archymedes")], network } });

  it("writes inside the project, and nowhere else", async () => {
    expect((await run("echo hi > made.txt && cat made.txt")).stdout.trim()).toBe("hi");
    const refused = await run(`echo no > ${outside}/x.txt`);
    expect(refused.exitCode).not.toBe(0);
    expect(looksSandboxDenied(refused)).toBe(true);
    await expect(fs.access(path.join(outside, "x.txt"))).rejects.toThrow();
  });

  it("keeps Archymedes's own state read-only inside the project", async () => {
    const refused = await run("echo forged > .archymedes/session.json");
    expect(refused.exitCode).not.toBe(0);
    await expect(fs.access(path.join(root, ".archymedes", "session.json"))).rejects.toThrow();
  });

  it("has no network unless allowed", async () => {
    const probe = `node -e "require('net').connect(80,'1.1.1.1').on('connect',()=>process.exit(0)).on('error',e=>{console.error(e.code);process.exit(1)})"`;
    const offline = await run(probe);
    expect(offline.exitCode).not.toBe(0);
    expect(looksSandboxDenied(offline)).toBe(true);
  });

  it("an escalated run is outside; a sandbox that cannot run refuses instead of running bare", async () => {
    const workspace = new LocalWorkspace(root);
    workspace.setCommandSandbox({ state: "on", policy: { writable: [root], readOnly: [], network: false } });
    expect((await workspace.runCommand(`touch ${outside}/a`, 10_000)).exitCode).not.toBe(0);
    expect((await workspace.runCommand(`touch ${outside}/b`, 10_000, undefined, { escalated: true })).exitCode).toBe(0);
    workspace.setCommandSandbox({ state: "unavailable", reason: "bubblewrap is not installed" });
    const refused = await workspace.runCommand("echo hi", 10_000);
    expect(refused).toMatchObject({ exitCode: 126, stderr: expect.stringContaining("bubblewrap is not installed") });
  });
});
