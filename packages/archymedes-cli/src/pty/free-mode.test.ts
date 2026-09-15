import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { spawnArchymedes, type ArchymedesProcess } from "./harness";

let root: string;
let proc: ArchymedesProcess | undefined;
afterEach(async () => { proc?.kill(); if (root) await rm(root, { recursive: true, force: true }); });

it("opens settings for --free without a key, even when a paid provider is configured", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "archymedes-free-pty-"));
  proc = spawnArchymedes({ cwd: root, args: ["--free", "--currency", "USD"], env: {
    ARCHYMEDES_CONFIG_DIR: path.join(root, "config"), OPENROUTER_API_KEY: "", OPENAI_API_KEY: "paid-test-key",
    ARCHYMEDES_PROVIDER: "openai", ARCHYMEDES_FX_OFFLINE: "true",
  } });
  await proc.waitFor(/OpenRouter API key/, { timeoutMs: 30000 });
  expect(proc.output()).not.toContain("paid-test-key");
  proc.write("\u0003");
  const result = await proc.waitForExit(10000);
  expect(result.exitCode).not.toBe(0);
}, 45000);
