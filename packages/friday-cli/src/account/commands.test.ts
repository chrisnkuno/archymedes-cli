import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountFile, loadLink, serverUrl } from "./store";
import { runAccountCommand, type AccountDeps } from "./commands";
import { loadSettings, saveSettings } from "../platform/settings";

/** The parts of the account API a desktop uses, in memory: enough to run every command against. */
function fakeServer(options: { approveAfterPolls?: number; scopes?: string; expired?: boolean; vault?: Record<string, string>; reachable?: boolean } = {}) {
  const state = {
    polls: 0, tokenSecret: "lgn_abc.secrettoken", publicKey: "", scopes: options.scopes ?? "vault:write",
    vault: { ...(options.vault ?? {}) } as Record<string, string>, requests: [] as string[], logouts: 0, revoked: false, bodies: [] as unknown[],
  };
  const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status });
  const fetcher = async (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<Response> => {
    if (options.reachable === false) throw new Error("offline");
    const url = new URL(input);
    const method = init?.method ?? "GET";
    state.requests.push(`${method} ${url.pathname}`);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    state.bodies.push(body);
    const bearer = init?.headers?.authorization === `Bearer ${state.tokenSecret}`;
    if (url.pathname === "/api/device/code") {
      state.publicKey = body.publicKey;
      return json(200, { deviceCode: "device-code-0123456789abcdef", userCode: "BCDF-GHJK", verifyUrl: `${url.origin}/#link=BCDF-GHJK`, expiresIn: 600, interval: 1 });
    }
    if (url.pathname === "/api/device/token") {
      state.polls += 1;
      if (options.expired) return json(410, { status: "expired" });
      if (state.polls <= (options.approveAfterPolls ?? 1)) return json(202, { status: "pending" });
      // The server seals the login to the public key the desktop sent: only that desktop can open it.
      const key = await crypto.subtle.importKey("spki", Uint8Array.from(atob(state.publicKey), (c) => c.charCodeAt(0)), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"]);
      const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, key, new TextEncoder().encode(state.tokenSecret)));
      return json(200, { sealedToken: btoa(String.fromCharCode(...sealed)), scopes: state.scopes });
    }
    if (!bearer || state.revoked) return json(401, { error: "signed_out", message: "Sign in to continue." });
    if (url.pathname === "/api/me") return json(200, { user: { id: "usr_1", login: "chris" }, balanceMicros: 4_200_000, devices: [{ id: "lgn_abc", userAgent: "Friday CLI", current: true, scopes: state.scopes.split(",") }] });
    if (url.pathname === "/api/logout") { state.logouts += 1; state.revoked = true; return json(204, undefined); }
    if (url.pathname === "/api/vault" && method === "GET") {
      const slots = ["openrouter", "anthropic", "openai", "google", "xai", "deepseek", "mistral", "groq"].map((slot) => ({ slot, label: slot, help: "", set: slot in state.vault, ...(slot in state.vault ? { hint: `…${state.vault[slot].slice(-4)}` } : {}) }));
      return json(200, { configured: true, slots, sources: [] });
    }
    const slot = /^\/api\/vault\/([a-z]+)(\/reveal)?$/.exec(url.pathname);
    if (slot) {
      if (slot[2]) return state.scopes.includes("vault:read") ? (slot[1] in state.vault ? json(200, { value: state.vault[slot[1]] }) : json(404, { error: "not_found", message: "not set" })) : json(403, { error: "scope", message: "This device was not approved to download your keys." });
      if (method === "PUT") { if (!/^[\x21-\x7e]{16,}$/.test(body.value)) return json(400, { error: "value", message: "That is not a key." }); state.vault[slot[1]] = body.value; return json(200, { slot: slot[1], hint: `…${body.value.slice(-4)}` }); }
      if (method === "DELETE") { if (slot[1] in state.vault) { delete state.vault[slot[1]]; return json(204, undefined); } return json(404, { error: "not_found", message: "not set" }); }
    }
    return json(404, { error: "not_found", message: "Nothing here." });
  };
  return { state, fetcher };
}

let dir: string;
let out: string[];
let err: string[];
let env: Record<string, string | undefined>;
const deps = (server: ReturnType<typeof fakeServer>): AccountDeps => ({ environment: env, out: (l) => out.push(l), err: (l) => err.push(l), fetch: server.fetcher, sleep: async () => undefined, computerName: "test-laptop" });
const run = (server: ReturnType<typeof fakeServer>, ...argv: string[]) => runAccountCommand(argv, deps(server));
const everything = () => [...out, ...err].join("\n");

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "friday-account-"));
  env = { HOME: dir, XDG_CONFIG_HOME: path.join(dir, "config"), ARCHYMEDES_APP_URL: "https://app.test" };
  out = [];
  err = [];
});
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

