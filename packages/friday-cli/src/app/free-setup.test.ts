import { describe, expect, it, vi } from "vitest";
import type { KeyCheck } from "@archymedes/core/providers/openrouter-key-info";
import { SETTING_CANCELLED, type ArchymedesSettings } from "../platform/settings";
import { describeKeyAllowance, FREE_PRIVACY_NOTICE, FREE_SETUP_INTRO, needsFreePrivacyNotice, OPENROUTER_KEYS_URL, runFreeModeSetup, showFreePrivacyNoticeOnce } from "./free-setup";

function harness(answers: Array<string | Error>, checks: KeyCheck[] = []) {
  let output = "";
  const saves: ArchymedesSettings[] = [];
  const io = {
    write: (text: string) => { output += text; },
    askSecret: vi.fn(async () => {
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next ?? "";
    }),
    check: vi.fn(async () => checks.shift() ?? { ok: true as const, info: {} }),
    save: vi.fn(async (settings: ArchymedesSettings) => { saves.push(settings); return "/config/settings.json"; }),
  };
  return { io, saves, output: () => output };
}

describe("free mode setup", () => {
  it("explains in three lines, names the keys URL, then saves the checked key and selects free mode", async () => {
    const { io, saves, output } = harness(["  sk-or-v1-abcdef123456  "], [{ ok: true, info: { freeDailyRequests: { used: 0, limit: 50, remaining: 50 } } }]);
    const saved = await runFreeModeSetup({ ARCHYMEDES_THEME: "dark" }, io);
    expect(FREE_SETUP_INTRO).toHaveLength(3);
    for (const line of FREE_SETUP_INTRO) expect(output()).toContain(line);
    expect(output()).toContain(OPENROUTER_KEYS_URL);
    expect(io.check).toHaveBeenCalledWith("sk-or-v1-abcdef123456");
    expect(saved).toEqual({ ARCHYMEDES_THEME: "dark", OPENROUTER_API_KEY: "sk-or-v1-abcdef123456", ARCHYMEDES_PROVIDER: "free" });
    expect(saves).toEqual([saved]);
    expect(output()).toContain("Free mode is ready (50/50 free requests left today)");
    // The key itself is never printed back.
    expect(output()).not.toContain("abcdef123456");
  });

  it.each([["Esc", SETTING_CANCELLED], ["an empty answer", "   "], ["Ctrl+C", new Error("aborted")]])("cancels on %s without saving", async (_name, answer) => {
    const { io, output } = harness([answer]);
    expect(await runFreeModeSetup({}, io)).toBeUndefined();
    expect(io.save).not.toHaveBeenCalled();
    expect(io.check).not.toHaveBeenCalled();
    expect(output()).toContain("Free mode setup cancelled");
  });

  it("asks again when OpenRouter refuses the key, and gives up after three refusals", async () => {
    const refused: KeyCheck = { ok: false, reason: "invalid", status: 401 };
    const retried = harness(["bad", "good"], [refused, { ok: true, info: {} }]);
    expect(await runFreeModeSetup({}, retried.io)).toMatchObject({ OPENROUTER_API_KEY: "good" });
    expect(retried.output()).toContain("did not accept that key");
    const stopped = harness(["a", "b", "c"], [refused, refused, refused]);
    expect(await runFreeModeSetup({}, stopped.io)).toBeUndefined();
    expect(stopped.io.save).not.toHaveBeenCalled();
    expect(stopped.output()).toContain("Free mode setup stopped");
  });

  it("saves the key anyway when OpenRouter cannot be reached, so an offline first run is no dead end", async () => {
    const { io, output } = harness(["sk-or-v1-offline"], [{ ok: false, reason: "network" }]);
    expect(await runFreeModeSetup({}, io)).toMatchObject({ OPENROUTER_API_KEY: "sk-or-v1-offline", ARCHYMEDES_PROVIDER: "free" });
    expect(output()).toContain("Saving it anyway");
  });

  it("describes what the key allows when OpenRouter says", () => {
    expect(describeKeyAllowance({ ok: true, info: { freeDailyRequests: { limit: 1000, remaining: 998 } } })).toBe("998/1000 free requests left today");
    expect(describeKeyAllowance({ ok: true, info: { freeDailyRequests: { limit: 50 } } })).toBe("limit: 50 req/day");
    expect(describeKeyAllowance({ ok: true, info: {} })).toBeUndefined();
  });
});

describe("free mode privacy notice", () => {
  it("is shown once, recorded in settings, and never asks anything", async () => {
    const environment: Record<string, string | undefined> = {};
    let output = "";
    const save = vi.fn(async () => "/config/settings.json");
    const first = await showFreePrivacyNoticeOnce({ environment, saved: { FREE_MODEL: "openrouter/free" }, write: (text) => { output += text; }, save });
    expect(output).toContain(FREE_PRIVACY_NOTICE);
    expect(FREE_PRIVACY_NOTICE).toBe("Free models may log your prompts and code; don't send secrets. Use a paid provider for private code.");
    expect(first).toEqual({ FREE_MODEL: "openrouter/free", ARCHYMEDES_FREE_PRIVACY_ACK: "yes" });
    expect(save).toHaveBeenCalledWith(first);
    expect(await showFreePrivacyNoticeOnce({ environment, saved: first!, write: (text) => { output += text; }, save })).toBeUndefined();
    expect(output.split(FREE_PRIVACY_NOTICE)).toHaveLength(2);
  });

  it("reads the acknowledgement from settings and survives a failed save", async () => {
    expect(needsFreePrivacyNotice({ ARCHYMEDES_FREE_PRIVACY_ACK: "YES" })).toBe(false);
    expect(needsFreePrivacyNotice({})).toBe(true);
    const result = await showFreePrivacyNoticeOnce({ environment: {}, saved: {}, write: () => undefined, save: async () => { throw new Error("read-only"); } });
    expect(result).toEqual({ ARCHYMEDES_FREE_PRIVACY_ACK: "yes" });
  });
});
