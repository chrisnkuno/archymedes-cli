import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_IMAGE_BYTES } from "../image-attachments";
import { assertSupportedSchema, validateToolArguments, type ToolInputSchema } from "../tool-schema";
import { createImageTools } from "./image";

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const context = { taskId: "t", runId: "r", stepId: "s" };

let root: string;
let outside: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-view-image-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "archymedes-view-image-outside-"));
  await fs.mkdir(path.join(root, "shots"));
  await fs.writeFile(path.join(root, "shots", "ui.png"), PNG);
  await fs.writeFile(path.join(root, "shots", "fake.png"), "not an image");
  await fs.writeFile(path.join(outside, "secret.png"), PNG);
  const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1);
  Buffer.from(PNG).copy(huge);
  await fs.writeFile(path.join(root, "huge.png"), huge);
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

const viewImage = () => createImageTools({ root })[0];

describe("view_image", () => {
  it("is a read-only, parallel-safe tool with a supported schema", () => {
    const tool = viewImage();
    expect(tool).toMatchObject({ name: "view_image", effect: "none", parallelSafe: true, requiresApproval: false, capabilityId: "workspace.files.read" });
    expect(() => assertSupportedSchema(tool.name, tool.inputSchema)).not.toThrow();
    expect(() => validateToolArguments(tool.name, tool.inputSchema as ToolInputSchema, {})).toThrow();
  });

  it("returns the image bytes as an image on the result, with a caption as content", async () => {
    const result = await viewImage().execute({ path: "shots/ui.png" }, context);
    expect(result.content).toBe("Image shots/ui.png (image/png, 12 bytes) is attached below.");
    expect(result.images).toEqual([{ path: "shots/ui.png", mediaType: "image/png", data: Buffer.from(PNG).toString("base64") }]);
    expect(result.data).toEqual({ path: "shots/ui.png", mediaType: "image/png", bytes: 12 });
  });

  it("sniffs the type from the bytes, not the extension", async () => {
    await expect(viewImage().execute({ path: "shots/fake.png" }, context)).rejects.toThrow("not a PNG, JPEG, GIF or WebP image");
  });

  it("caps the size at MAX_IMAGE_BYTES", async () => {
    await expect(viewImage().execute({ path: "huge.png" }, context)).rejects.toThrow(`above the ${MAX_IMAGE_BYTES}-byte read limit`);
  });

  it("is confined to the workspace", async () => {
    await expect(viewImage().execute({ path: path.join(outside, "secret.png") }, context)).rejects.toThrow();
    await expect(viewImage().execute({ path: `../${path.basename(outside)}/secret.png` }, context)).rejects.toThrow();
  });

  it("reports a missing file and a non-string path", async () => {
    await expect(viewImage().execute({ path: "nope.png" }, context)).rejects.toThrow("does not exist");
    await expect(viewImage().execute({ path: 3 }, context)).rejects.toThrow("path must be a non-empty string");
  });
});
