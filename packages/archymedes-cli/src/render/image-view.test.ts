import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { clearKittyImages, imagePreference, IMAGE_PATH, renderImageView } from "./image-view";

/** An RGBA PNG of one flat colour; CRCs stay zero because the decoder does not check them. */
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Uint8Array {
  const chunk = (type: string, data: Uint8Array) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, "ascii");
    Buffer.from(data).copy(out, 8);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const row = [0, ...Array.from({ length: width }, () => rgba).flat()];
  const raw = Buffer.from(Array.from({ length: height }, () => row).flat());
  return new Uint8Array(Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0)),
  ]));
}

const glyph = { requested: "glyph", capability: "unknown" } as const;

describe("image view", () => {
  it("draws a PNG as half-block glyphs within the width and row budget", () => {
    const view = renderImageView(solidPng(40, 20, [255, 0, 0, 255]), { columns: 20, maxRows: 8, depth: "truecolor", preference: glyph, id: 1 });
    expect(view.kind).toBe("image");
    if (view.kind !== "image") return;
    expect(view.mode).toBe("glyph");
    expect(view.rows).toBeLessThanOrEqual(8);
    expect(view.output).toContain("\x1b[38;2;255;0;0m");
    expect(view.output).toContain("▀");
    expect(view.output.split("\n").filter(Boolean)).toHaveLength(view.rows);
  });

  it("uses the grey ramp instead of 24-bit escapes below truecolor", () => {
    const view = renderImageView(solidPng(4, 4, [255, 255, 255, 255]), { columns: 4, maxRows: 2, depth: "ansi256", preference: glyph, id: 1 });
    expect(view.kind === "image" && view.output).not.toContain("\x1b[");
  });

  it("sends Kitty graphics only when asked for in the scrollback layout, and can clear them", () => {
    const kitty = imagePreference({ ARCHYMEDES_IMAGES: "kitty" }, "scrollback");
    const view = renderImageView(solidPng(8, 8, [0, 0, 255, 255]), { columns: 10, maxRows: 5, depth: "truecolor", preference: kitty, id: 7 });
    expect(view.kind === "image" && view.mode).toBe("kitty");
    expect(view.kind === "image" && view.output).toMatch(/^\x1b_Ga=T,f=100,c=10,r=\d+,i=7;/);
    expect(imagePreference({ ARCHYMEDES_IMAGES: "kitty" }, "fixed").capability).toBe("unsupported");
    expect(clearKittyImages([7, 8])).toBe("\x1b_Ga=d,d=i,i=7\x1b\\\x1b_Ga=d,d=i,i=8\x1b\\");
  });

  it("hints at Kitty when the terminal signals it, without using it", () => {
    const preference = imagePreference({ TERM: "xterm-kitty" }, "scrollback");
    expect(preference.requested).toBe("glyph");
    expect(preference.hint).toContain("ARCHYMEDES_IMAGES=kitty");
    expect(imagePreference({ TERM: "xterm-kitty" }, "fixed").hint).toBeUndefined();
  });

  it("explains files it cannot show instead of throwing", () => {
    expect(renderImageView(new Uint8Array([0xff, 0xd8, 0xff]), { columns: 10, maxRows: 5, depth: "truecolor", preference: glyph, id: 1 }))
      .toEqual({ kind: "unsupported", reason: "only PNG images can be shown" });
    const broken = solidPng(2, 2, [0, 0, 0, 255]).slice(0, 40);
    expect(renderImageView(broken, { columns: 10, maxRows: 5, depth: "truecolor", preference: glyph, id: 1 }).kind).toBe("unsupported");
    expect(IMAGE_PATH.test("docs/Logo.PNG")).toBe(true);
    expect(IMAGE_PATH.test("notes.md")).toBe(false);
  });
});
