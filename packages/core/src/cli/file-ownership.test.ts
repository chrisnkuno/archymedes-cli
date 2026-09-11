import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireFileOwnership } from "./file-ownership";

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-owner-")); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("file ownership", () => {
  it("rejects a second writer even when the live ownership record is old", async () => {
    const file = path.join(root, "owner");
    const release = await acquireFileOwnership(file);
    await fs.utimes(file, new Date(0), new Date(0));
    await expect(acquireFileOwnership(file)).rejects.toThrow("already owned");
    await release();
    const next = await acquireFileOwnership(file);
    await next();
  });

  it("recovers a dead writer and an abandoned reclamation guard", async () => {
    const file = path.join(root, "owner");
    const dead = JSON.stringify({ token: "dead", pid: 2147483647, host: os.hostname() });
    await fs.writeFile(file, dead);
    await fs.writeFile(`${file}.reap`, dead);
    const release = await acquireFileOwnership(file);
    expect(JSON.parse(await fs.readFile(file, "utf8")).pid).toBe(process.pid);
    await release();
  });

  it("does not reclaim another host's ownership or malformed metadata", async () => {
    const file = path.join(root, "owner");
    await fs.writeFile(file, JSON.stringify({ token: "other", pid: 2147483647, host: "different-host" }));
    await expect(acquireFileOwnership(file)).rejects.toThrow("already owned");
    await fs.writeFile(file, "{}");
    await expect(acquireFileOwnership(file)).rejects.toThrow("Invalid ownership");
  });
});
