/**
 * Standalone entry point: `bun packages/free-gateway/src/server.ts`. Configuration is environment
 * only, and the process refuses to start without a key or with an in-memory limiter behind several
 * instances, because either mistake would silently misbill or mis-limit a shared account.
 */
import { randomBytes } from "node:crypto";
import { cachedEligibleModels } from "./catalog";
import { createFreeGateway } from "./handler";
import { MemoryCounterStore, rulesFrom, upstashCounterStore } from "./rate-limit";

/** The slice of Bun's runtime API this entry uses; the repository does not install Bun's types. */
declare const Bun: {
  serve(options: {
    port: number; hostname: string; idleTimeout: number;
    fetch(request: Request, server: { requestIP(request: Request): { address: string } | null }): Promise<Response>;
  }): { url: URL };
};

const environment = process.env;
const apiKey = environment.OPENROUTER_API_KEY?.trim();
if (!apiKey) {
  console.error("free-gateway: OPENROUTER_API_KEY is required.");
  process.exit(1);
}

const upstashUrl = environment.UPSTASH_REDIS_REST_URL?.trim();
const upstashToken = environment.UPSTASH_REDIS_REST_TOKEN?.trim();
if (environment.FREE_GATEWAY_INSTANCES && Number(environment.FREE_GATEWAY_INSTANCES) > 1 && !(upstashUrl && upstashToken)) {
  console.error("free-gateway: several instances need UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN for shared rate limits.");
  process.exit(1);
}

const handler = createFreeGateway({
  apiKey,
  store: upstashUrl && upstashToken ? upstashCounterStore(upstashUrl, upstashToken) : new MemoryCounterStore(),
  rules: rulesFrom(environment),
  catalog: cachedEligibleModels(),
  // A fresh salt per process is fine for counting; set one to keep counts stable across restarts.
  salt: environment.FREE_GATEWAY_SALT?.trim() || randomBytes(16).toString("hex"),
  referer: environment.FREE_GATEWAY_REFERER?.trim() || "https://github.com/chrisnkuno/archymedes-cli",
});
const trustProxy = environment.FREE_GATEWAY_TRUST_PROXY === "true";

const server = Bun.serve({
  port: Number(environment.PORT) || 8787,
  hostname: environment.HOST || "0.0.0.0",
  idleTimeout: 255,
  fetch(request, bun) {
    // Behind a proxy the socket address is the proxy's; only then is the forwarded header trusted.
    const forwarded = trustProxy ? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
    return handler(request, forwarded || bun.requestIP(request)?.address);
  },
});

console.log(`free-gateway listening on ${server.url}`);
