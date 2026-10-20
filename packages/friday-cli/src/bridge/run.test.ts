import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SocketLike } from "./relay";
import { runBridge, type BridgeOptions } from "./run";

const agent = fileURLToPath(new URL("./testdata/fake-agent.mjs", import.meta.url));

class FakeSocket implements SocketLike {
  sent: Array<Record<string, unknown>> = [];
  closed = false;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) {
    queueMicrotask(() => this.onopen?.({}));
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  tell(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  get frames() { return this.sent.filter((message) => message.t === "frame").map((message) => message.frame as Record<string, any>); }
  get hellos() { return this.sent.filter((message) => message.t === "hello"); }
}

let dir: string;
let configPath: string;
const sockets: FakeSocket[] = [];
const bridges: Array<{ abort: AbortController; done: Promise<number> }> = [];

const config = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  url: "wss://app.example/api/bridge/ses_test01", secret: "secret-one-0123456789", sessionId: "ses_test01",
  cwd: path.join(dir, "work", "app"), env: { TEST_KEY: "session-token" }, ...overrides,
});
const until = async (condition: () => boolean, ms = 8_000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
function start(overrides: Partial<BridgeOptions> = {}) {
  const abort = new AbortController();
  const logs: string[] = [];
  const done = runBridge({
    configPath, command: [process.execPath, agent], statePath: path.join(dir, "state.json"), pollMs: 20, restartDelayMs: 20, heartbeatMs: 60_000,
    baseEnvironment: { PATH: process.env.PATH, FRIDAY_BRIDGE_CONFIG: configPath },
    socket: (url, init) => { const socket = new FakeSocket(url, init.headers); sockets.push(socket); return socket; },
    log: (message) => logs.push(message), signal: abort.signal, ...overrides,
  });
  bridges.push({ abort, done });
  return { abort, done, logs };
}
const prompt = (id: string, sessionId: string, text: string) => ({ t: "frame", frame: { jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text }] } } });

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-run-"));
  configPath = path.join(dir, "session.json");
});
afterEach(async () => {
  for (const { abort } of bridges.splice(0)) abort.abort();
  await Promise.allSettled(bridges.map((bridge) => bridge.done));
  sockets.length = 0;
  await fs.rm(dir, { recursive: true, force: true });
});

