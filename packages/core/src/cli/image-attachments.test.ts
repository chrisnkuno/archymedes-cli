import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentModelRequest, AgentModelTurn, AgentTurnProvider } from "../agent-runtime";
import { toAnthropicMessages } from "../providers/anthropic-agent";
import { toWireMessage } from "../providers/openai-compatible";
import { ArchymedesAgent } from "./agent";
import { LocalWorkspace } from "./backends";
import { MAX_IMAGES_PER_TURN, attachMentionedImages, imageMediaType, mentionedImagePaths, objectiveWithImageProblems, withoutImageData } from "./image-attachments";
import { loadSession } from "./session";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const WEBP = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-images-"));
  await fs.mkdir(path.join(root, "shots"));
  await fs.writeFile(path.join(root, "shots", "bug.png"), PNG);
  await fs.writeFile(path.join(root, "fake.png"), "not an image");
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("finding images a request points at", () => {
  it("reads @mentions of image files, not emails or other files", () => {
    expect(mentionedImagePaths("why does @shots/bug.png look wrong, see @a.jpeg, @b.webp! mail me@x.png and @src/app.ts")).toEqual(["shots/bug.png", "a.jpeg", "b.webp"]);
  });

  it("identifies the type from the bytes, not the extension", () => {
    expect(imageMediaType(PNG)).toBe("image/png");
    expect(imageMediaType(JPEG)).toBe("image/jpeg");
    expect(imageMediaType(WEBP)).toBe("image/webp");
    expect(imageMediaType(new TextEncoder().encode("GIF89a"))).toBe("image/gif");
    expect(imageMediaType(new TextEncoder().encode("not an image"))).toBeUndefined();
  });

  it("attaches real images and reports every one it could not", async () => {
    const workspace = new LocalWorkspace(root);
    const result = await attachMentionedImages(workspace, "compare @shots/bug.png with @fake.png and @missing.png");
    expect(result.images).toEqual([{ path: "shots/bug.png", mediaType: "image/png", data: Buffer.from(PNG).toString("base64") }]);
    expect(result.problems[0]).toContain("@fake.png: not a PNG, JPEG, GIF or WebP image");
    expect(result.problems[1]).toContain("@missing.png");
    expect(objectiveWithImageProblems("x", result.problems)).toContain("(Not attached — @fake.png");

    for (let i = 0; i <= MAX_IMAGES_PER_TURN; i++) await fs.writeFile(path.join(root, `s${i}.png`), PNG);
    const many = await attachMentionedImages(workspace, Array.from({ length: MAX_IMAGES_PER_TURN + 1 }, (_, i) => `@s${i}.png`).join(" "));
    expect(many.images).toHaveLength(MAX_IMAGES_PER_TURN);
    expect(many.problems).toEqual([`@s${MAX_IMAGES_PER_TURN}.png: at most ${MAX_IMAGES_PER_TURN} images per request`]);
    expect(await attachMentionedImages({}, "see @shots/bug.png")).toEqual({ images: [], problems: ["@shots/bug.png: images can only be attached from a local workspace"] });
  });
});

describe("sending images to providers", () => {
  const image = { path: "shots/bug.png", mediaType: "image/png" as const, data: "AAAA" };

  it("uses content parts on the Chat Completions wire and image blocks on Anthropic's", () => {
    expect(toWireMessage({ role: "user", content: "what is wrong?", images: [image] })).toEqual({
      role: "user",
      content: [{ type: "text", text: "what is wrong?" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }],
    });
    expect(toWireMessage({ role: "user", content: "plain" })).toEqual({ role: "user", content: "plain" });
    expect(toAnthropicMessages([{ role: "user", content: "what is wrong?", images: [image] }]).messages).toEqual([{
      role: "user",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }, { type: "text", text: "what is wrong?" }],
    }]);
  });

  it("keeps images out of saved history, leaving a note of what was attached", () => {
    expect(withoutImageData([{ role: "user", content: "look", images: [image] }])).toEqual([{ role: "user", content: "look\n\n[image attached: shots/bug.png]" }]);
  });

  it("sends a mentioned image with the turn, end to end, and saves the session without its data", async () => {
    const requests: AgentModelRequest[] = [];
    const model: AgentTurnProvider = {
      async complete(request) {
        requests.push({ ...request, messages: [...request.messages] });
        return { responseId: "r", model: "m", finishReason: "stop", content: "The button overlaps.", toolCalls: [],
          usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105, cachedInputTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 } } as AgentModelTurn;
      },
    };
    const agent = new ArchymedesAgent({
      root, model, prices: { inputRatePerMillion: 2_000, outputRatePerMillion: 8_000 }, mode: "build",
      approve: async () => "allow",
      workspace: new LocalWorkspace(root),
      git: async () => ({ exitCode: 1, stdout: "", stderr: "not a repo" }),
    });
    await agent.send("what is wrong in @shots/bug.png?");
    const user = requests[0].messages.at(-1)!;
    expect(user).toMatchObject({ role: "user", images: [{ path: "shots/bug.png", mediaType: "image/png" }] });

    const saved = JSON.stringify(await loadSession(root, agent.sessionId));
    expect(saved).not.toContain(Buffer.from(PNG).toString("base64"));
    expect(saved).toContain("image attached: shots/bug.png");
    await agent.dispose();
  }, 20_000);
});
