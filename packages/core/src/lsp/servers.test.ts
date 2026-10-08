import { describe, expect, it } from "vitest";
import {
  LANGUAGE_SERVERS,
  commandAvailable,
  discoverAvailableServers,
  serverForExtension,
  serverForFilename,
  serverForLanguageId,
} from "./servers";

describe("the server table", () => {
  it("gives every entry an id, a command, and at least one language id", () => {
    for (const server of LANGUAGE_SERVERS) {
      expect(server.id, server.id).toMatch(/^[a-z]+$/);
      expect(server.command, server.id).not.toBe("");
      expect(server.languageIds.length, server.id).toBeGreaterThan(0);
    }
  });

  it("has no two entries with the same id or the same command", () => {
    const ids = LANGUAGE_SERVERS.map((server) => server.id);
    expect(new Set(ids).size).toBe(ids.length);
    const commands = LANGUAGE_SERVERS.map((server) => server.command);
    expect(new Set(commands).size).toBe(commands.length);
  });

  it("claims the common extensions a developer would ask about", () => {
    expect(serverForExtension(".ts")?.id).toBe("typescript");
    expect(serverForExtension(".py")?.id).toBe("pyright");
    expect(serverForExtension(".rs")?.id).toBe("rust");
    expect(serverForExtension(".go")?.id).toBe("go");
  });

  it("matches extensions case-insensitively and returns nothing for an unknown one", () => {
    expect(serverForExtension(".TS")?.id).toBe("typescript");
    expect(serverForExtension(". COFFEE")).toBeUndefined();
  });

  it("matches whole filenames for extensionless files like Dockerfile", () => {
    expect(serverForFilename("Dockerfile")?.id).toBe("docker");
    expect(serverForFilename("dockerfile")?.id).toBe("docker");
    expect(serverForFilename("main.ts")?.id).toBe("typescript");
  });

  it("matches language ids for callers that know the language", () => {
    expect(serverForLanguageId("typescript")?.id).toBe("typescript");
    expect(serverForLanguageId("python")?.id).toBe("pyright");
    expect(serverForLanguageId("dockerfile")?.id).toBe("docker");
    expect(serverForLanguageId("brainfuck")).toBeUndefined();
  });
});

describe("commandAvailable", () => {
  it("asks the probe and answers what it says", async () => {
    expect(await commandAvailable("anything", async () => true)).toBe(true);
    expect(await commandAvailable("anything", async () => false)).toBe(false);
  });

  it("treats a probe that throws as not available rather than propagating", async () => {
    expect(await commandAvailable("anything", () => Promise.reject(new Error("no PATH here")))).toBe(false);
  });
});

describe("discoverAvailableServers", () => {
  it("keeps the table order and includes exactly what the probe reports", async () => {
    const available = await discoverAvailableServers(async (command) => command === "gopls" || command === "pylsp");
    expect(available.map((server) => server.id)).toEqual(["pylsp", "go"]);
  });

  it("returns an empty list when nothing is installed", async () => {
    expect(await discoverAvailableServers(async () => false)).toEqual([]);
  });
});
