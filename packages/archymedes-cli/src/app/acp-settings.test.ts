import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { listSettings, setSetting } from "./acp-settings";

let dir: string;
let processEnvironment: Record<string, string | undefined>;
let environment: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "acp-settings-"));
  processEnvironment = { ARCHYMEDES_CONFIG_DIR: dir };
  environment = { ...processEnvironment };
});
afterEach(() => fs.rm(dir, { recursive: true, force: true }));

describe("settings over acp", () => {
  it("lists every field with its section and kind, and no secret value", async () => {
    await setSetting({ key: "OPENROUTER_API_KEY", value: "sk-or-v1-supersecretvalue" }, { environment, processEnvironment });
    const { rows, file } = await listSettings(processEnvironment);
    expect(file).toContain(dir);
    const key = rows.find((row) => row.key === "OPENROUTER_API_KEY")!;
    expect(key).toMatchObject({ kind: "secret", isSet: true });
    expect(JSON.stringify(rows)).not.toContain("supersecretvalue");
    expect(rows.find((row) => row.key === "ARCHYMEDES_THEME")).toMatchObject({ kind: "choice", section: "Appearance" });
    expect(rows.find((row) => row.key === "ARCHYMEDES_THEME")!.choices!.length).toBeGreaterThan(3);
    expect(new Set(rows.map((row) => row.section)).size).toBeGreaterThan(3);
  });

  it("validates with the terminal menu's rules and saves what passes", async () => {
    expect(await setSetting({ key: "ARCHYMEDES_SIMPLE", value: "maybe" }, { environment, processEnvironment })).toMatchObject({ ok: false, error: expect.stringContaining("Choose one of") });
    expect(await setSetting({ key: "OPENAI_BASE_URL", value: "http://example.com" }, { environment, processEnvironment })).toMatchObject({ ok: false, error: expect.stringContaining("HTTPS") });
    expect(await setSetting({ key: "ARCHYMEDES_SIMPLE", value: "ON" }, { environment, processEnvironment })).toMatchObject({ ok: true, value: "on" });
    expect(environment.ARCHYMEDES_SIMPLE).toBe("on");
    expect((await listSettings(processEnvironment)).rows.find((row) => row.key === "ARCHYMEDES_SIMPLE")).toMatchObject({ value: "on", isSet: true });
  });

  it("clears a setting from the file and from the live environment", async () => {
    await setSetting({ key: "OPENAI_MODEL", value: "gpt-x" }, { environment, processEnvironment });
    expect(environment.OPENAI_MODEL).toBe("gpt-x");
    expect(await setSetting({ key: "OPENAI_MODEL", value: "" }, { environment, processEnvironment })).toMatchObject({ ok: true, isSet: false });
    expect(environment.OPENAI_MODEL).toBeUndefined();
    expect((await listSettings(processEnvironment)).rows.find((row) => row.key === "OPENAI_MODEL")!.isSet).toBe(false);
  });

  it("refuses an unknown key", async () => {
    expect(await setSetting({ key: "NOT_A_SETTING", value: "x" }, { environment, processEnvironment })).toMatchObject({ ok: false });
  });

  it("says when a real environment variable overrides the stored value", async () => {
    await setSetting({ key: "OPENAI_MODEL", value: "stored" }, { environment, processEnvironment });
    const rows = (await listSettings({ ...processEnvironment, OPENAI_MODEL: "from-shell" })).rows;
    expect(rows.find((row) => row.key === "OPENAI_MODEL")!.overriddenByEnvironment).toBe(true);
  });
});
