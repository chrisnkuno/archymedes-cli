import { describe, expect, it } from "vitest";
import { modelList } from "./acp-models";

describe("model list over acp", () => {
  it("lists configured providers' models with a price, and says which providers lack a key", async () => {
    const list = await modelList({ ANTHROPIC_API_KEY: "sk-ant-x", ARCHYMEDES_CONFIG_DIR: "/nonexistent-archymedes-cfg" }, {});
    const anthropic = list.choices.filter((choice) => choice.provider === "anthropic");
    expect(anthropic.length).toBeGreaterThan(0);
    expect(anthropic.filter((choice) => choice.isDefault)).toHaveLength(1);
    expect(anthropic.every((choice) => choice.price === "unpriced" || /per Mtok/.test(choice.price))).toBe(true);
    expect(list.choices.some((choice) => choice.provider === "openai")).toBe(false);
    expect(list.unconfigured.find((entry) => entry.provider === "openai")).toMatchObject({ missing: ["OPENAI_API_KEY"] });
  });
});
