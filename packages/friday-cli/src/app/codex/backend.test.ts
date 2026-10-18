import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexEnvironment, codexOverview, codexReadiness, connectCodex, findCodex, learnCodexModels, codexModels, parseLoginStatus, withCodex } from "./backend";

const deps = (run: (args: string[]) => { code: number | null; output: string }, PATH = "/bin") => ({
  environment: {}, processEnvironment: { PATH }, home: "/home/x",
  run: async (_command: string, args: string[]) => run(args),
});

describe("Codex as a provider", () => {
  it("finds codex on the PATH, or where an override points", () => {
    expect(findCodex({ PATH: "/a:/b" }, { exists: (file) => file === "/b/codex", platform: "linux" })).toBe("/b/codex");
    expect(findCodex({ PATH: "/a", ARCHYMEDES_CODEX_PATH: "/opt/codex" }, { exists: (file) => file === "/opt/codex" })).toBe("/opt/codex");
    expect(findCodex({ PATH: "/a" }, { exists: () => false })).toBeUndefined();
  });

  it("reads `codex login status`", () => {
    expect(parseLoginStatus(0, "Logged in using ChatGPT")).toEqual({ loggedIn: true, method: "chatgpt" });
    expect(parseLoginStatus(0, "Logged in using an API key - sk-…")).toEqual({ loggedIn: true, method: "apiKey" });
    expect(parseLoginStatus(1, "Not logged in")).toEqual({ loggedIn: false });
    expect(parseLoginStatus(null, "")).toEqual({ loggedIn: false, error: "codex did not start" });
  });

  it("is a row that says what it needs: installing, then signing in (with the command), then ready", async () => {
    const missing = await codexOverview({ environment: {}, processEnvironment: { PATH: "/nowhere-at-all" }, home: "/nowhere-at-all" });
    expect(missing).toMatchObject({ id: "codex", configured: false, keyUrl: expect.stringContaining("codex") });
    const bin = mkdtempSync(path.join(os.tmpdir(), "codex-bin-"));
    writeFileSync(path.join(bin, "codex"), "");
    try {
      const signedOut = await codexReadiness(deps(() => ({ code: 1, output: "Not logged in" }), bin), { fresh: true });
      expect(signedOut).toMatchObject({ ready: false, needs: "sign-in", missing: "signing in to Codex (codex login)" });
      const row = await codexOverview(deps(() => ({ code: 1, output: "Not logged in" }), bin));
      expect(row.login).toEqual([path.join(bin, "codex"), "login"]);
      const ready = await codexReadiness(deps(() => ({ code: 0, output: "Logged in using ChatGPT" }), bin), { fresh: true });
      expect(ready).toMatchObject({ ready: true, executable: path.join(bin, "codex") });
      expect((await codexOverview(deps(() => ({ code: 0, output: "Logged in using ChatGPT" }), bin))).note).toContain("ChatGPT");
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("connecting checks again and says what to do", async () => {
    const result = await connectCodex({ environment: {}, processEnvironment: { PATH: "/nowhere-at-all" }, home: "/nowhere-at-all" });
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("Install Codex") });
  });

  it("keeps Friday's OpenAI key from Codex unless told to bill it", () => {
    expect(codexEnvironment({ OPENAI_API_KEY: "sk", PATH: "/bin" })).toEqual({ PATH: "/bin" });
    expect(codexEnvironment({ OPENAI_API_KEY: "sk", ARCHYMEDES_CODEX_BILLING: "api" })).toMatchObject({ OPENAI_API_KEY: "sk" });
  });

  it("lists the models a session learned, default first, and sits after Claude", () => {
    learnCodexModels(["gpt-5.6-luna", "gpt-6-luna"]);
    expect(codexModels()).toEqual(["default", "gpt-5.6-luna", "gpt-6-luna"]);
    expect(withCodex([{ id: "free" }, { id: "claude" }, { id: "openai" }], { id: "codex" }).map((row) => row.id)).toEqual(["free", "claude", "codex", "openai"]);
    expect(withCodex([{ id: "free" }, { id: "openai" }], { id: "codex" }).map((row) => row.id)).toEqual(["free", "codex", "openai"]);
  });
});
