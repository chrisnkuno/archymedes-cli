import { describe, expect, it, vi } from "vitest";
import { parseFreeOpenRouterModels, type FreeModel } from "@archymedes/core/providers/free-catalog";
import { createFreeGateway, type GatewayConfig, type InstallConfig } from "./handler";
import { issueInstallToken } from "./install-token";
import { MemoryCounterStore, upstashCounterStore, type CounterStore, type RateRule } from "./rate-limit";

const entry = { id: "lab/code:free", name: "Code", context_length: 65536, top_provider: { max_completion_tokens: 2048 },
  pricing: { prompt: "0", completion: "0" }, architecture: { output_modalities: ["text"] }, supported_parameters: ["tools"] };
const models = new Map(parseFreeOpenRouterModels({ data: [entry] }).map((model): [string, FreeModel] => [model.id, model]));
const chat = { model: entry.id, messages: [{ role: "user", content: "hi" }], stream: true };
const secret = "k".repeat(40);
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const fixedNow = Date.UTC(2026, 9, 6, 12);

const sse = (total = 2) => new Response(
  `data: {"choices":[{"delta":{"content":"ok"}}]}\n\n`
  + `data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":${total}}}\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } });

function setup(overrides: Partial<GatewayConfig> = {}, install: Partial<InstallConfig> | null = {}) {
  const upstream = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => sse());
  const store = overrides.store ?? new MemoryCounterStore();
  const handler = createFreeGateway({
    apiKey: "sk-or-operator-secret", store,
    rules: [{ name: "ip-minute", scope: "ip", windowMs: MINUTE, limit: 1 }, { name: "ip-day", scope: "ip", windowMs: DAY, limit: 25 }],
    tokenRules: [{ name: "ip-token-day", scope: "ip", windowMs: DAY, limit: 100_000 }],
    catalog: async () => models, salt: "s", fetchImpl: upstream as unknown as typeof fetch, now: () => fixedNow,
    install: install ? { secret, ...install } : undefined,
    ...overrides,
  });
  const issue = (ip = "1.2.3.4") => handler(new Request("https://gw.test/v1/install", { method: "POST" }), ip);
  const post = (token?: string, ip = "1.2.3.4") => handler(new Request("https://gw.test/v1/chat/completions", {
    method: "POST", body: JSON.stringify(chat), headers: token ? { "x-archymedes-install": token } : {},
  }), ip);
  const token = async (ip?: string) => ((await (await issue(ip)).json()) as { token: string }).token;
  return { handler, upstream, store, issue, post, token };
}

describe("POST /v1/install", () => {
  it("issues a token the chat endpoint accepts", async () => {
    const { issue, post } = setup();
    const response = await issue();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as { token: string; install_id: string; issued_at: string; header: string };
    expect(body.token.startsWith("v1.")).toBe(true);
    expect(body.install_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(body.issued_at).toBe(new Date(fixedNow).toISOString());
    expect(body.header).toBe("x-archymedes-install");
    const chatResponse = await post(body.token);
    expect(chatResponse.status).toBe(200);
    expect(chatResponse.headers.get("x-archymedes-install-status")).toBe("valid");
  });

  it("limits issuance per address (5 a day by default) without affecting other addresses", async () => {
    const { issue } = setup();
    for (let index = 0; index < 5; index += 1) expect((await issue("9.9.9.9")).status).toBe(200);
    const refused = await issue("9.9.9.9");
    expect(refused.status).toBe(429);
    expect(refused.headers.get("x-free-gateway-error")).toBe("429");
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("Too many free installs");
    expect((await issue("8.8.8.8")).status).toBe(200);
  });

  it("answers 503 when tokens are not configured, and ignores a presented token", async () => {
    const { issue, post } = setup({}, null);
    const response = await issue();
    expect(response.status).toBe(503);
    expect(response.headers.get("x-free-gateway-error")).toBe("503");
    const chatResponse = await post(issueInstallToken(secret, fixedNow).token);
    expect(chatResponse.status).toBe(200);
    expect(chatResponse.headers.get("x-archymedes-install-status")).toBeNull();
  });

  it("refuses other methods", async () => {
    const { handler } = setup();
    expect((await handler(new Request("https://gw.test/v1/install"), "1.2.3.4")).status).toBe(405);
  });
});

describe("install-token rate limits", () => {
  const installRules: RateRule[] = [
    { name: "install-minute", scope: "install", windowMs: MINUTE, limit: 2 },
    { name: "ip-shared-minute", scope: "ip", windowMs: MINUTE, limit: 5 },
    { name: "global-minute", scope: "global", windowMs: MINUTE, limit: 100 },
  ];

  it("keeps anonymous requests on the per-address limits (backward compatible)", async () => {
    const { post } = setup({}, { rules: installRules });
    expect((await post()).status).toBe(200);
    const refused = await post();
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("for this address");
  });

  it("limits each install separately and relaxes the shared address limit", async () => {
    const { post, token, upstream } = setup({}, { rules: installRules });
    const first = await token();
    const second = await token();
    // The anonymous limit for this address is 1 a minute; installs behind it get their own.
    expect((await post(first)).status).toBe(200);
    expect((await post(first)).status).toBe(200);
    const refused = await post(first);
    expect(refused.status).toBe(429);
    expect(refused.headers.get("x-free-gateway-error")).toBe("429");
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("for this install: 2 requests per minute");
    expect((await post(second)).status).toBe(200); // a different install on the same address
    expect(upstream).toHaveBeenCalledTimes(3);
  });

  it("still caps the shared address across many installs", async () => {
    const { post, token } = setup({}, { rules: installRules });
    const tokens = await Promise.all(Array.from({ length: 5 }, () => token()));
    const extra = issueInstallToken(secret, fixedNow).token;
    for (const install of tokens) expect((await post(install)).status).toBe(200);
    const refused = await post(extra);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("your network");
  });

  it("charges token usage per install", async () => {
    const tokenRules: RateRule[] = [
      { name: "install-token-day", scope: "install", windowMs: DAY, limit: 3 },
      { name: "ip-shared-token-day", scope: "ip", windowMs: DAY, limit: 1_000 },
    ];
    const { post, token } = setup({}, { rules: installRules, tokenRules });
    const mine = await token();
    await (await post(mine)).text(); // 2 tokens
    await (await post(mine)).text(); // 4 tokens: over the per-install allowance
    const refused = await post(mine);
    expect(refused.status).toBe(429);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("free usage limit (3 tokens)");
    expect((await post(await token())).status).toBe(200); // a new install has its own allowance
  });

  it("serves an invalid token under the anonymous limits and tells the client to re-register", async () => {
    const { post } = setup({}, { rules: installRules });
    const forged = issueInstallToken("x".repeat(40), fixedNow).token;
    const response = await post(forged);
    expect(response.status).toBe(200);
    expect(response.headers.get("x-archymedes-install-status")).toBe("invalid");
    const refused = await post(forged); // anonymous limit: 1 a minute
    expect(refused.status).toBe(429);
    expect(refused.headers.get("x-archymedes-install-status")).toBe("invalid");
  });

  it("works over the Upstash backend with the new keys", async () => {
    const data = new Map<string, number>();
    const redis = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.endsWith("/pipeline")) {
        const commands = JSON.parse(String(init!.body)) as string[][];
        return new Response(JSON.stringify(commands.map(([command, key, value]) => {
          if (command === "INCR") { data.set(key, (data.get(key) ?? 0) + 1); return { result: data.get(key) }; }
          if (command === "INCRBY") { data.set(key, (data.get(key) ?? 0) + Number(value)); return { result: data.get(key) }; }
          return { result: 1 };
        })));
      }
      const key = decodeURIComponent(target.slice(target.indexOf("/get/") + 5));
      return new Response(JSON.stringify({ result: data.get(key) ?? null }));
    });
    const store: CounterStore = upstashCounterStore("https://redis.test", "t", redis as unknown as typeof fetch);
    const { post, token } = setup({ store }, { rules: installRules });
    const mine = await token();
    const id = JSON.parse(Buffer.from(mine.split(".")[1], "base64url").toString("utf8")).id as string;
    expect((await post(mine)).status).toBe(200);
    expect((await post(mine)).status).toBe(200);
    expect((await post(mine)).status).toBe(429);
    const window = Math.floor(fixedNow / MINUTE);
    // The refused third request was refunded (INCRBY -1): a refusal never uses up allowance.
    expect(data.get(`free:install-minute:install:${id}:${window}`)).toBe(2);
    expect([...data.keys()].some((key) => key.startsWith("free:issue-ip-day:ip:"))).toBe(true);
  });
});
