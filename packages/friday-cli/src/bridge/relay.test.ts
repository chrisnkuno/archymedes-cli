import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Relay, type ControlResult, type RelayOptions, type SocketLike } from "./relay";

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;
  onopen: SocketLike["onopen"] = null;
  onmessage: SocketLike["onmessage"] = null;
  onclose: SocketLike["onclose"] = null;
  onerror: SocketLike["onerror"] = null;
  constructor(readonly url: string, readonly headers: Record<string, string>) {}
  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }
  open() { this.onopen?.({}); }
  receive(message: unknown) { this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) }); }
  drop() { this.onclose?.({}); }
  get frames() { return this.sent.map((text) => JSON.parse(text)).filter((message) => message.t === "frame").map((message) => message.frame); }
  get hellos() { return this.sent.map((text) => JSON.parse(text)).filter((message) => message.t === "hello"); }
}

const config = { url: "wss://app.example/api/bridge/s1", secret: "secret-one-0123456789" };

function setup(overrides: Partial<RelayOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const inbound: string[] = [];
  const byes: string[] = [];
  const relay = new Relay({
    socket: (url, init) => { const socket = new FakeSocket(url, init.headers); sockets.push(socket); return socket; },
    hello: () => ({ version: 1, acpSessionId: "agent-1", mode: "build" }),
    onFrame: (line) => inbound.push(line),
    onControl: async () => ({ ok: true }),
    onBye: (reason) => byes.push(reason),
    random: () => 1,
    ...overrides,
  });
  return { relay, sockets, inbound, byes, last: () => sockets[sockets.length - 1] };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("connecting", () => {
  it("dials with the secret as a bearer header and says hello when the socket opens", () => {
    const { relay, last } = setup();
    relay.setConfig(config);
    expect(last().url).toBe(config.url);
    expect(last().headers).toEqual({ Authorization: `Bearer ${config.secret}` });
    expect(last().sent).toEqual([]);
    last().open();
    expect(last().hellos).toEqual([{ t: "hello", version: 1, acpSessionId: "agent-1", mode: "build" }]);
    expect(relay.connected).toBe(true);
  });

  it("does nothing for a config it already has, and redials at once for a new secret", () => {
    const { relay, sockets } = setup();
    relay.setConfig(config);
    sockets[0].open();
    relay.setConfig({ ...config });
    expect(sockets).toHaveLength(1);
    relay.setConfig({ ...config, secret: "secret-two-0123456789" });
    expect(sockets).toHaveLength(2);
    expect(sockets[0].closed).toBe(true);
    expect(sockets[1].headers.Authorization).toBe("Bearer secret-two-0123456789");
  });

  it("ignores what an abandoned socket says afterwards", () => {
    const { relay, sockets } = setup();
    relay.setConfig(config);
    sockets[0].open();
    relay.setConfig({ ...config, secret: "secret-two-0123456789" });
    sockets[0].drop(); // the old one closing late must not trigger a second redial
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });
});

describe("frames", () => {
  it("wraps the agent's messages and unwraps the phone's", () => {
    const { relay, sockets, inbound } = setup();
    relay.setConfig(config);
    sockets[0].open();
    relay.send('{"jsonrpc":"2.0","method":"session/update","params":{"n":1}}');
    expect(sockets[0].frames).toEqual([{ jsonrpc: "2.0", method: "session/update", params: { n: 1 } }]);
    sockets[0].receive({ t: "frame", frame: { jsonrpc: "2.0", id: "p1", method: "session/prompt" } });
    expect(inbound).toEqual(['{"jsonrpc":"2.0","id":"p1","method":"session/prompt"}']);
  });

  it("drops a line that is not JSON rather than sending garbage", () => {
    const { relay, sockets } = setup();
    relay.setConfig(config);
    sockets[0].open();
    relay.send("not json at all");
    expect(sockets[0].frames).toEqual([]);
  });

  it("keeps the agent's frames in order while disconnected and sends them after the next hello", () => {
    const { relay, sockets } = setup();
    relay.send('{"n":1}'); // before any config
    relay.setConfig(config);
    relay.send('{"n":2}'); // dialling, not yet open
    sockets[0].open();
    expect(sockets[0].sent.map((text) => JSON.parse(text).t)).toEqual(["hello", "frame", "frame"]);
    expect(sockets[0].frames).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it("drops the oldest past its bound and says how many in the next hello", () => {
    const { relay, sockets } = setup({ maxBuffered: 3 });
    relay.setConfig(config);
    for (let n = 1; n <= 5; n += 1) relay.send(JSON.stringify({ n }));
    sockets[0].open();
    expect(sockets[0].frames).toEqual([{ n: 3 }, { n: 4 }, { n: 5 }]);
    expect(sockets[0].hellos[0].dropped).toBe(2);
    // Said once, not on every later hello.
    relay.announce();
    expect(sockets[0].hellos[1].dropped).toBeUndefined();
  });

  it("announces only on an open connection", () => {
    const { relay, sockets } = setup();
    relay.announce();
    relay.setConfig(config);
    relay.announce();
    expect(sockets[0].sent).toEqual([]);
    sockets[0].open();
    relay.announce();
    expect(sockets[0].hellos).toHaveLength(2);
  });
});

describe("coming back", () => {
  it("redials after a loss with doubling waits to a ceiling, and starts over once connected", () => {
    const { relay, sockets } = setup();
    relay.setConfig(config);
    const waits: number[] = [];
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const before = sockets.length;
      sockets[before - 1].drop();
      let waited = 0;
      while (sockets.length === before) { vi.advanceTimersByTime(50); waited += 50; }
      waits.push(waited);
    }
    expect(waits).toEqual([500, 1000, 2000, 4000, 8000, 15_000, 15_000, 15_000]);
    sockets[sockets.length - 1].open();
    sockets[sockets.length - 1].drop();
    const before = sockets.length;
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(before + 1);
  });

  it("never has two redials pending", () => {
    const { relay, sockets } = setup();
    relay.setConfig(config);
    sockets[0].onerror?.({});
    sockets[0].onclose?.({}); // an error and a close for one failure
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(2);
  });

  it("stops for good once closed", () => {
    const { relay, sockets } = setup();
    relay.setConfig(config);
    sockets[0].open();
    relay.close();
    sockets[0].drop();
    vi.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].closed).toBe(true);
  });
});