describe("the bridge", () => {
  it("does nothing until the server writes its config, then dials and says what the agent is", async () => {
    const { logs } = start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(sockets).toHaveLength(0);
    await fs.writeFile(configPath, config());
    await until(() => sockets.length > 0 && sockets[0].hellos.length > 0);
    expect(sockets[0].url).toBe("wss://app.example/api/bridge/ses_test01");
    expect(sockets[0].headers).toEqual({ Authorization: "Bearer secret-one-0123456789" });
    expect(sockets[0].hellos[0]).toMatchObject({ t: "hello", version: 1, mode: "build", model: "fake-model" });
    expect(String(sockets[0].hellos[0].acpSessionId)).toMatch(/^agent-\d+$/);
    expect(logs.join("\n")).toContain("agent ready");
  });

  it("says it is waiting before anything else, which is what the sandbox template's readiness check waits for", async () => {
    const { logs } = start();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(logs[0]).toBe("waiting for a session");
  });

  it("puts the config's files in the agent's configuration folder before it starts, readable by its owner alone", async () => {
    start();
    const home = path.join(dir, "home");
    await fs.writeFile(configPath, config({ env: { HOME: home }, files: [{ path: ".config/archymedes/free-install.json", content: '{"gateway":"g","token":"tok"}' }] }));
    await until(() => sockets[0]?.hellos.length > 0);
    const file = path.join(home, ".config", "archymedes", "free-install.json");
    expect(await fs.readFile(file, "utf8")).toBe('{"gateway":"g","token":"tok"}');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("reports a bad config once and waits for a good one", async () => {
    const { logs } = start();
    await fs.writeFile(configPath, "{ not json");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(logs.filter((line) => line.includes("not valid JSON"))).toHaveLength(1);
    await fs.writeFile(configPath, config());
    await until(() => sockets.length > 0);
  });

  it("carries a prompt from the phone to the agent and the agent's whole answer back", async () => {
    start();
    await fs.writeFile(configPath, config());
    await until(() => sockets[0]?.hellos.length > 0);
    const sessionId = String(sockets[0].hellos[0].acpSessionId);
    sockets[0].tell(prompt("p1", sessionId, "world"));
    await until(() => sockets[0].frames.length >= 2);
    expect(sockets[0].frames[0].params.update.content.text).toBe("hello world");
    expect(sockets[0].frames[1]).toEqual({ jsonrpc: "2.0", id: "p1", result: { stopReason: "end_turn" } });
  });

  it("gives the agent the config's environment and working directory, and keeps its own plumbing out of it", async () => {
    start();
    await fs.writeFile(configPath, config());
    await until(() => sockets[0]?.hellos.length > 0);
    sockets[0].tell(prompt("p2", String(sockets[0].hellos[0].acpSessionId), "env"));
    await until(() => sockets[0].frames.length >= 1);
    const seen = JSON.parse(sockets[0].frames[0].params.update.content.text);
    expect(seen).toMatchObject({ key: "session-token", telemetry: "off", bridgeConfig: null });
    expect(seen.cwd).toBe(await fs.realpath(path.join(dir, "work", "app")));
  });

  it("reconnects with the new secret when the config changes, and the agent carries on untouched", async () => {
    start();
    await fs.writeFile(configPath, config());
    await until(() => sockets[0]?.hellos.length > 0);
    const before = String(sockets[0].hellos[0].acpSessionId);
    await fs.writeFile(configPath, config({ secret: "secret-two-0123456789" }));
    await until(() => sockets.length === 2 && sockets[1].hellos.length > 0);
    expect(sockets[1].headers.Authorization).toBe("Bearer secret-two-0123456789");
    expect(sockets[0].closed).toBe(true);
    expect(sockets[1].hellos[0].acpSessionId).toBe(before);
    sockets[1].tell(prompt("p3", before, "again"));
    await until(() => sockets[1].frames.length >= 2);
  });

  it("restarts a dead agent in the same conversation and tells the phone", async () => {
    start();
    await fs.writeFile(configPath, config());
    await until(() => sockets[0]?.hellos.length > 0);
    const sessionId = String(sockets[0].hellos[0].acpSessionId);
    sockets[0].tell(prompt("p4", sessionId, "die"));
    await until(() => sockets[0].hellos.length >= 2);
    expect(sockets[0].hellos[1].acpSessionId).toBe(sessionId);
    sockets[0].tell(prompt("p5", sessionId, "back"));
    await until(() => sockets[0].frames.some((frame) => frame.params?.update?.content?.text === "hello back"));
  });

  it("gives up on an agent that keeps dying, instead of looping on a broken one", async () => {
    const { done, logs } = start({ baseEnvironment: { PATH: process.env.PATH, FAKE_DIE_AFTER_MS: "80", FRIDAY_BRIDGE_CONFIG: configPath } });
    await fs.writeFile(configPath, config());
    expect(await done).toBe(1);
    expect(logs.join("\n")).toContain("giving up");
  });

  it("exits with 1 when the agent cannot start at all", async () => {
    const { done } = start({ command: ["/nonexistent/friday"] });
    await fs.writeFile(configPath, config());
    expect(await done).toBe(1);
  });

  it("answers a housekeeping request in the agent's directory", async () => {
    start();
    await fs.writeFile(configPath, config());
    await until(() => sockets[0]?.hellos.length > 0);
    sockets[0].tell({ t: "control", id: "c1", op: "status", args: {} });
    await until(() => sockets[0].sent.some((message) => message.t === "result"));
    const result = sockets[0].sent.find((message) => message.t === "result")!;
    expect(result).toMatchObject({ t: "result", id: "c1", ok: false });
    expect(String(result.detail)).toMatch(/not a git repository/);
  });

  it("stops the agent and exits cleanly when the server ends the session", async () => {
    const { done } = start();
    await fs.writeFile(configPath, config());
    await until(() => sockets[0]?.hellos.length > 0);
    sockets[0].tell({ t: "bye", reason: "killed" });
    expect(await done).toBe(0);
  });
});
