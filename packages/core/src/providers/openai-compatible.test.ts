import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../agent-runtime";
import { isOpenRouterBaseUrl, toWireMessages, usageOf, usesOpenRouterCacheControl, withOpenRouterCacheControl } from "./openai-compatible";

const png = (path: string) => ({ path, mediaType: "image/png" as const, data: "AAAA" });

const transcript: AgentMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "look at both" },
  { role: "assistant", content: "", toolCalls: [{ id: "v1", name: "view_image", arguments: { path: "a.png" } }, { id: "v2", name: "view_image", arguments: { path: "b.png" } }] },
  { role: "tool", toolCallId: "v1", name: "view_image", content: "Image a.png", images: [png("a.png")] },
  { role: "tool", toolCallId: "v2", name: "view_image", content: "Image b.png", images: [png("b.png")] },
  { role: "assistant", content: "done" },
];

describe("tool-returned images on the Chat Completions wire", () => {
  it("keeps tool messages text-only and follows the step's tool run with one user message of image parts", () => {
    const wire = toWireMessages(transcript);
    expect(wire.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool", "user", "assistant"]);
    expect(wire[3]).toEqual({ role: "tool", content: "Image a.png", tool_call_id: "v1", name: "view_image" });
    expect(wire[5]).toEqual({
      role: "user",
      content: [
        { type: "text", text: "Images returned by the view_image tool calls above: a.png, b.png" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("places the image message after a tool run that ends the transcript", () => {
    const wire = toWireMessages(transcript.slice(0, 4));
    expect(wire.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
  });

  it("replaces images with a text note for a model that cannot see them", () => {
    const wire = toWireMessages(transcript, { vision: false });
    expect(wire.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool", "assistant"]);
    expect(wire[3].content).toBe("Image a.png\n[image not shown: this model cannot view images (a.png)]");
    expect(JSON.stringify(wire)).not.toContain("base64");
  });

  it("leaves a text-only transcript exactly as before", () => {
    const plain: AgentMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "r", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "r", name: "read_file", content: "x" },
    ];
    expect(toWireMessages(plain)).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: null, tool_calls: [{ id: "r", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: "x", tool_call_id: "r", name: "read_file" },
    ]);
  });
});

describe("OpenRouter prompt caching", () => {
  it("gates breakpoints on OpenRouter hosts and the anthropic/ and google/ families", () => {
    expect(isOpenRouterBaseUrl("https://openrouter.ai/api/v1")).toBe(true);
    expect(isOpenRouterBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isOpenRouterBaseUrl(undefined)).toBe(false);
    expect(isOpenRouterBaseUrl("not a url")).toBe(false);
    expect(usesOpenRouterCacheControl("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(usesOpenRouterCacheControl("google/gemini-2.5-pro")).toBe(true);
    expect(usesOpenRouterCacheControl("openai/gpt-5")).toBe(false);
  });

  it("marks the system message and the last user message's last text part", () => {
    const wire = withOpenRouterCacheControl(toWireMessages(transcript), "anthropic/claude-sonnet-4.6");
    expect(wire[0]).toEqual({ role: "system", content: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }] });
    expect(wire[1]).toEqual({ role: "user", content: "look at both" });
    const last = wire[5].content as Array<Record<string, unknown>>;
    expect(last[0]).toMatchObject({ type: "text", cache_control: { type: "ephemeral" } });
    expect(last[1]).not.toHaveProperty("cache_control");
    expect(wire.filter((message) => JSON.stringify(message).includes("cache_control"))).toHaveLength(2);
  });

  it("leaves other models' messages untouched", () => {
    const wire = toWireMessages(transcript);
    expect(withOpenRouterCacheControl(wire, "openai/gpt-5")).toBe(wire);
  });

  it("reports cached and cache-write prompt tokens in usage", () => {
    const usage = usageOf({
      id: "x", model: "m", choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: 10, total_tokens: 1010, prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 150 } },
    });
    expect(usage).toMatchObject({ inputTokens: 1000, cachedInputTokens: 800, cacheWriteTokens: 150 });
  });
});
