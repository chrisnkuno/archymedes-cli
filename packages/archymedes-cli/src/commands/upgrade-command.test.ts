import { describe, expect, it, vi } from "vitest";
import { runUpgradeCommand } from "./upgrade-command";

const paint = { green: (text: string) => text, yellow: (text: string) => text, dim: (text: string) => text };

describe("/upgrade", () => {
  it("explains the switch, prompts hidden, saves the key, and confirms direct-key mode", async () => {
    const written: string[] = [];
    const asked: string[] = [];
    const saved: unknown[] = [];
    const result = await runUpgradeCommand({
      askSecret: async (question) => { asked.push(question); return "  sk-or-secret  "; },
      write: (text) => written.push(text),
      paint,
    }, {
      settings: { ARCHYMEDES_LANGUAGE: "en" },
      save: async (next) => { saved.push(next); return "/config/settings.json"; },
    });
    expect(result).toEqual({
      saved: true,
      file: "/config/settings.json",
      settings: { ARCHYMEDES_LANGUAGE: "en", OPENROUTER_API_KEY: "sk-or-secret", ARCHYMEDES_PROVIDER: "openrouter" },
    });
    expect(asked).toEqual(["  OpenRouter API key: "]); // asked through the hidden prompt
    const output = written.join("");
    expect(output).toContain("own OpenRouter API key");
    expect(output).toContain("Your OpenRouter API key is configured.");
    expect(output).toContain("Archymedes is now using direct-key mode.");
    expect(output).not.toContain("sk-or-secret"); // never printed
  });

  it("cancels without saving when no key is pasted", async () => {
    const written: string[] = [];
    const save = vi.fn(async () => "/config/settings.json");
    const result = await runUpgradeCommand({
      askSecret: async () => "   ",
      write: (text) => written.push(text),
      paint,
    }, { settings: {}, save });
    expect(result).toEqual({ cancelled: true });
    expect(save).not.toHaveBeenCalled();
    expect(written.join("")).toContain("cancelled");
  });

  it("keeps every other setting when the key is saved", async () => {
    const save = vi.fn(async (_next: Record<string, string>) => "settings.env");
    await runUpgradeCommand({
      askSecret: async () => "sk-or-key",
      write: () => undefined,
      paint,
    }, { settings: { ARCHYMEDES_LANGUAGE: "es", FREE_MODEL: "lab/code:free" }, save });
    expect(save).toHaveBeenCalledWith({ ARCHYMEDES_LANGUAGE: "es", FREE_MODEL: "lab/code:free", OPENROUTER_API_KEY: "sk-or-key", ARCHYMEDES_PROVIDER: "openrouter" });
  });
});
