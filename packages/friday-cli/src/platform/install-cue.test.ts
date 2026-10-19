import { describe, expect, it } from "vitest";
import { cueFor, cueOptedOut, INSTALL_CUE_URL, sendInstallCue, type CueDependencies } from "./install-cue";

function counter(status = 204, lastVersion?: string) {
  const sent: Array<{ url: string; body: unknown; headers: unknown }> = [];
  let marker = lastVersion;
  const dependencies: CueDependencies = {
    fetch: (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), headers: init.headers });
      return new Response(null, { status });
    }) as unknown as typeof fetch,
    readMarker: async () => marker,
    writeMarker: async (version) => { marker = version; },
  };
  return { sent, dependencies, marker: () => marker };
}

describe("install cue", () => {
  it("owes an install on a first run, an update on a new version, and nothing after", () => {
    expect(cueFor(undefined, "3.9.0", "linux", "x64")).toEqual({ event: "install", version: "3.9.0", os: "linux", arch: "x64" });
    expect(cueFor("3.8.0", "3.9.0", "darwin", "arm64")).toEqual({ event: "update", version: "3.9.0", os: "darwin", arch: "arm64" });
    expect(cueFor("3.9.0", "3.9.0", "linux", "x64")).toBeUndefined();
  });

  it("sends the four fields and nothing else, once per version", async () => {
    const { sent, dependencies, marker } = counter();
    expect(await sendInstallCue({}, dependencies, "3.9.0")).toBe("sent");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(INSTALL_CUE_URL);
    expect(Object.keys(sent[0]!.body as object).sort()).toEqual(["arch", "event", "os", "version"]);
    expect(marker()).toBe("3.9.0");
    expect(await sendInstallCue({}, dependencies, "3.9.0")).toBe("owed-none");
    expect(sent).toHaveLength(1);
  });

  it("is off with ARCHYMEDES_TELEMETRY=off, DO_NOT_TRACK, in CI and in tests", async () => {
    for (const environment of [{ ARCHYMEDES_TELEMETRY: "off" }, { ARCHYMEDES_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }, { CI: "true" }, { NODE_ENV: "test" }]) {
      expect(cueOptedOut(environment)).toBe(true);
      const { sent, dependencies } = counter();
      expect(await sendInstallCue(environment, dependencies, "3.9.0")).toBe("opted-out");
      expect(sent).toHaveLength(0);
    }
    expect(cueOptedOut({ DO_NOT_TRACK: "0", ARCHYMEDES_TELEMETRY: "on" })).toBe(false);
  });

  it("retries after no answer or a server error, and stops after a refusal", async () => {
    const down = counter(503);
    expect(await sendInstallCue({}, down.dependencies, "3.9.0")).toBe("failed");
    expect(down.marker()).toBeUndefined();
    const refused = counter(400);
    expect(await sendInstallCue({}, refused.dependencies, "3.9.0")).toBe("sent");
    expect(refused.marker()).toBe("3.9.0");
    const offline = counter();
    offline.dependencies.fetch = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    expect(await sendInstallCue({}, offline.dependencies, "3.9.0")).toBe("failed");
    expect(offline.marker()).toBeUndefined();
  });
});
