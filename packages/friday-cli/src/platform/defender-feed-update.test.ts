import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defenderFeedPayload, type DefenderFeedManifest } from "@archymedes/core/cli/defender-feed";
import { defenderFeedKeys, OFFICIAL_DEFENDER_FEED_KEYS, OFFICIAL_DEFENDER_FEED_URL, updateDefenderFeed } from "./defender-feed-update";

const OFFICIAL_ID = "release-2026-01";

describe("Defender feed CLI policy", () => {
  it("uses the official HTTPS authority", () => {
    expect(new URL(OFFICIAL_DEFENDER_FEED_URL).protocol).toBe("https:");
    expect(Object.isFrozen(OFFICIAL_DEFENDER_FEED_KEYS)).toBe(true);
    expect(OFFICIAL_DEFENDER_FEED_KEYS).toEqual({
      [OFFICIAL_ID]: "MCowBQYDK2VwAyEA4/jb1zd6f+jIPAFja1bPNtroXV8MtAZFrKt5BSY+ngI=",
    });
  });

  it("ignores an environment-supplied key without the explicit dev flag", () => {
    const environment = { ARCHYMEDES_DEFENDER_BRAIN_PUBLIC_KEYS: JSON.stringify({ attacker: "public" }) };
    expect(defenderFeedKeys(environment, { releaseBuild: false })).toEqual(OFFICIAL_DEFENDER_FEED_KEYS);
    expect(defenderFeedKeys({ ...environment, ARCHYMEDES_DEV: "0" }, { releaseBuild: false })).toEqual(OFFICIAL_DEFENDER_FEED_KEYS);
  });

  it("with the dev flag only adds keys: the official key is still trusted and cannot be replaced", () => {
    const keys = defenderFeedKeys({
      ARCHYMEDES_DEV: "1",
      ARCHYMEDES_DEFENDER_BRAIN_PUBLIC_KEYS: JSON.stringify({ "staging-1": "public", [OFFICIAL_ID]: "attacker", "bad id": "ignored", huge: "x".repeat(5_000) }),
    }, { releaseBuild: false });
    expect(keys).toEqual({ ...OFFICIAL_DEFENDER_FEED_KEYS, "staging-1": "public" });
    expect(keys[OFFICIAL_ID]).toBe(OFFICIAL_DEFENDER_FEED_KEYS[OFFICIAL_ID]);
  });

  it("falls back to the official keys when the override is malformed", () => {
    expect(defenderFeedKeys({ ARCHYMEDES_DEV: "1", ARCHYMEDES_DEFENDER_BRAIN_PUBLIC_KEYS: "not json" }, { releaseBuild: false })).toEqual(OFFICIAL_DEFENDER_FEED_KEYS);
    expect(defenderFeedKeys({ ARCHYMEDES_DEV: "1", ARCHYMEDES_DEFENDER_BRAIN_PUBLIC_KEYS: "[1]" }, { releaseBuild: false })).toEqual(OFFICIAL_DEFENDER_FEED_KEYS);
  });

  it("ignores the override entirely in a release build, even with the dev flag", () => {
    const environment = { ARCHYMEDES_DEV: "1", ARCHYMEDES_DEFENDER_BRAIN_PUBLIC_KEYS: JSON.stringify({ "staging-1": "public" }) };
    expect(defenderFeedKeys(environment, { releaseBuild: true })).toEqual(OFFICIAL_DEFENDER_FEED_KEYS);
  });
});

describe("Defender feed CLI end to end", () => {
  let directory: string;
  const attacker = generateKeyPairSync("ed25519");
  const attackerPublic = attacker.publicKey.export({ format: "der", type: "spki" }).toString("base64");
  const corpus = Buffer.from(`${JSON.stringify({ schemaVersion: 1, id: "poisoned" })}\n`);

  beforeEach(async () => { directory = await fs.mkdtemp(path.join(os.tmpdir(), "friday-defender-policy-")); });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });

  function signedBy(keyId: string): DefenderFeedManifest {
    const unsigned: Omit<DefenderFeedManifest, "signature"> = {
      schemaVersion: 1, feed: "archymedes-defender", sequence: 1,
      generatedAt: "2026-08-24T00:00:00.000Z", expiresAt: "2026-09-01T00:00:00.000Z", keyId,
      corpus: { url: "https://feed.example/corpus", sha256: createHash("sha256").update(corpus).digest("hex"), bytes: corpus.byteLength, records: 1 },
    };
    return { ...unsigned, signature: sign(null, Buffer.from(defenderFeedPayload(unsigned)), attacker.privateKey).toString("base64url") };
  }

  const serve = (manifest: DefenderFeedManifest) => async (input: string | URL): Promise<Response> =>
    String(input).endsWith("/manifest") ? Response.json(manifest) : new Response(corpus);

  it.each([
    ["without the dev flag", { [`attacker-1`]: "" }, "attacker-1", undefined],
    ["claiming the official key id, with the dev flag", { [OFFICIAL_ID]: "" }, OFFICIAL_ID, "1"],
  ])("rejects a feed signed by an environment-supplied key %s", async (_name, ids, keyId, dev) => {
    const environment = {
      ARCHYMEDES_CONFIG_DIR: directory,
      ARCHYMEDES_DEFENDER_FEED_URL: "https://feed.example/manifest",
      ARCHYMEDES_DEFENDER_BRAIN_PUBLIC_KEYS: JSON.stringify(Object.fromEntries(Object.keys(ids).map((id) => [id, attackerPublic]))),
      ...(dev ? { ARCHYMEDES_DEV: dev } : {}),
    };
    const result = await updateDefenderFeed(environment, { fetch: serve(signedBy(keyId)), now: Date.parse("2026-08-24T12:00:00Z"), releaseBuild: false });
    expect(result.status).toBe("rejected");
  });

  it("accepts a staging key only when the dev flag is set in a development build", async () => {
    const environment = {
      ARCHYMEDES_CONFIG_DIR: directory,
      ARCHYMEDES_DEFENDER_FEED_URL: "https://feed.example/manifest",
      ARCHYMEDES_DEFENDER_BRAIN_PUBLIC_KEYS: JSON.stringify({ "staging-1": attackerPublic }),
      ARCHYMEDES_DEV: "1",
    };
    const options = { fetch: serve(signedBy("staging-1")), now: Date.parse("2026-08-24T12:00:00Z") };
    expect((await updateDefenderFeed(environment, { ...options, releaseBuild: true })).status).toBe("rejected");
    expect((await updateDefenderFeed(environment, { ...options, releaseBuild: false, force: true })).status).toBe("updated");
  });
});