describe("linking this computer", () => {
  it("shows an address and a code, waits for the confirmation, and keeps the login where only its owner can read it", async () => {
    const server = fakeServer({ approveAfterPolls: 2 });
    expect(await run(server, "login")).toBe(0);
    expect(out.join("\n")).toContain("https://app.test/#link=BCDF-GHJK");
    expect(out.join("\n")).toContain("BCDF-GHJK");
    expect(server.state.polls).toBe(3); // two "not yet", then yes
    const link = (await loadLink(env))!;
    expect(link).toMatchObject({ server: "https://app.test", login: "chris", token: "lgn_abc.secrettoken", scopes: ["vault:write"] });
    expect((await fs.stat(accountFile(env))).mode & 0o777).toBe(0o600);
    expect(out.join("\n")).toContain("Linked as chris");
    expect(out.join("\n")).not.toContain("secrettoken");
    expect(out.join("\n")).toContain("can add keys to your account. (To let it download");
  });

  it("opens the login with the key made for this link: the server only ever saw the public half", async () => {
    const server = fakeServer();
    await run(server, "login");
    const sent = server.state.bodies.find((body: any) => body?.publicKey) as { publicKey: string; name: string };
    expect(sent.name).toBe("test-laptop");
    expect(sent.publicKey).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.stringify(server.state.bodies)).not.toContain("PRIVATE");
  });

  it("says when the computer was allowed to download keys", async () => {
    await run(fakeServer({ scopes: "vault:write,vault:read" }), "login");
    expect(out.join("\n")).toContain("add keys to your account and download them");
    expect((await loadLink(env))!.scopes).toEqual(["vault:write", "vault:read"]);
  });

  it("gives up with a clear message when the code expires, and stores nothing", async () => {
    expect(await run(fakeServer({ expired: true }), "login")).toBe(1);
    expect(err.join("\n")).toContain("expired");
    expect(await loadLink(env)).toBeUndefined();
  });

  it("says so plainly when the server cannot be reached", async () => {
    expect(await run(fakeServer({ reachable: false }), "login")).toBe(1);
    expect(err.join("\n")).toMatch(/Could not reach https:\/\/app\.test/);
  });

  it("accepts a server on the command line, https only, except for this computer", async () => {
    expect(serverUrl({}, "https://example.com/")).toBe("https://example.com");
    expect(serverUrl({}, "http://localhost:8787")).toBe("http://localhost:8787");
    expect(serverUrl({}, "http://127.0.0.1:8799")).toBe("http://127.0.0.1:8799");
    for (const bad of ["http://example.com", "ftp://example.com", "not a url", "https://user:pass@example.com", "http://localhost.evil.com"]) expect(() => serverUrl({}, bad), bad).toThrow();
    expect(serverUrl({ ARCHYMEDES_APP_URL: "https://mine.test" })).toBe("https://mine.test");
    expect(serverUrl({})).toBe("https://app.archymedes.xyz");
  });
});

describe("being linked, or not", () => {
  it("asks for a login before anything that needs an account", async () => {
    const server = fakeServer();
    for (const argv of [["account"], ["keys"], ["keys", "push"], ["keys", "pull"]]) {
      out = []; err = [];
      expect(await run(server, ...argv), argv.join(" ")).toBe(1);
      expect(err.join("\n")).toContain("friday login");
    }
    expect(server.state.requests).toEqual([]);
  });

  it("shows who it is linked as, the balance, and what this computer may do", async () => {
    const server = fakeServer({ scopes: "vault:write,vault:read" });
    await run(server, "login");
    out = [];
    expect(await run(server, "account")).toBe(0);
    expect(out.join("\n")).toContain("Linked as chris on https://app.test");
    expect(out.join("\n")).toContain("Balance: $4.20");
    expect(out.join("\n")).toContain("add keys, download keys");
  });

  it("tells the person to log in again when the server no longer knows this link", async () => {
    const server = fakeServer();
    await run(server, "login");
    server.state.revoked = true;
    out = []; err = [];
    expect(await run(server, "account")).toBe(1);
    expect(err.join("\n")).toContain("friday login");
  });

  it("unlinks: the server first, then the file; and still the file when the server is away", async () => {
    const server = fakeServer();
    await run(server, "login");
    expect(await run(server, "logout")).toBe(0);
    expect(server.state.logouts).toBe(1);
    expect(await loadLink(env)).toBeUndefined();
    out = [];
    server.state.revoked = false; // a new link on the same account
    await run(server, "login");
    expect(await loadLink(env)).toBeDefined();
    out = [];
    const away = fakeServer({ reachable: false });
    expect(await run(away, "logout")).toBe(0);
    expect(await loadLink(env)).toBeUndefined();
    expect(out.join("\n")).toContain("could not be reached");
    out = [];
    expect(await run(server, "logout")).toBe(0);
    expect(out.join("\n")).toContain("was not linked");
  });
});

