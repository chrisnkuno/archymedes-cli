import { describe, expect, it, vi } from "vitest";
import { ArchymedesCloudError, ArchymedesCloudTurnProvider } from "./archymedes-cloud-agent";

const request = {
  messages: [{ role: "user" as const, content: "Build it" }],
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
  maxOutputTokens: 4_000,
  safetyIdentifier: "session-safe-id",
};

describe("ArchymedesCloudTurnProvider", () => {
  it("sends a capped routed completion and returns normalized model usage", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "chat_cloud_1",
      model: "provider/model-1",
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      archymedes: { reservation_id: "reserve_1", routing_receipt: {}, usage_event: {} },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new ArchymedesCloudTurnProvider({
      token: "cloud-secret", baseURL: "https://cloud.example/api/", model: "auto",
      maximumMicros: 2_500_000, currency: "usd", region: "us",
      dataPolicy: "zero-retention", qualityFloor: 0.8, fetchImpl: fetchImpl as typeof fetch,
    });

    const turn = await provider.complete(request);
    expect(turn).toMatchObject({ responseId: "chat_cloud_1", model: "provider/model-1", content: "done", usage: { inputTokens: 11, outputTokens: 3 } });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.example/api/v1/chat/completions");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer cloud-secret");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: "auto", stream: false, max_completion_tokens: 4_000, safety_identifier: "session-safe-id",
      archymedes: { maximum: { currency: "USD", micros: 2_500_000 }, profile: {
        kind: "coding", requiredCapabilities: ["tools"], dataPolicy: "zero-retention", region: "us", qualityFloor: 0.8,
      } },
    });
    expect(body.archymedes.task_id).toMatch(/^cli_/);
    expect(body.tools[0].function.name).toBe("read_file");
  });

  it("preserves a failure status for retry classification without leaking the token", async () => {
    const provider = new ArchymedesCloudTurnProvider({
      token: "never-show-this-token", baseURL: "https://cloud.example",
      fetchImpl: (async () => new Response(JSON.stringify({ error: { code: "insufficient_credits", message: "Top up required" } }), { status: 402 })) as typeof fetch,
    });
    const error = await provider.complete({ ...request, tools: [] }).catch((caught) => caught);
    expect(error).toBeInstanceOf(ArchymedesCloudError);
    expect(error).toMatchObject({ status: 402, code: "insufficient_credits", message: "Top up required" });
    expect(String(error)).not.toContain("never-show-this-token");
  });

  it("rejects invalid spend and routing controls before making a request", () => {
    expect(() => new ArchymedesCloudTurnProvider({ token: "t", baseURL: "https://cloud.example", maximumMicros: 0 })).toThrow(/positive integer/);
    expect(() => new ArchymedesCloudTurnProvider({ token: "t", baseURL: "https://cloud.example", dataPolicy: "anything" })).toThrow(/data policy/);
    expect(() => new ArchymedesCloudTurnProvider({ token: "t", baseURL: "https://cloud.example", qualityFloor: 2 })).toThrow(/quality floor/);
  });
});
