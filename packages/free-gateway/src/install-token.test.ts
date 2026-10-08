import { describe, expect, it } from "vitest";
import { issueInstallToken, verifyInstallToken } from "./install-token";

const secret = "s".repeat(40);
const now = Date.UTC(2026, 9, 6, 12);

function swapPayload(token: string, change: (claims: Record<string, unknown>) => Record<string, unknown>): string {
  const [version, payload, signature] = token.split(".");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  return `${version}.${Buffer.from(JSON.stringify(change(claims))).toString("base64url")}.${signature}`;
}

describe("install tokens", () => {
  it("issues a signed token carrying only a random id and an issue time", () => {
    const { token, claims } = issueInstallToken(secret, now);
    expect(token.split(".")).toHaveLength(3);
    expect(token.startsWith("v1.")).toBe(true);
    expect(claims.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(payload).toEqual({ v: 1, id: claims.id, iat: now / 1000 });
    expect(verifyInstallToken(token, secret, now)).toEqual(claims);
    expect(issueInstallToken(secret, now).claims.id).not.toBe(claims.id); // ids are random
  });

  it("rejects tampered, forged, foreign and malformed tokens", () => {
    const { token } = issueInstallToken(secret, now);
    const [version, payload, signature] = token.split(".");
    // A changed id keeps the old signature: rejected.
    expect(verifyInstallToken(swapPayload(token, (claims) => ({ ...claims, id: "A".repeat(22) })), secret, now)).toBeUndefined();
    // A flipped signature character: rejected.
    const flipped = signature[0] === "A" ? `B${signature.slice(1)}` : `A${signature.slice(1)}`;
    expect(verifyInstallToken(`${version}.${payload}.${flipped}`, secret, now)).toBeUndefined();
    // Signed under another deployment's secret: rejected.
    expect(verifyInstallToken(token, "t".repeat(40), now)).toBeUndefined();
    for (const bad of ["", "v1", "v1..", `v2.${payload}.${signature}`, `${token}.extra`, "x".repeat(600), `v1.${payload}.`]) {
      expect(verifyInstallToken(bad, secret, now)).toBeUndefined();
    }
  });

  it("rejects tokens from the future and, when configured, tokens past their maximum age", () => {
    const future = issueInstallToken(secret, now + 60 * 60_000).token;
    expect(verifyInstallToken(future, secret, now)).toBeUndefined();
    const { token } = issueInstallToken(secret, now);
    expect(verifyInstallToken(token, secret, now + 400 * 24 * 60 * 60_000)).toBeDefined(); // no expiry by default
    expect(verifyInstallToken(token, secret, now + 31 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000)).toBeUndefined();
    expect(verifyInstallToken(token, secret, now + 29 * 24 * 60 * 60_000, 30 * 24 * 60 * 60_000)).toBeDefined();
  });
});
