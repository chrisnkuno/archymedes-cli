import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateSetting } from "../../platform/settings";
import { claudeOverview, claudeReadiness, claudeModels, connectClaude, learnClaudeModels, rememberClaudeModel, type BackendDependencies } from "./backend";
import { claudeEnvironment, findClaude, parseAuthStatus } from "./executable";
import type { CommandRunner } from "./install";
import { claudeSetupStatus, withClaude, withClaudeModels } from "./listing";
import { findSdk, sdkEntry } from "./sdk";

const SIGNED_IN = JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", email: "person@example.com", orgId: "org-1", orgName: "Org", subscriptionType: "pro" });
const SIGNED_OUT = JSON.stringify({ loggedIn: false });

/** A machine: a fake `claude` on disk, a config folder, and a command runner that records calls. */
function machine(options: { claude?: boolean; signedIn?: boolean; sdk?: boolean; npmFails?: boolean } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "archymedes-claude-"));
  const bin = path.join(home, "bin");
  mkdirSync(bin);
  if (options.claude !== false) writeFileSync(path.join(bin, "claude"), "#!/bin/sh\n");
  const config = path.join(home, "config");
  const environment: Record<string, string | undefined> = { ARCHYMEDES_CONFIG_DIR: config };
  const processEnvironment: Record<string, string | undefined> = { PATH: bin, ARCHYMEDES_CONFIG_DIR: config, ANTHROPIC_API_KEY: "sk-ant-should-not-reach-claude" };
  const entry = sdkEntry(path.join(config, "claude-agent-sdk"));
  if (options.sdk) { mkdirSync(path.dirname(entry), { recursive: true }); writeFileSync(entry, "export {}\n"); }
  const calls: Array<{ command: string; args: string[]; env?: Record<string, string | undefined> }> = [];
  const run: CommandRunner = async (command, args, runOptions) => {
    calls.push({ command, args, env: runOptions.env });
    if (args[0] === "auth") return { code: 0, output: options.signedIn === false ? SIGNED_OUT : SIGNED_IN };
    if (command === "npm") {
      if (options.npmFails) return { code: 1, output: "npm ERR! network unreachable\n" };
      mkdirSync(path.dirname(entry), { recursive: true });
      writeFileSync(entry, "export {}\n");
      return { code: 0, output: "added 1 package" };
    }
    return { code: 127, output: "not found" };
  };
  let now = 1_000_000;
  const deps: BackendDependencies & { tick: (ms: number) => void } = { environment, processEnvironment, run, home, now: () => now, tick: (ms) => { now += ms; } };
  return { deps, calls, bin, entry, config };
}

