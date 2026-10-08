import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalWorkspace } from "../cli/backends";
import { hasShellSyntax } from "../cli/command";
import { hookCommand } from "./command";
import { HookRegistry } from "./registry";
import { HOOK_PHASES } from "./types";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-hooks-registry-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** The extension a hook script has on the platform under test. */
const SCRIPT_EXTENSION = process.platform === "win32" ? ".cmd" : ".sh";

/** Writes a real executable hook script — `.sh` on POSIX, the equivalent `.cmd` on Windows. */
async function writeHookScript(scriptPath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  if (process.platform === "win32") {
    const windowsBody = body
      .replace(/echo '([^']*)' >&2/g, "echo $1 1>&2")
      .replace(/echo (\w+) >> (.+)/g, 'echo $1>>"$2"')
      .replace(/^exit (\d+)$/gm, "exit /b $1");
    await fs.writeFile(scriptPath.replace(/\.sh$/, ".cmd"), `@echo off\r\n${windowsBody.replaceAll("\n", "\r\n")}\r\n`);
    return;
  }
  await fs.writeFile(scriptPath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

/**
 * Writes a hook that decodes ARCHYMEDES_HOOK_EVENT_B64 and exits 0 only when the decoded payload
 * contains `needle`, printing `complaint` to stderr otherwise — a real script reading the real
 * variable, in whichever shell the platform runs hooks with.
 */
async function writePayloadHook(scriptPath: string, needle: string, complaint: string): Promise<void> {
  if (process.platform !== "win32") {
    await writeHookScript(scriptPath, [
      `payload=$(echo "$ARCHYMEDES_HOOK_EVENT_B64" | base64 -d)`,
      `case "$payload" in *'${needle}'*) exit 0 ;; *) echo '${complaint}' >&2; exit 1 ;; esac`,
    ].join("\n"));
    return;
  }
  // The check itself lives outside the hooks directory, where every file is a hook.
  const checker = path.join(root, `check-${path.basename(scriptPath, ".sh")}.cjs`);
  await fs.writeFile(checker, [
    `const payload = Buffer.from(process.env.ARCHYMEDES_HOOK_EVENT_B64 ?? "", "base64").toString("utf8");`,
    `if (payload.includes(${JSON.stringify(needle)})) process.exit(0);`,
    `process.stderr.write(${JSON.stringify(complaint)});`,
    `process.exit(1);`,
  ].join("\n"));
  await fs.mkdir(path.dirname(scriptPath), { recursive: true });
  await fs.writeFile(scriptPath.replace(/\.sh$/, ".cmd"), `@echo off\r\n"${process.execPath}" "${checker}"\r\nexit /b %ERRORLEVEL%\r\n`);
}
describe("hook invocation across shells", () => {
  it("uses env(1) on POSIX, where it is a real program", () => {
    expect(hookCommand(".archymedes/hooks/pre-tool-use/x.sh", "eyJhIjoxfQ==", "linux"))
      .toBe("env ARCHYMEDES_HOOK_EVENT_B64=eyJhIjoxfQ== .archymedes/hooks/pre-tool-use/x.sh");
  });

  it("uses cmd's own `set &&` on Windows, where env(1) does not exist to be found", () => {
    // The POSIX spelling did not merely misbehave under cmd.exe — `env` is not a program there, so
    // there was nothing to run at all.
    const command = hookCommand(".archymedes/hooks/pre-tool-use/x.cmd", "eyJhIjoxfQ==", "win32");
    expect(command).toBe('set "ARCHYMEDES_HOOK_EVENT_B64=eyJhIjoxfQ=="&& call ".archymedes\\hooks\\pre-tool-use\\x.cmd"');
    expect(command).not.toContain("env ");
  });

  it("produces a Windows command the executor will route through a shell, since `set` needs one", () => {
    expect(hasShellSyntax(hookCommand(".archymedes/hooks/pre-tool-use/x.cmd", "abc==", "win32"))).toBe(true);
  });
});

describe("HookRegistry turn and session phases", () => {
  it("runs with no hooks present — never blocks", async () => {
    const registry = HookRegistry.local(new LocalWorkspace(root));
    await expect(registry.runPreTurn("do something")).resolves.toEqual({ blocked: false });
    await expect(registry.runPostTurn("do something", { status: "completed", summary: "done" })).resolves.toEqual([]);
    await expect(registry.runPreSession("session-1")).resolves.toEqual({ blocked: false });
    await expect(registry.runPostSession("session-1")).resolves.toEqual([]);
  });

  it("blocks a turn on a non-zero pre-turn exit and surfaces the hook's stderr as the reason", async () => {
    await writeHookScript(path.join(root, ".archymedes/hooks/pre-turn/guard.sh"), "echo 'no turns about secrets' >&2\nexit 1");
    const registry = HookRegistry.local(new LocalWorkspace(root));
    const outcome = await registry.runPreTurn("refactor the auth module");
    expect(outcome).toEqual({ blocked: true, reason: "no turns about secrets" });
  });

  it("actually decodes the real event payload the hook receives, not a fake one", async () => {
    // Proves the wiring end to end: a script that decodes ARCHYMEDES_HOOK_EVENT_B64 and checks the
    // real fields sees the real objective this call was made with.
    await writePayloadHook(path.join(root, ".archymedes/hooks/pre-turn/inspect.sh"), '"objective":"rewrite the parser"', "unexpected payload");
    const registry = HookRegistry.local(new LocalWorkspace(root));
    await expect(registry.runPreTurn("rewrite the parser")).resolves.toEqual({ blocked: false });
    await expect(registry.runPreTurn("something else")).resolves.toMatchObject({ blocked: true });
  });

  it("collects a warning from a failing post-turn hook without throwing", async () => {
    await writeHookScript(path.join(root, ".archymedes/hooks/post-turn/audit.sh"), "echo 'turn left files uncommitted' >&2\nexit 1");
    const registry = HookRegistry.local(new LocalWorkspace(root));
    const warnings = await registry.runPostTurn("do something", { status: "completed", summary: "did it" });
    expect(warnings).toEqual(["turn left files uncommitted"]);
  });

  it("gates the session on a pre-session hook, with the session id in the payload", async () => {
    await writePayloadHook(path.join(root, ".archymedes/hooks/pre-session/gate.sh"), '"sessionId":"sess-42"', "wrong session");
    const registry = HookRegistry.local(new LocalWorkspace(root));
    await expect(registry.runPreSession("sess-42")).resolves.toEqual({ blocked: false });
    await expect(registry.runPreSession("other")).resolves.toMatchObject({ blocked: true, reason: "wrong session" });
  });

  it("collects a warning from a failing post-session hook without throwing", async () => {
    await writeHookScript(path.join(root, ".archymedes/hooks/post-session/cleanup.sh"), "echo 'could not write audit log' >&2\nexit 1");
    const registry = HookRegistry.local(new LocalWorkspace(root));
    await expect(registry.runPostSession("sess-42")).resolves.toEqual(["could not write audit log"]);
  });

  it("runs multiple pre-turn hooks in a deterministic (sorted) order and stops at the first block", async () => {
    const order = path.join(root, "order.log");
    await writeHookScript(path.join(root, ".archymedes/hooks/pre-turn/1-first.sh"), `echo first >> ${order}\nexit 0`);
    await writeHookScript(path.join(root, ".archymedes/hooks/pre-turn/2-second.sh"), `echo second >> ${order}\nexit 1`);
    await writeHookScript(path.join(root, ".archymedes/hooks/pre-turn/3-third.sh"), `echo third >> ${order}\nexit 0`);
    const registry = HookRegistry.local(new LocalWorkspace(root));
    const outcome = await registry.runPreTurn("do something");
    expect(outcome.blocked).toBe(true);
    const log = await fs.readFile(order, "utf8");
    expect(log.trim().split(/\r?\n/)).toEqual(["first", "second"]); // never reached the third
  });
});

describe("HookRegistry.list", () => {
  it("reports every phase's scripts, in lifecycle order", async () => {
    await writeHookScript(path.join(root, ".archymedes/hooks/pre-tool-use/a.sh"), "exit 0");
    await writeHookScript(path.join(root, ".archymedes/hooks/post-turn/b.sh"), "exit 0");
    await writeHookScript(path.join(root, ".archymedes/hooks/pre-session/c.sh"), "exit 0");
    const registry = HookRegistry.local(new LocalWorkspace(root));
    const listed = await registry.list();
    expect(Object.keys(listed)).toEqual([...HOOK_PHASES]);
    expect(HOOK_PHASES).toEqual(["pre-session", "pre-turn", "pre-tool-use", "post-tool-use", "post-turn", "post-session"]);
    expect(listed["pre-session"]).toEqual([`.archymedes/hooks/pre-session/c${SCRIPT_EXTENSION}`]);
    expect(listed["pre-tool-use"]).toEqual([`.archymedes/hooks/pre-tool-use/a${SCRIPT_EXTENSION}`]);
    expect(listed["post-turn"]).toEqual([`.archymedes/hooks/post-turn/b${SCRIPT_EXTENSION}`]);
    expect(listed["pre-turn"]).toEqual([]);
  });
});
