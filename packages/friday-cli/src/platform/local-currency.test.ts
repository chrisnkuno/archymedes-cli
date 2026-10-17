import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { countryFromEnvironment, fetchDailyFxRate, FX_CACHE_MAX_AGE_MS, fxCachePath, readCachedFxRate, resolveCurrencyPreference, startFxRateLookup, writeCachedFxRate } from "./local-currency";

describe("CLI local currency preference", () => {
  it("detects a country from standard locale variables", () => {
    expect(countryFromEnvironment({ LANG: "ar_EG.UTF-8" }, "Etc/UTC")).toBe("EG");
    expect(resolveCurrencyPreference({ environment: { TZ: "Africa/Cairo", LANG: "en_US.UTF-8" }, providerCurrency: "USD" })).toMatchObject({ currency: "EGP", countryCode: "EG", source: "location" });
  });

  it("prefers explicit currency, then environment configuration, over automatic locale", () => {
    expect(resolveCurrencyPreference({ currency: "GBP", country: "GB", environment: { LANG: "ar_EG.UTF-8" }, providerCurrency: "USD" }).currency).toBe("GBP");
    expect(resolveCurrencyPreference({ environment: { ARCHYMEDES_CURRENCY: "EUR", LANG: "ar_EG.UTF-8" }, providerCurrency: "USD" }).currency).toBe("EUR");
  });

  it("falls back to provider currency when location cannot be mapped", () => {
    expect(resolveCurrencyPreference({ environment: { LANG: "C.UTF-8", TZ: "Etc/UTC" }, providerCurrency: "USD" })).toMatchObject({ currency: "USD", source: "provider" });
  });
});

describe("daily FX lookup", () => {
  it("returns a dated rate from the requested provider currency to local currency", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ date: "2026-08-08", usd: { egp: 48.5 } }), { status: 200 }));
    await expect(fetchDailyFxRate("USD", "EGP", fetchImpl as typeof fetch)).resolves.toEqual({
      from: "USD", to: "EGP", rate: 48.5, asOf: "2026-08-08", source: "fawazahmed0/exchange-api daily rate",
    });
  });

  it("fails safely without inventing a conversion", async () => {
    const fetchImpl = vi.fn(async () => { throw new Error("offline"); });
    await expect(fetchDailyFxRate("USD", "EGP", fetchImpl as typeof fetch)).resolves.toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports why the lookup failed so the caller can name the broken endpoint", async () => {
    const fetchImpl = vi.fn(async () => { throw Object.assign(new Error("getaddrinfo ENOTFOUND cdn.jsdelivr.net"), { code: "ENOTFOUND" }); });
    const failures: { host: string; kind: string }[] = [];
    await expect(fetchDailyFxRate("USD", "EGP", fetchImpl as typeof fetch, (failure) => {
      failures.push({ host: failure.host, kind: failure.diagnosis.kind });
    })).resolves.toBeNull();
    expect(failures).toEqual([
      { host: "cdn.jsdelivr.net", kind: "dns" },
      { host: "latest.currency-api.pages.dev", kind: "dns" },
    ]);
  });

  it("stops at the first successful host", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("latest.currency-api.pages.dev")) throw new Error("offline");
      return new Response(JSON.stringify({ date: "2026-08-08", usd: { egp: 48.5 } }), { status: 200 });
    });
    await expect(fetchDailyFxRate("USD", "EGP", fetchImpl as typeof fetch)).resolves.toMatchObject({ rate: 48.5 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("non-blocking startup FX lookup", () => {
  let configDir: string;
  beforeEach(async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-fx-"));
  });
  afterEach(async () => {
    await fs.rm(configDir, { recursive: true, force: true });
  });
  const ok = () => vi.fn(async () => new Response(JSON.stringify({ date: "2026-08-08", usd: { egp: 48.5 } }), { status: 200 }));

  it("returns immediately with no rate and a background refresh that caches its result", async () => {
    const environment = { ARCHYMEDES_CONFIG_DIR: configDir };
    const fetchImpl = ok();
    const lookup = await startFxRateLookup("USD", "EGP", { environment, fetchImpl: fetchImpl as typeof fetch, now: 1_000 });
    expect(lookup.immediate).toBeNull();
    await expect(lookup.refresh).resolves.toMatchObject({ rate: 48.5 });
    await expect(readCachedFxRate("USD", "EGP", environment)).resolves.toMatchObject({ rate: { rate: 48.5, asOf: "2026-08-08" } });
  });

  it("uses a fresh cached rate without touching the network", async () => {
    const environment = { ARCHYMEDES_CONFIG_DIR: configDir };
    await writeCachedFxRate({ from: "USD", to: "EGP", rate: 50, asOf: "2026-08-07", source: "test" }, environment, 1_000);
    const fetchImpl = ok();
    const lookup = await startFxRateLookup("USD", "EGP", { environment, fetchImpl: fetchImpl as typeof fetch, now: 1_000 + 60_000 });
    expect(lookup).toEqual({ immediate: { from: "USD", to: "EGP", rate: 50, asOf: "2026-08-07", source: "test" }, refresh: null });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("serves a stale cached rate while refreshing it in the background", async () => {
    const environment = { ARCHYMEDES_CONFIG_DIR: configDir };
    await writeCachedFxRate({ from: "USD", to: "EGP", rate: 50, asOf: "2026-08-01", source: "test" }, environment, 1_000);
    const lookup = await startFxRateLookup("USD", "EGP", { environment, fetchImpl: ok() as typeof fetch, now: 1_000 + FX_CACHE_MAX_AGE_MS + 1 });
    expect(lookup.immediate).toMatchObject({ rate: 50 });
    await expect(lookup.refresh).resolves.toMatchObject({ rate: 48.5 });
  });

  it("never rejects when the network is down, and treats a corrupt cache as empty", async () => {
    const environment = { ARCHYMEDES_CONFIG_DIR: configDir };
    await fs.writeFile(fxCachePath(environment), "{ not json");
    const failures: unknown[] = [];
    const lookup = await startFxRateLookup("USD", "EGP", {
      environment,
      fetchImpl: vi.fn(async () => { throw new Error("offline"); }) as unknown as typeof fetch,
      onFailure: (failure) => failures.push(failure),
    });
    expect(lookup.immediate).toBeNull();
    await expect(lookup.refresh).resolves.toBeNull();
    expect(failures.length).toBeGreaterThan(0);
  });
});