describe("finding the person's Claude Code", () => {
  it("prefers ARCHYMEDES_CLAUDE_PATH, then the PATH, then where the installers put it", () => {
    const exists = (file: string) => ["/opt/claude", "/b/claude", "/home/me/.local/bin/claude"].includes(file);
    expect(findClaude({ ARCHYMEDES_CLAUDE_PATH: "/opt/claude", PATH: "/b" }, { exists, home: "/home/me", platform: "linux" })).toBe("/opt/claude");
    expect(findClaude({ ARCHYMEDES_CLAUDE_PATH: "/missing", PATH: "/b" }, { exists, home: "/home/me", platform: "linux" })).toBeUndefined();
    expect(findClaude({ PATH: "/a:/b" }, { exists, home: "/home/me", platform: "linux" })).toBe("/b/claude");
    expect(findClaude({ PATH: "/a" }, { exists, home: "/home/me", platform: "linux" })).toBe("/home/me/.local/bin/claude");
    expect(findClaude({ PATH: "/a" }, { exists: () => false, home: "/home/me", platform: "linux" })).toBeUndefined();
    expect(findClaude({ Path: "C:\\tools" }, { exists: (file) => file === path.join("C:\\tools", "claude.exe"), home: "C:\\Users\\me", platform: "win32" })).toBe(path.join("C:\\tools", "claude.exe"));
  });

  it("reads sign-in state and nothing else of the account", () => {
    const auth = parseAuthStatus(0, `some banner\n${SIGNED_IN}\n`);
    expect(auth).toEqual({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });
    expect(JSON.stringify(auth)).not.toMatch(/example\.com|org-1|Org/);
    expect(parseAuthStatus(1, "error: unknown command 'auth'")).toEqual({ loggedIn: false, error: "claude auth status said: error: unknown command 'auth'" });
    expect(parseAuthStatus(null, "spawn ENOENT")).toMatchObject({ loggedIn: false, error: "spawn ENOENT" });
  });

  it("runs Claude Code without ANTHROPIC_API_KEY, so it bills the subscription, unless asked to bill the key", () => {
    const original = { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-x", HOME: "/home/me" };
    expect(claudeEnvironment(original)).toEqual({ PATH: "/bin", HOME: "/home/me", CLAUDE_AGENT_SDK_CLIENT_APP: "archymedes" });
    expect(original.ANTHROPIC_API_KEY).toBe("sk-ant-x"); // not changed in place
    expect(claudeEnvironment({ ...original, ARCHYMEDES_CLAUDE_BILLING: "API" }).ANTHROPIC_API_KEY).toBe("sk-ant-x");
  });

  it("finds the SDK in Friday's folder, or where ARCHYMEDES_CLAUDE_SDK says", () => {
    const { deps, entry } = machine({ sdk: true });
    expect(findSdk(deps.environment)).toBe(entry);
    expect(findSdk({ ...deps.environment, ARCHYMEDES_CLAUDE_SDK: "/elsewhere/sdk.mjs" }, (file) => file === "/elsewhere/sdk.mjs")).toBe("/elsewhere/sdk.mjs");
    expect(findSdk({ ...deps.environment, ARCHYMEDES_CLAUDE_SDK: "/prefix" }, (file) => file === sdkEntry("/prefix"))).toBe(sdkEntry("/prefix"));
    expect(findSdk({ ARCHYMEDES_CONFIG_DIR: "/nowhere" })).toBeUndefined();
  });
});

describe("Claude's readiness", () => {
  it("names the one thing missing, in order: Claude Code, signing in, the SDK", async () => {
    expect(await claudeReadiness(machine({ claude: false }).deps)).toMatchObject({ ready: false, needs: "claude" });
    expect(await claudeReadiness(machine({ signedIn: false }).deps)).toMatchObject({ ready: false, needs: "sign-in" });
    expect(await claudeReadiness(machine().deps)).toMatchObject({ ready: false, needs: "sdk" });
    const ready = machine({ sdk: true });
    expect(await claudeReadiness(ready.deps)).toMatchObject({ ready: true, entry: ready.entry, executable: path.join(ready.bin, "claude"), auth: { subscriptionType: "pro" } });
  });

  it("asks Claude Code about sign-in at most every 30 seconds, in the environment it will run in", async () => {
    const { deps, calls } = machine({ sdk: true });
    await claudeReadiness(deps);
    await claudeReadiness(deps);
    expect(calls.filter((call) => call.args[0] === "auth")).toHaveLength(1);
    expect(calls[0].env?.ANTHROPIC_API_KEY).toBeUndefined();
    deps.tick(31_000);
    await claudeReadiness(deps);
    await claudeReadiness(deps, { fresh: true });
    expect(calls.filter((call) => call.args[0] === "auth")).toHaveLength(3);
  });

  it("connecting installs Anthropic's SDK (its JavaScript only) when that is all that is missing", async () => {
    const { deps, calls } = machine();
    const result = await connectClaude(deps);
    expect(result).toEqual({ ok: true, file: "", models: ["default", "opus", "sonnet", "haiku"], note: "Signed in with Claude Pro: turns use your plan's limits." });
    const npm = calls.find((call) => call.command === "npm")!;
    expect(npm.args).toEqual(expect.arrayContaining(["install", "--omit=optional", "--legacy-peer-deps", "--ignore-scripts", "@anthropic-ai/claude-agent-sdk@0.3.301"]));
  });

  it("connecting says what to do when Claude Code is missing, signed out, or the install fails", async () => {
    expect(await connectClaude(machine({ claude: false }).deps)).toMatchObject({ ok: false, error: expect.stringContaining("Install Claude Code first") });
    expect(await connectClaude(machine({ signedIn: false }).deps)).toMatchObject({ ok: false, error: expect.stringContaining("claude auth login") });
    expect(await connectClaude(machine({ npmFails: true }).deps)).toMatchObject({ ok: false, error: expect.stringMatching(/network unreachable.*npm install --prefix/) });
  });

  it("is a Providers row that offers sign-in when that is what it needs", async () => {
    const signedOut = machine({ signedIn: false });
    expect(await claudeOverview(signedOut.deps)).toMatchObject({
      id: "claude", label: "Claude (your subscription)", configured: false, missing: ["signing in to Claude (claude auth login)"], fields: [],
      login: [path.join(signedOut.bin, "claude"), "auth", "login"], model: "default", isDefault: false,
    });
    const ready = machine({ sdk: true });
    ready.deps.environment.ARCHYMEDES_PROVIDER = "claude";
    ready.deps.environment.CLAUDE_MODEL = "opus";
    const row = await claudeOverview(ready.deps);
    expect(row).toMatchObject({ configured: true, missing: [], isDefault: true, model: "opus", note: "Signed in with Claude Pro: turns use your plan's limits." });
    expect(row).not.toHaveProperty("login");
    expect(await claudeOverview(machine({ claude: false }).deps)).toMatchObject({ keyUrl: "https://code.claude.com/docs/en/setup" });
  });

  it("remembers the model for new sessions, and 'default' clears it", async () => {
    const { deps } = machine();
    let saved: Record<string, string> = {};
    const store = { load: async () => saved, save: async (settings: Record<string, string>) => { saved = settings; return "settings.json"; } };
    await rememberClaudeModel("opus", { ...deps, ...store });
    expect(saved.CLAUDE_MODEL).toBe("opus");
    expect(deps.environment.CLAUDE_MODEL).toBe("opus");
    await rememberClaudeModel("default", { ...deps, ...store });
    expect(saved).not.toHaveProperty("CLAUDE_MODEL");
    expect(deps.environment.CLAUDE_MODEL).toBeUndefined();
  });

  it("lists the models Claude Code said it has, once a session has asked", () => {
    expect(claudeModels()).toEqual(["default", "opus", "sonnet", "haiku"]);
    learnClaudeModels(["default", "opus", "sonnet[1m]", ""]);
    expect(claudeModels()).toEqual(["default", "opus", "sonnet[1m]"]);
    learnClaudeModels([]); // nothing learned: the aliases again
    expect(claudeModels()).toEqual(["default", "opus", "sonnet", "haiku"]);
  });
});

describe("Claude in the interface's lists", () => {
  it("is the second provider, after free", () => {
    expect(withClaude([{ id: "anthropic" }, { id: "free" }, { id: "openai" }], { id: "claude" }).map((row) => row.id)).toEqual(["anthropic", "free", "claude", "openai"]);
    expect(withClaude([{ id: "openai" }], { id: "claude" }).map((row) => row.id)).toEqual(["claude", "openai"]);
  });

  it("puts Claude's models with the usable ones when ready, with the locked ones before", () => {
    const listing = { choices: [{ provider: "openai", locked: false } as Record<string, unknown> & { provider: string }, { provider: "groq", locked: true }], unconfigured: [{ provider: "groq", label: "Groq", missing: ["GROQ_API_KEY"] }] };
    const ready = { id: "claude", label: "Claude", configured: true, missing: [], model: "opus", isDefault: false, fields: [] } as never;
    const order = withClaudeModels(listing, ready).choices.map((choice) => `${choice.provider}:${String(choice.model ?? "")}`);
    expect(order).toEqual(["openai:", "claude:default", "claude:opus", "claude:sonnet", "claude:haiku", "groq:"]);
    expect(withClaudeModels(listing, ready).choices.find((choice) => choice.model === "opus")).toMatchObject({ isDefault: true, price: "your Claude plan", locked: false });
    const notReady = { id: "claude", label: "Claude", configured: false, missing: ["signing in"], model: "default", isDefault: false, fields: [] } as never;
    const locked = withClaudeModels(listing, notReady);
    expect(locked.choices.at(-1)).toMatchObject({ provider: "claude", locked: true, missing: ["signing in"] });
    expect(locked.unconfigured.at(-1)).toMatchObject({ provider: "claude", missing: ["signing in"] });
  });

  it("counts as set up on first run when it is the default and ready", async () => {
    const notConfigured = { configured: false, reason: "No model provider is configured", providers: [] };
    const ready = machine({ sdk: true });
    expect(await claudeSetupStatus(notConfigured, {}, ready.deps)).toBe(notConfigured); // not chosen: unchanged
    ready.deps.environment.ARCHYMEDES_PROVIDER = "claude";
    expect(await claudeSetupStatus(notConfigured, {}, ready.deps)).toMatchObject({ configured: true, reason: undefined });
    expect(await claudeSetupStatus(notConfigured, { provider: "claude" }, machine({ signedIn: false }).deps)).toMatchObject({ configured: false, reason: "Claude needs signing in to Claude (claude auth login)." });
  });

  it("is a provider the settings accept as the default", () => {
    expect(validateSetting("ARCHYMEDES_PROVIDER", "Claude")).toBe("claude");
    expect(() => validateSetting("ARCHYMEDES_PROVIDER", "claude-code")).toThrow(/claude/);
    expect(validateSetting("CLAUDE_MODEL", "opus")).toBe("opus");
  });
});
