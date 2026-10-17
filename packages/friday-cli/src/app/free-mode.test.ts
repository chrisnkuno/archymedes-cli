import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "./args";
import { resolveSessionProvider } from "./session-provider";
import { ArchymedesAgent } from "@archymedes/core/cli/agent";
import { FreeAgentTurnProvider } from "@archymedes/core/providers/free-agent";
import { loadSession, saveSession } from "@archymedes/core/cli/session";
import { buildModelCatalog } from "../session/models";
import { loadSettings, saveSettings, SETTING_FIELDS, validateSetting } from "../platform/settings";
import { providerBaseUrl } from "../platform/endpoints";
import { enqueueJob, getJob } from "@archymedes/core/cli/job-store";

const dirs: string[] = [];
async function temporary() { const dir = await mkdtemp(path.join(os.tmpdir(), "archymedes-free-")); dirs.push(dir); return dir; }
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe("free access selection", () => {
  it("keeps free access separate from permissions and rejects conflicting providers in either order", () => {
    expect(parseArgs(["--free", "--plan", "--model", "lab/code:free", "explain"])).toMatchObject({ provider: "free", mode: "plan", model: "lab/code:free", prompt: "explain" });
    expect(parseArgs(["--provider", "free"])).toMatchObject({ provider: "free" });
    for (const args of [["--free", "--provider", "openai"], ["--provider", "openai", "--free"], ["--provider", "free", "--provider", "openai"]]) expect(() => parseArgs(args)).toThrow("cannot be combined");
  });
  it("offers free models with zero prices and rejects paid IDs from a cache", () => {
    const catalog = buildModelCatalog({ OPENROUTER_API_KEY: "secret" }, undefined, { free: ["lab/code:free", "lab/paid", "lab/code:free:online"] });
    const free = catalog.choices.filter((model) => model.provider === "free");
    expect(free.map((model) => model.model)).toEqual(["openrouter/free", "lab/code:free"]);
    expect(free.every((model) => model.prices?.outputPerMillion === 0)).toBe(true);
  });
  it("stores the key as a secret setting and validates free model selection", async () => {
    const env = { ARCHYMEDES_CONFIG_DIR: await temporary() };
    expect(SETTING_FIELDS.find((field) => field.key === "OPENROUTER_API_KEY")).toMatchObject({ secret: true });
    await saveSettings({ OPENROUTER_API_KEY: "test-key", FREE_MODEL: "lab/code:free", ARCHYMEDES_PROVIDER: "free" }, env);
    expect(await loadSettings(env)).toMatchObject({ OPENROUTER_API_KEY: "test-key", FREE_MODEL: "lab/code:free" });
    expect(() => validateSetting("FREE_MODEL", "lab/paid")).toThrow();
    expect(providerBaseUrl({ FREE_BASE_URL: "https://evil.example" }, "free")).toBe("https://openrouter.ai/api/v1");
  });
  it("persists free selection and restores it ahead of a paid default, without credentials", async () => {
    const root = await temporary();
    const provider = new FreeAgentTurnProvider({ apiKey: "secret", model: "lab/code:free" });
    const agent = new ArchymedesAgent({ root, model: provider, prices: { inputRatePerMillion: 0, outputRatePerMillion: 0 }, mode: "plan", approve: async () => "deny" });
    const record = agent.snapshot();
    expect(JSON.stringify(record)).not.toContain("secret");
    expect(record.modelSelection).toEqual({ provider: "free", model: "lab/code:free" });
    await saveSession(record);
    const env = { OPENAI_API_KEY: "paid", OPENROUTER_API_KEY: "secret" };
    expect(await resolveSessionProvider(env, { root, resume: record.id })).toMatchObject({ spec: { id: "free" }, model: "lab/code:free" });
    expect(await resolveSessionProvider(env, { root, resume: "latest" })).toMatchObject({ spec: { id: "free" } });
    expect(await resolveSessionProvider({ OPENAI_API_KEY: "paid" }, { root, resume: record.id })).toHaveProperty("error");
    expect(await resolveSessionProvider(env, { root, resume: record.id, provider: "openai" })).toMatchObject({ spec: { id: "openai" } });
    const saved = await loadSession(root, record.id);
    agent.resume(saved!);
    expect(agent.snapshot().modelSelection).toEqual(record.modelSelection);
    await agent.dispose();
  });
  it("retains free access on a durable job even if the user's default is paid", async () => {
    const root = await temporary();
    await enqueueJob(root, { id: "free-job", objective: "read a file", logPath: path.join(root, "job.log"),
      cadence: "daily", modelSelection: { provider: "free", model: "lab/code:free" } });
    const job = await getJob(root, "free-job");
    expect(job?.modelSelection).toEqual({ provider: "free", model: "lab/code:free" });
    expect(await resolveSessionProvider({ OPENAI_API_KEY: "paid", ARCHYMEDES_PROVIDER: "openai" }, { root, ...job?.modelSelection })).toHaveProperty("error");
  });
});
