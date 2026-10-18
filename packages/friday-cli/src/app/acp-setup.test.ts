import { describe, expect, it } from "vitest";
import { saveSetup, setupStatus } from "./acp-setup";

describe("first-run setup over acp", () => {
  it("reports nothing configured, free first, with where to get each key", () => {
    const status = setupStatus({});
    expect(status.configured).toBe(false);
    expect(status.reason).toBeTruthy();
    expect(status.providers[0]).toMatchObject({ id: "free", keyVariable: "OPENROUTER_API_KEY", keyUrl: "https://openrouter.ai/keys", configured: false });
    expect(status.providers.find((p) => p.id === "anthropic")).toMatchObject({ keyVariable: "ANTHROPIC_API_KEY", configured: false });
    // More than a key: not offered in the one-key setup.
    expect(status.providers.find((p) => p.id === "openai-compatible")?.keyVariable).toBeUndefined();
    expect(setupStatus({ ANTHROPIC_API_KEY: "sk-ant-x" }).configured).toBe(true);
    // The provider asked for on the command line is the one judged, as session/new will judge it.
    expect(setupStatus({ ANTHROPIC_API_KEY: "sk-ant-x" }, { provider: "openai" }).configured).toBe(false);
  });

  it("saves a key, and the live environment resolves the provider at once", async () => {
    const environment: Record<string, string | undefined> = {};
    let saved: Record<string, string | undefined> = {};
    const result = await saveSetup({ provider: "anthropic", key: "  sk-ant-test  " }, {
      environment, processEnvironment: {},
      load: async () => ({ ARCHYMEDES_THEME: "parchment" }),
      save: async (settings) => { saved = settings; return "/cfg/settings.json"; },
    });
    expect(result).toEqual({ ok: true, file: "/cfg/settings.json" });
    expect(saved).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-test", ARCHYMEDES_PROVIDER: "anthropic", ARCHYMEDES_THEME: "parchment" });
    expect(setupStatus(environment).configured).toBe(true);
  });

  it("refuses an OpenRouter key the service rejects, and keeps one it could not check", async () => {
    const deps = { environment: {}, processEnvironment: {}, load: async () => ({}), save: async () => "/f" };
    const rejected = await saveSetup({ provider: "free", key: "sk-or-bad" }, { ...deps, checkOpenRouter: async () => ({ ok: false, reason: "invalid", status: 401 }) as never });
    expect(rejected.ok).toBe(false);
    const offline = await saveSetup({ provider: "free", key: "sk-or-good" }, { ...deps, checkOpenRouter: async () => ({ ok: false, reason: "network", message: "offline" }) as never });
    expect(offline).toMatchObject({ ok: true, note: expect.stringContaining("Saved anyway") });
  });

  it("rejects what cannot be set with one key", async () => {
    const deps = { environment: {}, processEnvironment: {}, load: async () => ({}), save: async () => "/f" };
    expect(await saveSetup({ provider: "nope", key: "x" }, deps)).toMatchObject({ ok: false });
    expect(await saveSetup({ provider: "openai-compatible", key: "x" }, deps)).toMatchObject({ ok: false, error: expect.stringContaining("friday settings") });
    expect(await saveSetup({ provider: "anthropic", key: "   " }, deps)).toMatchObject({ ok: false });
  });
});

import { providerOverview } from "./acp-setup";

describe("providerOverview", () => {
  it("lists every provider free first, with what is missing, the model it would use and the default", () => {
    const rows = providerOverview({ OPENAI_API_KEY: "sk-x", OPENAI_MODEL: "gpt-custom", ARCHYMEDES_PROVIDER: "openai" });
    expect(rows[0].id).toBe("free");
    const openai = rows.find((row) => row.id === "openai")!;
    expect(openai).toMatchObject({ configured: true, missing: [], model: "gpt-custom", isDefault: true, keyVariable: "OPENAI_API_KEY" });
    const anthropic = rows.find((row) => row.id === "anthropic")!;
    expect(anthropic).toMatchObject({ configured: false, missing: ["ANTHROPIC_API_KEY"], model: "claude-sonnet-5", isDefault: false });
    expect(anthropic.keyUrl).toContain("anthropic.com");
    const compatible = rows.find((row) => row.id === "openai-compatible")!;
    expect(compatible.keyVariable).toBeUndefined();
    expect(compatible.missing.length).toBeGreaterThan(1);
  });
});
