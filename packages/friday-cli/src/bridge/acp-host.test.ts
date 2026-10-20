import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AcpHost, type HostOptions } from "./acp-host";

const agent = fileURLToPath(new URL("./testdata/fake-agent.mjs", import.meta.url));
let dir: string;
const hosts: AcpHost[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-host-"));
});
afterEach(async () => {
  for (const host of hosts.splice(0)) host.stop();
  await fs.rm(dir, { recursive: true, force: true });
});

function make(overrides: Partial<HostOptions> = {}) {
  const frames: string[] = [];
  const exits: Array<number | null> = [];
  const host = new AcpHost({
    command: [process.execPath, agent],
    cwd: dir,
    env: { PATH: process.env.PATH, ...overrides.env },
    onFrame: (line) => frames.push(line),
    onExit: (code) => exits.push(code),
    timeoutMs: 5_000,
    ...overrides,
  });
  hosts.push(host);
  return { host, frames, exits };
}
const until = async (condition: () => boolean, ms = 3_000) => {
  const end = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("the agent process", () => {
  it("does the handshake itself, so the phone meets an agent that is already open", async () => {
    const { host, frames } = make();
    const info = await host.start();
    expect(info).toMatchObject({ mode: "build", model: "fake-model", provider: "fake" });
    expect(info.sessionId).toMatch(/^agent-\d+$/);
    // The bridge's own answers (`b1`, `b2`) never reach the phone.
    expect(frames).toEqual([]);
  });

  it("passes the agent's messages out as frames and the phone's in, answers to the agent's own requests included", async () => {
    const { host, frames } = make();
    const { sessionId } = await host.start();
    host.send(JSON.stringify({ jsonrpc: "2.0", id: "p1", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "world" }] } }));
    await until(() => frames.length >= 2);
    expect(JSON.parse(frames[0]).params.update.content.text).toBe("hello world");
    expect(JSON.parse(frames[1])).toEqual({ jsonrpc: "2.0", id: "p1", result: { stopReason: "end_turn" } });

    host.send(JSON.stringify({ jsonrpc: "2.0", id: "p-ask", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "ask" }] } }));
    await until(() => frames.some((line) => JSON.parse(line).method === "session/request_permission"));
    const request = JSON.parse(frames.find((line) => JSON.parse(line).method === "session/request_permission")!);
    expect(request.id).toBe(7);
    host.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { outcome: { outcome: "selected", optionId: "allow" } } }));
    await until(() => frames.some((line) => line.includes("answered")));
  });

  it("reassembles a message the pipe split in two", async () => {
    const { host, frames } = make();
    const { sessionId } = await host.start();
    const big = "x".repeat(200_000);
    host.send(JSON.stringify({ jsonrpc: "2.0", id: "p2", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: big }] } }));
    await until(() => frames.length >= 2);
    expect(JSON.parse(frames[0]).params.update.content.text).toHaveLength(6 + big.length);
  });

  it("starts the agent in the working directory with the environment it was given", async () => {
    const { host, frames } = make({ env: { PATH: process.env.PATH, TEST_KEY: "session-token", ARCHYMEDES_TELEMETRY: "off" } });
    const { sessionId } = await host.start();
    host.send(JSON.stringify({ jsonrpc: "2.0", id: "p3", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "env" }] } }));
    await until(() => frames.length >= 1);
    const seen = JSON.parse(JSON.parse(frames[0]).params.update.content.text);
    expect(seen).toMatchObject({ cwd: await fs.realpath(dir), key: "session-token", telemetry: "off", bridgeConfig: null });
  });

  it("reports an agent that dies, once", async () => {
    const { host, frames, exits } = make();
    const { sessionId } = await host.start();
    host.send(JSON.stringify({ jsonrpc: "2.0", id: "p4", method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "die" }] } }));
    await until(() => exits.length > 0);
    expect(exits).toEqual([3]);
    expect(frames).toEqual([]);
  });

  it("does not report an exit it asked for", async () => {
    const { host, exits } = make();
    await host.start();
    host.stop();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(exits).toEqual([]);
  });

  it("refuses an agent that speaks another protocol version", async () => {
    const { host } = make({ env: { PATH: process.env.PATH, FAKE_PROTOCOL: "2" } });
    await expect(host.start()).rejects.toThrow(/ACP 2/);
  });

  it("fails the handshake when the agent is not there, rather than waiting out the timeout", async () => {
    const { host } = make({ command: ["/nonexistent/friday-acp"], timeoutMs: 20_000 });
    await expect(host.start()).rejects.toThrow();
  });

  it("continues the same conversation after a restart, and opens a new one when it cannot be loaded", async () => {
    const statePath = path.join(dir, "state", "bridge.json");
    const first = make({ statePath });
    const opened = await first.host.start();
    first.host.stop();
    expect(JSON.parse(await fs.readFile(statePath, "utf8"))).toEqual({ sessionId: opened.sessionId });

    const second = make({ statePath });
    expect((await second.host.start()).sessionId).toBe(opened.sessionId);
    second.host.stop();

    const third = make({ statePath, env: { PATH: process.env.PATH, FAKE_NO_LOAD: "1" } });
    const fresh = await third.host.start();
    expect(fresh.sessionId).not.toBe(opened.sessionId);
    expect(JSON.parse(await fs.readFile(statePath, "utf8")).sessionId).toBe(fresh.sessionId);
  });
});