describe("the heartbeat", () => {
  it("sends the literal ping the server answers without waking", () => {
    const { relay, sockets } = setup({ heartbeatMs: 1_000, pongTimeoutMs: 500 });
    relay.setConfig(config);
    sockets[0].open();
    vi.advanceTimersByTime(1_000);
    expect(sockets[0].sent.at(-1)).toBe('{"t":"ping"}');
  });

  it("redials at once when nothing answers, as after a pause and resume", () => {
    const { relay, sockets } = setup({ heartbeatMs: 1_000, pongTimeoutMs: 500 });
    relay.setConfig(config);
    sockets[0].open();
    vi.advanceTimersByTime(1_000 + 500);
    expect(sockets[0].closed).toBe(true);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    expect(relay.connected).toBe(false);
  });

  it("stays connected while pongs, or any traffic, come back", () => {
    const { relay, sockets } = setup({ heartbeatMs: 1_000, pongTimeoutMs: 500 });
    relay.setConfig(config);
    sockets[0].open();
    for (let beat = 0; beat < 5; beat += 1) {
      vi.advanceTimersByTime(1_000); // a ping goes out on every second
      expect(sockets[0].sent.at(-1)).toBe('{"t":"ping"}');
      sockets[0].receive(beat % 2 === 0 ? '{"t":"pong"}' : { t: "frame", frame: { n: beat } });
    }
    expect(sockets).toHaveLength(1);
    expect(relay.connected).toBe(true);
  });
});

describe("what the server asks", () => {
  it("runs a control request and answers with its result", async () => {
    const calls: unknown[] = [];
    const { relay, sockets } = setup({ onControl: async (op, args): Promise<ControlResult> => { calls.push([op, args]); return { ok: true, detail: { dir: "/workspace/app" } }; } });
    relay.setConfig(config);
    sockets[0].open();
    sockets[0].receive({ t: "control", id: "c1", op: "clone", args: { url: "https://github.com/o/r" } });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual([["clone", { url: "https://github.com/o/r" }]]);
    expect(sockets[0].sent.map((text) => JSON.parse(text)).find((message) => message.t === "result")).toEqual({ t: "result", id: "c1", ok: true, detail: { dir: "/workspace/app" } });
  });

  it("answers a failing control request with the failure, not silence", async () => {
    const { relay, sockets } = setup({ onControl: async () => { throw new Error("disk full"); } });
    relay.setConfig(config);
    sockets[0].open();
    sockets[0].receive({ t: "control", id: "c2", op: "push", args: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(sockets[0].sent.at(-1)!)).toEqual({ t: "result", id: "c2", ok: false, detail: "disk full" });
  });

  it("ignores malformed control requests and unknown messages", async () => {
    const { relay, sockets, inbound } = setup();
    relay.setConfig(config);
    sockets[0].open();
    sockets[0].receive({ t: "control", op: "clone" }); // no id
    sockets[0].receive({ t: "mystery" });
    sockets[0].receive("not json");
    sockets[0].receive({ t: "frame" }); // no frame
    await vi.advanceTimersByTimeAsync(0);
    expect(inbound).toEqual([]);
    expect(sockets[0].sent.map((text) => JSON.parse(text).t)).toEqual(["hello"]);
  });

  it("passes on that the session is over", () => {
    const { relay, sockets, byes } = setup();
    relay.setConfig(config);
    sockets[0].open();
    sockets[0].receive({ t: "bye", reason: "killed" });
    expect(byes).toEqual(["killed"]);
  });
});
