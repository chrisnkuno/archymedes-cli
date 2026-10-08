/**
 * Anonymous install tokens for the no-key free trial.
 *
 * A token says only "this gateway issued an install id at this time": a random id and an issue
 * time, signed with HMAC-SHA256 under a server secret. It carries no personal data, needs no
 * database (verification is a constant-time signature check), and gives the rate limiter a stable
 * per-installation identity so the per-address limits can be relaxed for shared networks (NATs,
 * universities) without letting one machine take the network's whole allowance.
 *
 * Wire format: `v1.<base64url(JSON {v:1,id,iat})>.<base64url(HMAC-SHA256(secret, "v1." + payload))>`.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Request header a client sends its token in. */
export const INSTALL_HEADER = "x-archymedes-install";
/** Response header telling a client whether the token it sent was accepted (`valid` / `invalid`). */
export const INSTALL_STATUS_HEADER = "x-archymedes-install-status";

/** The shortest secret the gateway accepts; anything shorter is guessable offline. */
export const MIN_SECRET_LENGTH = 32;

const VERSION = "v1";
const MAX_TOKEN_LENGTH = 512;
const INSTALL_ID = /^[A-Za-z0-9_-]{22}$/;
/** Tolerated clock skew between instances for the issue time. */
const SKEW_MS = 5 * 60_000;

export type InstallClaims = { id: string; issuedAtMs: number };

function sign(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(`${VERSION}.${payload}`).digest();
}

export function issueInstallToken(secret: string, now: number = Date.now(), id: string = randomBytes(16).toString("base64url")): { token: string; claims: InstallClaims } {
  const iat = Math.floor(now / 1000);
  const payload = Buffer.from(JSON.stringify({ v: 1, id, iat })).toString("base64url");
  return {
    token: `${VERSION}.${payload}.${sign(secret, payload).toString("base64url")}`,
    claims: { id, issuedAtMs: iat * 1000 },
  };
}

/**
 * The claims of a token this gateway signed, or undefined for anything else: a forged or altered
 * token, one signed with another secret, one issued in the future, or one older than `maxAgeMs`.
 */
export function verifyInstallToken(token: string, secret: string, now: number = Date.now(), maxAgeMs?: number): InstallClaims | undefined {
  if (!token || token.length > MAX_TOKEN_LENGTH) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return undefined;
  const [, payload, signature] = parts;
  const expected = sign(secret, payload);
  const given = Buffer.from(signature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (!claims || typeof claims !== "object") return undefined;
  const { v, id, iat } = claims as Record<string, unknown>;
  if (v !== 1 || typeof id !== "string" || !INSTALL_ID.test(id) || typeof iat !== "number" || !Number.isSafeInteger(iat)) return undefined;
  const issuedAtMs = iat * 1000;
  if (issuedAtMs > now + SKEW_MS) return undefined;
  if (maxAgeMs !== undefined && maxAgeMs > 0 && now - issuedAtMs > maxAgeMs) return undefined;
  return { id, issuedAtMs };
}
