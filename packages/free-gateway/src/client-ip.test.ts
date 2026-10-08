import { describe, expect, it } from "vitest";
import { clientIpConfigFrom, resolveClientIp } from "./client-ip";

const headers = (values: Record<string, string>) => new Headers(values);

describe("client address", () => {
  it("trusts only the socket by default, ignoring forgeable headers", () => {
    const config = clientIpConfigFrom({});
    expect(config).toEqual({ mode: "socket" });
    expect(resolveClientIp(headers({ "x-forwarded-for": "6.6.6.6", "fly-client-ip": "6.6.6.6" }), "10.0.0.1", config)).toBe("10.0.0.1");
  });

  it("reads Fly-Client-IP when configured, falling back to the socket when it is missing or not an IP", () => {
    const config = clientIpConfigFrom({ FREE_GATEWAY_CLIENT_IP_HEADER: "Fly-Client-IP" });
    expect(config).toEqual({ mode: "header", header: "fly-client-ip" });
    expect(resolveClientIp(headers({ "fly-client-ip": "203.0.113.9", "x-forwarded-for": "6.6.6.6" }), "10.0.0.1", config)).toBe("203.0.113.9");
    expect(resolveClientIp(headers({ "fly-client-ip": "2001:db8::1" }), "10.0.0.1", config)).toBe("2001:db8::1");
    expect(resolveClientIp(headers({}), "10.0.0.1", config)).toBe("10.0.0.1");
    expect(resolveClientIp(headers({ "fly-client-ip": "not-an-ip" }), "10.0.0.1", config)).toBe("10.0.0.1");
  });

  it("reads X-Forwarded-For from the right, so a client-written prefix cannot choose the identity", () => {
    const config = clientIpConfigFrom({ FREE_GATEWAY_TRUST_PROXY: "true" });
    expect(config).toEqual({ mode: "forwarded", hops: 1 });
    // The client sent "6.6.6.6"; the platform proxy appended the address it actually saw.
    expect(resolveClientIp(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" }), "10.0.0.1", config)).toBe("203.0.113.9");
    expect(resolveClientIp(headers({ "x-forwarded-for": "203.0.113.9:4711" }), "10.0.0.1", config)).toBe("203.0.113.9");
    expect(resolveClientIp(headers({ "x-forwarded-for": "[2001:db8::1]:443" }), "10.0.0.1", config)).toBe("2001:db8::1");
    expect(resolveClientIp(headers({}), "10.0.0.1", config)).toBe("10.0.0.1");
    const twoHops = clientIpConfigFrom({ FREE_GATEWAY_TRUST_PROXY: "true", FREE_GATEWAY_PROXY_HOPS: "2" });
    expect(resolveClientIp(headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.9, 10.1.1.1" }), "10.0.0.1", twoHops)).toBe("203.0.113.9");
    expect(resolveClientIp(headers({ "x-forwarded-for": "203.0.113.9" }), "10.0.0.1", twoHops)).toBe("10.0.0.1"); // too few hops: not trusted
    expect(clientIpConfigFrom({ FREE_GATEWAY_TRUST_PROXY: "true", FREE_GATEWAY_PROXY_HOPS: "-3" })).toEqual({ mode: "forwarded", hops: 1 });
  });
});
