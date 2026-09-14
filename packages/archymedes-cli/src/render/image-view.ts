import type { ColorDepth } from "../text/color-depth";
import { chooseMode, clearKitty, glyphRowCount, kittyEnvSignalled, renderGlyph, renderKitty, type KittyCapability, type PictureMode } from "./picture";
import { decodePng, isPng } from "./png";

/** File names `/cat` shows as a picture. PNG is the format the bundled decoder reads. */
export const IMAGE_PATH = /\.png$/i;

export type ImagePreference = { requested: PictureMode; capability: KittyCapability; hint?: string };
export type TerminalLayout = "fixed" | "scrollback";

/**
 * How images are drawn. Kitty graphics need affirmative evidence, and `ARCHYMEDES_IMAGES=kitty` is
 * that evidence; the environment only earns a hint. The fixed workspace always uses glyphs: its
 * repaints replay text, and a graphics escape replayed as text is raw base64 on screen.
 */
export function imagePreference(environment: Record<string, string | undefined>, layout: TerminalLayout): ImagePreference {
  const wantsKitty = environment.ARCHYMEDES_IMAGES?.trim().toLowerCase() === "kitty";
  if (wantsKitty) return { requested: "kitty", capability: layout === "scrollback" ? "supported" : "unsupported" };
  const hint = layout === "scrollback" && kittyEnvSignalled(environment as NodeJS.ProcessEnv)
    ? "this terminal may draw real pixels: set ARCHYMEDES_IMAGES=kitty to try it"
    : undefined;
  return { requested: "glyph", capability: "unknown", ...(hint ? { hint } : {}) };
}

export type ImageView =
  | { kind: "image"; mode: PictureMode; output: string; rows: number; width: number; height: number }
  | { kind: "unsupported"; reason: string };

/**
 * A PNG as transcript output, at most `columns` wide and `maxRows` tall. Glyphs are coloured only
 * at truecolor depth, because the half-block renderer emits 24-bit escapes; anything less gets the
 * grey ramp rather than escape codes the terminal would print.
 */
export function renderImageView(bytes: Uint8Array, options: { columns: number; maxRows: number; depth: ColorDepth; preference: ImagePreference; id: number }): ImageView {
  if (!isPng(bytes)) return { kind: "unsupported", reason: "only PNG images can be shown" };
  let image;
  try {
    image = decodePng(bytes);
  } catch (error) {
    return { kind: "unsupported", reason: `could not decode it: ${error instanceof Error ? error.message : String(error)}` };
  }
  const columns = Math.max(1, Math.floor(options.columns));
  const maxRows = Math.max(1, Math.floor(options.maxRows));
  const rows = glyphRowCount(image, columns, maxRows);
  const mode = chooseMode(options.preference.requested, options.preference.capability);
  const size = { width: image.width, height: image.height };
  if (mode === "kitty") {
    // The terminal draws the picture over the next `rows` cells; the newlines move the cursor past it.
    return { kind: "image", mode, output: `${renderKitty(bytes, { cols: columns, rows, id: options.id })}${"\n".repeat(rows)}`, rows, ...size };
  }
  const lines = renderGlyph(image, { cols: columns, rows: maxRows, color: options.depth === "truecolor" ? "truecolor" : "none" });
  return { kind: "image", mode, output: `${lines.join("\n")}\n`, rows: lines.length, ...size };
}

/** Removes Kitty images this session placed, for `/clear`. */
export function clearKittyImages(ids: readonly number[]): string {
  return ids.map(clearKitty).join("");
}
