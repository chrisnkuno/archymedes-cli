import { describe, expect, it } from "vitest";
import { parseBridgeConfig } from "./config";

const valid = { url: "wss://app.archymedes.xyz/api/bridge/ses_abc123", secret: "0123456789abcdef0123", sessionId: "ses_abc123", cwd: "/workspace/app", env: { OPENROUTER_API_KEY: "tok", OPENROUTER_BASE_URL: "https://app.archymedes.xyz/api/model/v1" } };

describe("the bridge's session config", () => {
  it("reads a complete config", () => {
    expect(parseBridgeConfig(JSON.stringify(valid))).toEqual({ ...valid, files: [] });
  });

  it("reads files for the agent's configuration folder, and nowhere else", () => {
    const ok = { path: ".config/archymedes/free-install.json", content: '{"gateway":"g","token":"t"}' };
    expect(parseBridgeConfig(JSON.stringify({ ...valid, files: [ok] })).files).toEqual([ok]);
    expect(parseBridgeConfig(JSON.stringify(valid)).files).toEqual([]);
    for (const path of ["/etc/passwd", ".ssh/authorized_keys", ".bashrc", ".config/archymedes/../../.ssh/id", ".config/other/x", ".config/archymedes/", "../x", ".config/archymedes//x", ".config/archymedes/a\\b", ".config/archymedes/x\u0000y", ".config/archymedes/" + "x".repeat(300)]) {
      expect(() => parseBridgeConfig(JSON.stringify({ ...valid, files: [{ path, content: "x" }] })), path).toThrow(/session\.json/);
    }
    expect(() => parseBridgeConfig(JSON.stringify({ ...valid, files: [{ path: ".config/archymedes/a", content: "x".repeat(17_000) }] }))).toThrow(/too large/);
    expect(() => parseBridgeConfig(JSON.stringify({ ...valid, files: Array.from({ length: 5 }, (_, n) => ({ path: `.config/archymedes/f${n}`, content: "x" })) }))).toThrow(/at most/);
    expect(() => parseBridgeConfig(JSON.stringify({ ...valid, files: "no" }))).toThrow(/list/);
    expect(() => parseBridgeConfig(JSON.stringify({ ...valid, files: [{ path: ".config/archymedes/a" }] }))).toThrow(/path and content/);
  });

  it("defaults the environment to nothing", () => {
    const { env, ...rest } = valid;
    expect(parseBridgeConfig(JSON.stringify(rest)).env).toEqual({});
  });

  it("accepts ws:// only for a local address", () => {
    for (const url of ["ws://127.0.0.1:8787/api/bridge/x", "ws://localhost/api/bridge/x", "ws://[::1]:1/a/"]) {
      expect(() => parseBridgeConfig(JSON.stringify({ ...valid, url }))).not.toThrow();
    }
    for (const url of ["ws://example.com/x", "http://app.archymedes.xyz/x", "ws://127.0.0.1.evil.com/x", "wss:/missing", ""]) {
      expect(() => parseBridgeConfig(JSON.stringify({ ...valid, url })), url).toThrow(/url/);
    }
  });

  it.each([
    ["not json", "{"],
    ["an array", "[]"],
    ["a short secret", JSON.stringify({ ...valid, secret: "short" })],
    ["a missing session", JSON.stringify({ ...valid, sessionId: undefined })],
    ["a session id with a slash", JSON.stringify({ ...valid, sessionId: "a/b/c/d/e" })],
    ["a relative cwd", JSON.stringify({ ...valid, cwd: "workspace" })],
    ["an env that is a list", JSON.stringify({ ...valid, env: ["A=1"] })],
    ["an env name with a space", JSON.stringify({ ...valid, env: { "A B": "1" } })],
    ["an env value that is a number", JSON.stringify({ ...valid, env: { A: 1 } })],
  ])("refuses %s", (_name, raw) => {
    expect(() => parseBridgeConfig(raw)).toThrow(/session\.json/);
  });
});
