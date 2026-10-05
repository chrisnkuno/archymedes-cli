import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jevOptionsFromEnvironment } from "./jev";
import { loadSettings, saveSettings, SETTING_FIELDS, validateSetting } from "../platform/settings";

const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("jev configuration from the environment", () => {
  it("is on with a key, carrying an explicit model when one is set", () => {
    expect(jevOptionsFromEnvironment({ TYPESAFE_API_KEY: "ts-key" })).toMatchObject({ apiKey: "ts-key" });
    expect(jevOptionsFromEnvironment({ TYPESAFE_API_KEY: "ts-key", TYPESAFE_MODEL: "jev-1.13.0" }))
      .toMatchObject({ apiKey: "ts-key", model: "jev-1.13.0" });
  });

  it("is off without a key, with a blank key, or when explicitly disabled", () => {
    expect(jevOptionsFromEnvironment({})).toBeUndefined();
    expect(jevOptionsFromEnvironment({ TYPESAFE_API_KEY: "   " })).toBeUndefined();
    expect(jevOptionsFromEnvironment({ TYPESAFE_API_KEY: "ts-key", ARCHYMEDES_JEV: "off" })).toBeUndefined();
    expect(jevOptionsFromEnvironment({ TYPESAFE_API_KEY: "ts-key", ARCHYMEDES_JEV: "OFF" })).toBeUndefined();
  });

  it("trims the key it passes through", () => {
    expect(jevOptionsFromEnvironment({ TYPESAFE_API_KEY: "  ts-key  " })).toMatchObject({ apiKey: "ts-key" });
  });

  it("offers both keys as secret settings the user can paste", () => {
    // The whole point: the user brings their own keys. Both must exist, both secret,
    // neither printed back.
    expect(SETTING_FIELDS.find((field) => field.key === "TYPESAFE_API_KEY")).toMatchObject({ secret: true });
    expect(SETTING_FIELDS.find((field) => field.key === "OPENROUTER_API_KEY")).toMatchObject({ secret: true });
    expect(SETTING_FIELDS.find((field) => field.key === "ARCHYMEDES_JEV")).toBeDefined();
  });

  it("stores the user's own keys and reads them back", async () => {
    const env = { ARCHYMEDES_CONFIG_DIR: await mkdtemp(path.join(os.tmpdir(), "archymedes-jev-")) };
    dirs.push(env.ARCHYMEDES_CONFIG_DIR);
    await saveSettings({ TYPESAFE_API_KEY: "ts-user-key", OPENROUTER_API_KEY: "or-user-key", ARCHYMEDES_JEV: "on" }, env);
    const loaded = await loadSettings(env);
    expect(loaded).toMatchObject({ TYPESAFE_API_KEY: "ts-user-key", OPENROUTER_API_KEY: "or-user-key", ARCHYMEDES_JEV: "on" });
    expect(validateSetting("ARCHYMEDES_JEV", "OFF")).toBe("off");
    // The agent runs off exactly what the user saved — nothing else.
    expect(jevOptionsFromEnvironment({ ...loaded })).toMatchObject({ apiKey: "ts-user-key" });
  });
});
