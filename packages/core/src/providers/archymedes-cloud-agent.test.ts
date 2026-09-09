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
    expect(init?.headers).toMatchObject({ "idempotency-key": expect.stringMatching(/^cli_/) });
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

  it("reads the credit balance in the currency it reserves in, and commits nothing to read it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      account_id: "acct_7",
      balance: { currency: "USD", micros: 4_250_000, purchasedMicros: 4_000_000, promotionalMicros: 250_000, reservedMicros: 5_000_000, spentMicros: 1_750_000 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new ArchymedesCloudTurnProvider({
      token: "cloud-secret", baseURL: "https://cloud.example/api/", currency: "USD", fetchImpl: fetchImpl as typeof fetch,
    });

    const balance = await provider.creditBalance();
    expect(balance).toMatchObject({ accountId: "acct_7", currency: "USD", availableMicros: 4_250_000, reservedMicros: 5_000_000 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.example/api/v1/credits/balance?currency=USD");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer cloud-secret");
    // A read moves no money, so it carries no idempotency key.
    expect(new Headers(init.headers).get("idempotency-key")).toBeNull();
  });

  it("asks for the balance in the currency its reservations are denominated in", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ balance: { currency: "EUR", micros: 1 } }), { status: 200 }));
    const provider = new ArchymedesCloudTurnProvider({ token: "t", baseURL: "https://cloud.example", currency: "eur", fetchImpl: fetchImpl as typeof fetch });
    await provider.creditBalance();
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toContain("currency=EUR");
  });

  it("surfaces a balance failure rather than reporting an empty account", async () => {
    // Reporting "0 available" for a 401 would tell the user they are out of money when they are
    // only out of a working token.
    const failing = vi.fn(async () => new Response(JSON.stringify({ error: { code: "unauthorized", message: "A valid bearer token is required." } }), { status: 401 }));
    const provider = new ArchymedesCloudTurnProvider({ token: "t", baseURL: "https://cloud.example", fetchImpl: failing as typeof fetch });
    await expect(provider.creditBalance()).rejects.toThrow(ArchymedesCloudError);
  });

  it("plans against the planning endpoint with a token count, never the conversation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      object: "routing_plan",
      policy: { id: "outcome-per-dollar", version: 3 },
      ranked: [{ candidate: { provider: "anthropic", model: "claude-sonnet-5" }, eligible: true, reason: "best", score: 0.9,
        estimated_charged: { currency: "USD", micros: 12_000 }, expected_total_micros: 31_000 }],
      excluded: [],
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new ArchymedesCloudTurnProvider({
      token: "cloud-secret", baseURL: "https://cloud.example/api/", model: "auto",
      maximumMicros: 2_500_000, currency: "USD", region: "us", dataPolicy: "zero-retention",
      qualityFloor: 0.8, fetchImpl: fetchImpl as typeof fetch,
    });

    const plan = await provider.plan({ estimatedInputTokens: 8_421, maxOutputTokens: 4_000, usesTools: true });
    expect(plan?.ranked[0]).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5", expectedTotalMicros: 31_000 });
    expect(plan?.policyId).toBe("outcome-per-dollar");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://cloud.example/api/v1/routes/plan");
    const body = JSON.parse(init.body as string);
    // The whole point of a preflight endpoint: it asks what a turn would cost without uploading it,
    // and it carries no idempotency key because it commits nothing.
    expect(body.messages).toBeUndefined();
    expect(body.archymedes.estimated_input_tokens).toBe(8_421);
    expect(body.archymedes.task_id).toBeUndefined();
    expect(new Headers(init.headers).get("idempotency-key")).toBeNull();
    // The profile a plan is ranked under must be the profile the turn would actually send.
    expect(body.archymedes.profile).toEqual({
      kind: "coding", requiredCapabilities: ["tools"], dataPolicy: "zero-retention", region: "us", qualityFloor: 0.8,
    });
  });

  it("refuses to plan against a size it was never given", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const provider = new ArchymedesCloudTurnProvider({ token: "t", baseURL: "https://cloud.example", fetchImpl: fetchImpl as typeof fetch });
    await expect(provider.plan({ estimatedInputTokens: 0, maxOutputTokens: 100 })).rejects.toThrow(/positive integer/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("surfaces a planning failure as an exchange error and a non-plan body as no plan", async () => {
    const failing = vi.fn(async () => new Response(JSON.stringify({ error: { code: "no_routes", message: "No provider models are enabled." } }), { status: 503 }));
    const provider = new ArchymedesCloudTurnProvider({ token: "t", baseURL: "https://cloud.example", fetchImpl: failing as typeof fetch });
    await expect(provider.plan({ estimatedInputTokens: 10, maxOutputTokens: 100 })).rejects.toThrow(ArchymedesCloudError);

    const odd = vi.fn(async () => new Response(JSON.stringify({ object: "routing_plan" }), { status: 200 }));
    const lenient = new ArchymedesCloudTurnProvider({ token: "t", baseURL: "https://cloud.example", fetchImpl: odd as typeof fetch });
    expect(await lenient.plan({ estimatedInputTokens: 10, maxOutputTokens: 100 })).toBeNull();
  });

  it("declares the task kind and required capabilities, and returns the routing receipt", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      id: "chat_cloud_2",
      model: "anthropic/claude-sonnet-5",
      choices: [{ finish_reason: "stop", message: { content: "reviewed" } }],
      usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
      archymedes: {
        reservation_id: "rsv_2",
        routing_receipt: {
          chosen: { model: "claude-sonnet-5", provider: "anthropic" },
          considered: [{ model: "claude-sonnet-5", provider: "anthropic", eligible: true, reason: "highest score in budget", score: 0.88 }],
          actual_micros: 8_400,
          retries: 0,
        },
      },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const provider = new ArchymedesCloudTurnProvider({
      token: "cloud-secret", baseURL: "https://cloud.example", model: "auto",
      taskKind: "security", fetchImpl: fetchImpl as typeof fetch,
    });

    const turn = await provider.complete({ ...request, effort: "high" });
    expect(turn.routingReceipt).toMatchObject({
      chosen: { model: "claude-sonnet-5", provider: "anthropic" },
      actualMicros: 8_400,
      retries: 0,
    });
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body.archymedes.profile).toEqual({ kind: "security", requiredCapabilities: ["tools", "reasoning"] });
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


it("reuses the exact wire request across transport retries", async () => {
  const calls: RequestInit[] = [];
  const provider = new ArchymedesCloudTurnProvider({ token: "secret", baseURL: "https://cloud.example", fetchImpl: (async (_url, init) => {
    calls.push(init!);
    if (calls.length === 1) throw new TypeError("fetch failed");
    return Response.json({ id: "replayed", model: "m", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, choices: [{ message: { content: "done" }, finish_reason: "stop" }] });
  }) as typeof fetch });
  const logical = { ...request, requestId: "cli_stable" };
  await expect(provider.complete(logical)).rejects.toThrow(/fetch failed/);
  await provider.complete(logical);
  expect(calls[0]?.body).toBe(calls[1]?.body);
  expect(new Headers(calls[1]?.headers).get("idempotency-key")).toBe("cli_stable");
});

it.each(["request_previously_failed", "idempotency_conflict", "spend_limit_exceeded"])("does not retry terminal hosted code %s", async (code) => {
  const provider = new ArchymedesCloudTurnProvider({ token: "secret", baseURL: "https://cloud.example", fetchImpl: (async () => Response.json({ error: { code, message: "stop" } }, { status: 409 })) as typeof fetch });
  await expect(provider.complete(request)).rejects.toMatchObject({ retryable: false });
});

it("retains the processing retry delay and rejects a mistyped task kind locally", async () => {
  const provider = new ArchymedesCloudTurnProvider({ token: "secret", baseURL: "https://cloud.example", fetchImpl: (async () => Response.json({ error: { code: "request_in_progress" } }, { status: 409, headers: { "retry-after": "2" } })) as typeof fetch });
  await expect(provider.complete(request)).rejects.toMatchObject({ retryable: true, retryAfterMs: 2000 });
  expect(() => new ArchymedesCloudTurnProvider({ token: "secret", baseURL: "https://cloud.example", taskKind: "codign" })).toThrow(/task kind/);
});
