import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { runCat, type CatContext } from "./cat";

function onePixelPng(): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(data).copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2, 0);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.from([0, 0, 255, 0, 255, 0, 255, 0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 255, 255]);
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))]));
}

function context(overrides: Partial<CatContext> = {}) {
  const written: string[] = [];
  const warnings: string[] = [];
  const folded: string[] = [];
  const kitty: number[] = [];
  let id = 0;
  const ctx: CatContext = {
    readFile: async (path) => ({ path, content: `contents of ${path}\n# Title`, startLine: 1, totalLines: 2, truncated: false }),
    readBytes: async (path) => ({ path, bytes: onePixelPng() }),
    write: (text) => written.push(text),
    warn: (text) => warnings.push(text),
    writeFoldable: (label, block) => folded.push(`${label}:${block.text}`),
    style: { width: 60, depth: "none" },
    width: 60,
    foldAfterLines: 14,
    images: { requested: "glyph", capability: "unknown" },
    imageRows: 10,
    onKittyImage: (value) => kitty.push(value),
    nextImageId: () => ++id,
    ...overrides,
  };
  return { ctx, written, warnings, folded, kitty };
}

describe("/cat", () => {
  it("folds code, renders markdown, and asks for a path when given none", async () => {
    const code = context();
    await runCat("src/app.ts", code.ctx);
    expect(code.folded[0]).toContain("contents of src/app.ts");
    const markdown = context();
    await runCat("README.md", markdown.ctx);
    expect(markdown.written.join("")).toContain("Title");
    expect(markdown.written.join("")).not.toContain("# Title");
    const empty = context();
    await runCat("", empty.ctx);
    expect(empty.warnings).toEqual(["Usage: /cat <path>"]);
  });

  it("draws a PNG with its size in the rule, and records Kitty placements", async () => {
    const glyph = context();
    await runCat("logo.png", glyph.ctx);
    expect(glyph.warnings).toEqual([]);
    expect(glyph.written.join("")).toContain("2×2");
    expect(glyph.kitty).toEqual([]);
    const kitty = context({ images: { requested: "kitty", capability: "supported" } });
    await runCat("logo.png", kitty.ctx);
    expect(kitty.written.join("")).toContain("\x1b_G");
    expect(kitty.kitty).toEqual([1]);
  });

  it("explains an image it cannot read from a sandbox and a file it cannot read at all", async () => {
    const sandbox = context({ readBytes: undefined });
    await runCat("logo.png", sandbox.ctx);
    expect(sandbox.warnings[0]).toContain("local workspace only");
    const failing = context({ readFile: async () => { throw new Error("missing.ts does not exist"); } });
    await runCat("missing.ts", failing.ctx);
    expect(failing.warnings).toEqual(['Could not read "missing.ts": missing.ts does not exist']);
  });
});
