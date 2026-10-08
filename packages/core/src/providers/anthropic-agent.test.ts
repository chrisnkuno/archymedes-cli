import { describe, expect, it, vi } from "vitest";
import { AnthropicAgentTurnProvider, collectAnthropicStream, toAnthropicMessages, type AnthropicStreamEvent } from "./anthropic-agent";

const request = {
  messages: [{ role: "user" as const, content: "hi" }],
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
  maxOutputTokens: 4_096,
  safetyIdentifier: "archymedes_cli_test",
};

async function* events(list: AnthropicStreamEvent[]): AsyncIterable<AnthropicStreamEvent> {
  for (const event of list) yield event;
}

describe("Anthropic stream progress and deadlines", () => {
  it("reports thinking and tool-input fragments as output, not only text", async () => {
    const progress: string[] = [];
    const response = await collectAnthropicStream(events([
      { type: "message_start", message: { id: "m", model: "claude", usage: { input_tokens: 5, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hmm" } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "read_file" } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"path\":\"a\"}" } },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } },
    ]), undefined, (kind) => progress.push(kind));
    expect(progress).toEqual(["reasoning", "tool_call", "tool_call"]);
    expect(response.content).toContainEqual({ type: "tool_use", id: "t", name: "read_file", input: { path: "a" } });
  });

  it("reports a silent stream as a timeout rather than the SDK's abort error", async () => {
    vi.useFakeTimers();
    try {
      const provider = new AnthropicAgentTurnProvider({ apiKey: "k", model: "claude-sonnet-4-5", timeoutMs: 1_000 }, async () => {
        async function* stalls(): AsyncIterable<AnthropicStreamEvent> {
          yield { type: "message_start", message: { id: "m", model: "claude", usage: { input_tokens: 5, output_tokens: 0 } } };
          await new Promise<never>(() => undefined);
        }
        return stalls();
      });
      const pending = provider.complete(request).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ name: "TimeoutError", phase: "idle" });
    } finally { vi.useRealTimers(); }
  });
});

describe("Anthropic tool results with images", () => {
  it("sends a tool result's images as image blocks inside the tool_result content", () => {
    const { messages } = toAnthropicMessages([
      { role: "user", content: "look" },
      { role: "assistant", content: "", toolCalls: [{ id: "v1", name: "view_image", arguments: { path: "a.png" } }, { id: "r1", name: "read_file", arguments: {} }] },
      { role: "tool", toolCallId: "v1", name: "view_image", content: "Image a.png", images: [{ path: "a.png", mediaType: "image/png", data: "AAAA" }] },
      { role: "tool", toolCallId: "r1", name: "read_file", content: "text" },
    ]);
    expect(messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "v1", content: [{ type: "text", text: "Image a.png" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }] },
        { type: "tool_result", tool_use_id: "r1", content: "text" },
      ],
    });
  });
});
