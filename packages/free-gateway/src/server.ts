/**
 * Standalone entry point: `bun packages/free-gateway/src/server.ts`. Configuration is environment
 * only, and the process refuses to start without a key or with an in-memory limiter behind several
 * instances, because either mistake would silently misbill or mis-limit a shared account.
 */
import { randomBytes } from "node:crypto";
import { clientIpConfigFrom, describeClientIpConfig, resolveClientIp } from "./client-ip";
import { cachedEligibleModels, DEFAULT_CATALOG_TTL_MS } from "./catalog";
import { createFreeGateway, type InstallConfig } from "./handler";
import { MIN_SECRET_LENGTH } from "./install-token";
import { installRulesFrom, installTokenRulesFrom, issueRulesFrom, MemoryCounterStore, rulesFrom, tokenRulesFrom, upstashCounterStore } from "./rate-limit";

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

/** A positive integer from the environment, or the default. */
function positive(name: string, fallback: number): number {
  const value = Number(environment[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

// Install tokens are optional: without a secret the gateway serves anonymous per-address limits only.
const tokenSecret = environment.GATEWAY_TOKEN_SECRET?.trim();
if (tokenSecret && tokenSecret.length < MIN_SECRET_LENGTH) {
  console.error(`free-gateway: GATEWAY_TOKEN_SECRET must be at least ${MIN_SECRET_LENGTH} characters (try \`openssl rand -hex 32\`).`);
  process.exit(1);
}
const maxAgeDays = Number(environment.FREE_GATEWAY_INSTALL_MAX_AGE_DAYS);
const install: InstallConfig | undefined = tokenSecret ? {
  secret: tokenSecret,
  rules: installRulesFrom(environment),
  tokenRules: installTokenRulesFrom(environment),
  issueRules: issueRulesFrom(environment),
  ...(Number.isFinite(maxAgeDays) && maxAgeDays > 0 ? { maxAgeMs: maxAgeDays * 24 * 60 * 60_000 } : {}),
} : undefined;
if (!install) console.warn("free-gateway: GATEWAY_TOKEN_SECRET is not set; install tokens are disabled (anonymous per-address limits only).");

// One catalog for the whole process, warmed at startup so the first user never waits on it.
const catalog = cachedEligibleModels({ ttlMs: positive("FREE_GATEWAY_CATALOG_TTL_MS", DEFAULT_CATALOG_TTL_MS) });
void catalog().catch((error: unknown) => console.warn(`free-gateway: initial model catalog load failed: ${String(error)}`));

const handler = createFreeGateway({
  apiKey,
  store: upstashUrl && upstashToken ? upstashCounterStore(upstashUrl, upstashToken) : new MemoryCounterStore(),
  rules: rulesFrom(environment),
  tokenRules: tokenRulesFrom(environment),
  catalog,
  install,
  upstreamTimeoutMs: positive("FREE_GATEWAY_FIRST_BYTE_TIMEOUT_MS", 120_000),
  upstreamIdleTimeoutMs: positive("FREE_GATEWAY_IDLE_TIMEOUT_MS", 90_000),
  // A fresh salt per process is fine for counting; set one to keep counts stable across restarts.
  salt: environment.FREE_GATEWAY_SALT?.trim() || randomBytes(16).toString("hex"),
  referer: environment.FREE_GATEWAY_REFERER?.trim() || "https://github.com/chrisnkuno/archymedes-cli",
});
const clientIp = clientIpConfigFrom(environment);
// Off by default: echoes the address the limits would count, to check proxy settings after a deploy.
const debugIp = environment.FREE_GATEWAY_DEBUG_IP === "true";

const server = Bun.serve({
  port: Number(environment.PORT) || 8787,
  hostname: environment.HOST || "0.0.0.0",
  // Bun's maximum. Longer than the upstream idle timeout, so a stalled model is ended by the
  // gateway's SSE error event rather than by the socket closing under the client.
  idleTimeout: 255,
  fetch(request, bun) {
    const ip = resolveClientIp(request.headers, bun.requestIP(request)?.address, clientIp);
    if (debugIp && request.method === "GET" && new URL(request.url).pathname === "/debug/ip") {
      return Promise.resolve(new Response(JSON.stringify({ ip: ip ?? null }), { headers: { "content-type": "application/json", "cache-control": "no-store" } }));
    }
    return handler(request, ip);
  },
});

console.log(`free-gateway listening on ${server.url}; ${describeClientIpConfig(clientIp)}`);
