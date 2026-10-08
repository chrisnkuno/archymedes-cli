import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnArchymedes, type ArchymedesProcess } from "./harness";

let root: string;
let proc: ArchymedesProcess | undefined;
afterEach(async () => { proc?.kill(); if (root) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });

it("explains free mode is unavailable without a key or gateway, and never opens the settings menu", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "archymedes-free-pty-"));
  proc = spawnArchymedes({ cwd: root, args: ["--free", "--currency", "USD"], env: {
    ARCHYMEDES_CONFIG_DIR: path.join(root, "config"), OPENROUTER_API_KEY: "", OPENAI_API_KEY: "paid-test-key",
    ARCHYMEDES_PROVIDER: "openai", ARCHYMEDES_FX_OFFLINE: "true",
  } });
  // Free mode is keyless through a gateway; with neither a gateway nor a key
  // configured, the answer is a configuration error — not a settings menu
  // that can only ask for a key free mode never required.
  await proc.waitFor(/ARCHYMEDES_FREE_GATEWAY_URL/, { timeoutMs: 30000 });
  const output = proc.output();
  expect(output).not.toContain("OpenRouter API key:");
  expect(output).not.toContain("paid-test-key");
  const result = await proc.waitForExit(10000);
  expect(result.exitCode).not.toBe(0);
}, 45000);

it("gets past configuration with a gateway and no key, failing only on connectivity", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "archymedes-free-pty-"));
  proc = spawnArchymedes({ cwd: root, args: ["--free", "hello"], env: {
    ARCHYMEDES_CONFIG_DIR: path.join(root, "config"), OPENROUTER_API_KEY: "", OPENAI_API_KEY: "paid-test-key",
    ARCHYMEDES_FREE_GATEWAY_URL: "https://free-gateway.test", ARCHYMEDES_FX_OFFLINE: "true",
  } });
  // The gateway is configured, so free mode starts without any key: the
  // session resolves its provider and only the unreachable gateway fails —
  // reported as the network failure it is (an unresolvable, refused or
  // unreachable host), never as a provider "server error".
  await proc.waitFor(/could not be resolved|was refused|No network route|connection to \S+ failed|timed out|connectivity/, { timeoutMs: 30000 });
  const output = proc.output();
  expect(output).not.toContain("server error");
  expect(output).not.toContain("is not configured");
  expect(output).not.toContain("ARCHYMEDES_FREE_GATEWAY_URL (a self-hosted free gateway)");
  const result = await proc.waitForExit(30000);
  expect(result.exitCode).not.toBe(0);
}, 45000);