describe("keys", () => {
  const OPENAI = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789";
  const GROQ = "gsk_abcdefghijklmnopqrstuvwxyz0123456789";

  async function linked(options: Parameters<typeof fakeServer>[0] = {}) {
    const server = fakeServer(options);
    await run(server, "login");
    out = []; err = [];
    return server;
  }

  it("lists what the account holds, as hints", async () => {
    const server = await linked({ vault: { openai: OPENAI } });
    expect(await run(server, "keys")).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/openai\s+set …6789/);
    expect(text).toMatch(/anthropic\s+not set/);
    expect(text).not.toContain(OPENAI);
  });

  it("pushes the keys this computer has, skips the rest, never prints one, and keeps going past a refusal", async () => {
    const server = await linked();
    await saveSettings({ OPENAI_API_KEY: OPENAI, GROQ_API_KEY: GROQ, ANTHROPIC_API_KEY: "short" }, env);
    const code = await run(server, "keys", "push");
    const text = out.join("\n");
    expect(server.state.vault).toEqual({ openai: OPENAI, groq: GROQ });
    expect(text).toMatch(/openai\s+pushed\s+…6789/);
    expect(text).toMatch(/groq\s+pushed/);
    expect(text).toMatch(/anthropic\s+failed\s+That is not a key/);
    expect(text).toMatch(/openrouter\s+skipped\s+no key on this computer/);
    expect(text).toContain("2 keys pushed, 1 failed.");
    expect(code).toBe(1);
    expect(text).not.toContain(OPENAI);
    expect(text).not.toContain(GROQ);
  });

  it("pushes only the providers asked for, and refuses a name it does not know", async () => {
    const server = await linked();
    await saveSettings({ OPENAI_API_KEY: OPENAI, GROQ_API_KEY: GROQ }, env);
    await run(server, "keys", "push", "groq");
    expect(server.state.vault).toEqual({ groq: GROQ });
    err = [];
    expect(await run(server, "keys", "push", "claude")).toBe(1);
    expect(err.join("\n")).toContain("No such provider: claude");
  });

  it("reads a key from the environment when none is saved", async () => {
    const server = await linked();
    env.OPENAI_API_KEY = OPENAI;
    await run(server, "keys", "push", "openai");
    expect(server.state.vault.openai).toBe(OPENAI);
  });

  it("pulls only into the empty places, and replaces with --force", async () => {
    const server = await linked({ scopes: "vault:write,vault:read", vault: { openai: OPENAI, groq: GROQ } });
    await saveSettings({ OPENAI_API_KEY: "sk-local-already-here-0123456789" }, env);
    expect(await run(server, "keys", "pull")).toBe(0);
    let settings = await loadSettings(env);
    expect(settings.OPENAI_API_KEY).toBe("sk-local-already-here-0123456789"); // kept
    expect(settings.GROQ_API_KEY).toBe(GROQ); // brought in
    expect(out.join("\n")).toMatch(/openai\s+skipped\s+already set here/);
    expect(out.join("\n")).not.toContain(GROQ);
    out = [];
    await run(server, "keys", "pull", "--force");
    settings = await loadSettings(env);
    expect(settings.OPENAI_API_KEY).toBe(OPENAI);
  });

  it("writes the settings readable by their owner alone", async () => {
    const server = await linked({ scopes: "vault:write,vault:read", vault: { groq: GROQ } });
    await run(server, "keys", "pull");
    const file = path.join(dir, "config", "archymedes", "settings.json");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });

  it("explains how to get the right to download when this computer was not given it", async () => {
    const server = await linked({ scopes: "vault:write", vault: { openai: OPENAI } });
    expect(await run(server, "keys", "pull")).toBe(1);
    expect(err.join("\n")).toContain("not approved to download your keys");
    expect(err.join("\n")).toContain("friday login");
    expect(await loadSettings(env)).toEqual({});
  });

  it("removes a key from the account", async () => {
    const server = await linked({ vault: { openai: OPENAI } });
    expect(await run(server, "keys", "remove", "openai")).toBe(0);
    expect(out.join("\n")).toContain("Removed your openai key");
    expect(server.state.vault).toEqual({});
    out = [];
    await run(server, "keys", "remove", "openai");
    expect(out.join("\n")).toContain("had no openai key");
    expect(await run(server, "keys", "remove")).toBe(1);
  });

  it("refuses an action it does not know, and prints what it does", async () => {
    const server = await linked();
    expect(await run(server, "keys", "rotate")).toBe(1);
    expect(err.join("\n")).toContain("friday keys push");
    out = []; err = [];
    expect(await run(server, "whatever")).toBe(1);
    expect(err.join("\n")).toContain("friday login");
  });
});
