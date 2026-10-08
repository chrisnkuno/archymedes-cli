/**
 * Which address a request is counted against. Every per-address limit depends on this, so the
 * default trusts nothing a client can write: the socket address. Behind a platform proxy the
 * socket address is the proxy's, and the operator opts in to exactly one source the proxy sets:
 *
 * - `FREE_GATEWAY_CLIENT_IP_HEADER=fly-client-ip` (Fly.io): a single-value header the platform
 *   proxy overwrites on every request, so a client cannot forge it.
 * - `FREE_GATEWAY_TRUST_PROXY=true` (Render, nginx, most load balancers): `X-Forwarded-For`, read
 *   from the right. Proxies append the address they saw, so the rightmost entries are written by
 *   trusted hops and everything to their left is whatever the client sent. With
 *   `FREE_GATEWAY_PROXY_HOPS=N` (default 1) the Nth entry from the right is used.
 *
 * Reading the leftmost `X-Forwarded-For` entry, a common mistake, lets any client pick a fresh
 * address per request and reset its own limits.
 */
import { isIP } from "node:net";

export type ClientIpConfig =
  | { mode: "socket" }
  | { mode: "header"; header: string }
  | { mode: "forwarded"; hops: number };

export function clientIpConfigFrom(environment: Record<string, string | undefined>): ClientIpConfig {
  const header = environment.FREE_GATEWAY_CLIENT_IP_HEADER?.trim().toLowerCase();
  if (header) return { mode: "header", header };
  if (environment.FREE_GATEWAY_TRUST_PROXY === "true") {
    const hops = Number(environment.FREE_GATEWAY_PROXY_HOPS);
    return { mode: "forwarded", hops: Number.isSafeInteger(hops) && hops > 0 ? hops : 1 };
  }
  return { mode: "socket" };
}

/** An address as a proxy wrote it, without a port or IPv6 brackets; undefined unless it is an IP. */
function normalize(value: string | undefined): string | undefined {
  let candidate = value?.trim();
  if (!candidate) return undefined;
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(candidate);
  if (bracketed) candidate = bracketed[1];
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(candidate)) candidate = candidate.slice(0, candidate.lastIndexOf(":"));
  return isIP(candidate) ? candidate : undefined;
}

/**
 * The client address under `config`, falling back to the socket address when the configured
 * source is missing or not an IP (a misconfigured proxy then limits everyone together rather than
 * letting a client choose its identity).
 */
export function resolveClientIp(headers: Headers, socketIp: string | undefined, config: ClientIpConfig): string | undefined {
  if (config.mode === "header") return normalize(headers.get(config.header) ?? undefined) ?? socketIp;
  if (config.mode === "forwarded") {
    const entries = (headers.get("x-forwarded-for") ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
    return normalize(entries[entries.length - config.hops]) ?? socketIp;
  }
  return socketIp;
}

export function describeClientIpConfig(config: ClientIpConfig): string {
  if (config.mode === "header") return `client address from the ${config.header} header`;
  if (config.mode === "forwarded") return `client address from X-Forwarded-For, entry ${config.hops} from the right`;
  return "client address from the socket (set FREE_GATEWAY_CLIENT_IP_HEADER or FREE_GATEWAY_TRUST_PROXY behind a proxy)";
}
