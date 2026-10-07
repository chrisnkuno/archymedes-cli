import { describe, expect, it } from "vitest";
import { classifyNetworkError } from "./network";
import { ProviderRequestError } from "@archymedes/core";

/** Builds the error shapes the transport layers actually throw. */
function transportError(message: string, code: string, cause?: unknown): Error {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

describe("network error classification", () => {
  it("returns null for errors that have nothing to do with the network", () => {
    expect(classifyNetworkError(new Error("Model response did not contain a JSON object"))).toBeNull();
    expect(classifyNetworkError(new Error("Session budget exhausted"))).toBeNull();
    expect(classifyNetworkError("a string thrown by a tool")).toBeNull();
  });

  it("turns a provider 404 into a base-route and model diagnosis", () => {
    const error = Object.assign(new Error("404 Not Found"), { status: 404, name: "NotFoundError" });
    const diagnosis = classifyNetworkError(error, { host: "api.deepseek.com", purpose: "the model API (DeepSeek)" });
    expect(diagnosis?.kind).toBe("not_found");
    expect(diagnosis?.message).toContain("API route or selected model");
    expect(diagnosis?.hint).toContain("/v1");
    expect(diagnosis?.hint).toContain("/models");
  });

  it("turns provider HTTP failures into specific actions", () => {
    expect(classifyNetworkError(Object.assign(new Error("invalid key"), { status: 401 }), { host: "api.example.com", purpose: "the model API" })).toMatchObject({
      kind: "authentication", message: expect.stringContaining("credentials"), hint: expect.stringContaining("/settings"),
    });
    expect(classifyNetworkError(Object.assign(new Error("forbidden"), { status: 403 }), { host: "api.example.com" })).toMatchObject({
      kind: "permission", hint: expect.stringContaining("/model"),
    });
    expect(classifyNetworkError(Object.assign(new Error("invalid tools"), { status: 422 }), { host: "api.example.com" })).toMatchObject({
      kind: "bad_request", message: expect.stringContaining("tool-calling"),
    });
  });

  it("reports exhausted retries and explains when a partial stream made retry unsafe", () => {
    const rateLimit = new ProviderRequestError(Object.assign(new Error("too many requests"), { status: 429 }), { attempts: 3 });
    expect(classifyNetworkError(rateLimit, { host: "api.example.com", purpose: "the model API" })).toMatchObject({
      kind: "rate_limit", message: expect.stringContaining("after 3 attempts"),
    });

    const partial = new ProviderRequestError(Object.assign(new Error("socket closed"), { code: "ECONNRESET" }), { attempts: 1, retrySuppressed: "output_started" });
    const diagnosis = classifyNetworkError(partial, { host: "api.example.com", purpose: "the model API" });
    expect(diagnosis?.message).toContain("did not retry because output had already started");
    expect(diagnosis?.hint).toContain("partial output");
  });

  it("names the HTTP status of the server error that exhausted retries", () => {
    const serverError = new ProviderRequestError(Object.assign(new Error("upstream overloaded"), { status: 503 }), { attempts: 4, kind: "server", waitedMs: 7000 });
    const diagnosis = classifyNetworkError(serverError, { host: "openrouter.ai", purpose: "the model API (Free models (OpenRouter))" });
    expect(diagnosis?.kind).toBe("server_error");
    expect(diagnosis?.message).toContain("HTTP 503");
    expect(diagnosis?.message).toContain("after 4 attempts");
    expect(diagnosis?.message).toContain("over 7s of retries");
    expect(diagnosis?.hint).toContain("/model");
    // A provider error with no status still classifies, without inventing one.
    const vague = classifyNetworkError(new ProviderRequestError(new Error("bad gateway"), { attempts: 3, kind: "server" }), { host: "openrouter.ai" });
    expect(vague?.kind).toBe("server_error");
    expect(vague?.message).not.toContain("HTTP");
  });

  it("names the host and purpose for a DNS failure", () => {
    const diagnosis = classifyNetworkError(
      transportError("getaddrinfo ENOTFOUND api.deepseek.com", "ENOTFOUND"),
      { host: "api.deepseek.com", purpose: "the model API (DeepSeek)" },
    );
    expect(diagnosis?.kind).toBe("dns");
    expect(diagnosis?.message).toContain("api.deepseek.com");
    expect(diagnosis?.message).toContain("the model API");
    expect(diagnosis?.hint).toContain("--doctor");
  });

  it("unwraps Node's `fetch failed` wrapper and classifies the cause", () => {
    const cause = transportError("getaddrinfo EAI_AGAIN registry.npmjs.org", "EAI_AGAIN");
    const wrapped = transportError("fetch failed", "", cause);
    const diagnosis = classifyNetworkError(wrapped, { purpose: "the self-update check" });
    expect(diagnosis?.kind).toBe("dns");
    expect(diagnosis?.message).toContain("registry.npmjs.org");
  });

  it("classifies timeouts, including undici's connect timeout and AbortSignal.timeout", () => {
    expect(classifyNetworkError(transportError("connect ETIMEDOUT 10.0.0.1:443", "ETIMEDOUT"), { host: "api.deepseek.com" })?.kind).toBe("timeout");
    expect(classifyNetworkError(transportError("connect timeout", "UND_ERR_CONNECT_TIMEOUT"), { host: "cdn.jsdelivr.net" })?.kind).toBe("timeout");
    const aborted = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(classifyNetworkError(aborted, { host: "api.openai.com" })?.kind).toBe("timeout");
  });

  it("names the timeout phase instead of blaming a slow network", () => {    const stalled = new ProviderRequestError(new Error("Provider connection timed out: no data received for 120s (stream stalled)"), { attempts: 2, kind: "timeout" });
    const stalledDiagnosis = classifyNetworkError(stalled, { host: "openrouter.ai", purpose: "the model API" });
    expect(stalledDiagnosis?.kind).toBe("timeout");
    expect(stalledDiagnosis?.message).toContain("no data received for 120s");
    expect(stalledDiagnosis?.message).not.toContain("slow, or the network is blocking");

    const ttfb = new ProviderRequestError(new Error("Provider timed out waiting for response headers (no first byte within 120s)"), { attempts: 1, kind: "timeout" });
    expect(classifyNetworkError(ttfb, { host: "openrouter.ai", purpose: "the model API" })?.message)
      .toContain("waiting for response headers");

    // The retry wrapper's own bookkeeping never becomes the detail.
    const wrapped = new ProviderRequestError(new Error("socket timed out"), { attempts: 4, kind: "timeout", waitedMs: 7000 });
    const wrappedDiagnosis = classifyNetworkError(wrapped, { host: "openrouter.ai", purpose: "the model API" });
    expect(wrappedDiagnosis?.kind).toBe("timeout");
    expect(wrappedDiagnosis?.message).toContain("is slow, or the network is blocking it");
  });

  it("reports how long a rate limit was waited out before giving up", () => {
    const limited = new ProviderRequestError(Object.assign(new Error("too many requests"), { status: 429 }), { attempts: 6, kind: "rate_limit", waitedMs: 62000 });
    const diagnosis = classifyNetworkError(limited, { host: "openrouter.ai", purpose: "the model API" });
    expect(diagnosis?.kind).toBe("rate_limit");
    expect(diagnosis?.message).toContain("after 6 attempts");
    expect(diagnosis?.message).toContain("over 62s of retries");
  });

  it("distinguishes refused, reset and unreachable connections", () => {
    expect(classifyNetworkError(transportError("connect ECONNREFUSED 127.0.0.1:443", "ECONNREFUSED"), { host: "relay.example.com" })?.kind).toBe("refused");
    expect(classifyNetworkError(transportError("read ECONNRESET", "ECONNRESET"), { host: "api.exa.ai" })?.kind).toBe("reset");
    expect(classifyNetworkError(transportError("connect ENETUNREACH", "ENETUNREACH"), { host: "api.anthropic.com" })?.kind).toBe("unreachable");
  });

  it("names a TLS interception for certificate errors", () => {
    const diagnosis = classifyNetworkError(transportError("self signed certificate in certificate chain", "DEPTH_ZERO_SELF_SIGNED_CERT"), { host: "api.deepseek.com" });
    expect(diagnosis?.kind).toBe("tls");
    expect(diagnosis?.message).toContain("TLS certificate");
    expect(diagnosis?.hint).toContain("proxy");
  });

  it("classifies the SDK connection-error wrapper by its cause", () => {
    const sdkError = Object.assign(new Error("Connection error."), {
      name: "APIConnectionError",
      cause: transportError("connect ECONNREFUSED", "ECONNREFUSED"),
    });
    const diagnosis = classifyNetworkError(sdkError, { host: "api.openai.com", purpose: "the model API" });
    expect(diagnosis?.kind).toBe("refused");
    expect(diagnosis?.message).toContain("api.openai.com");
  });

  it("does not blame the network for a user-initiated abort", () => {
    const cancelled = Object.assign(new Error("Request was aborted."), { name: "APIUserAbortError" });
    expect(classifyNetworkError(cancelled)).toBeNull();
  });
});
