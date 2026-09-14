import { BOLD, paint } from "../text/ansi";
import { clipTo, visibleWidth } from "../text/text-width";
import { ASCII_GLYPHS, type GlyphSet, UNICODE_GLYPHS } from "../text/glyphs";
import { rainbowText, type Palette } from "../theme/theme";
import { BEGIN_SYNC, END_SYNC } from "../terminal/fixed-screen";

export type IdentityOptions = {
  width: number;
  rows: number;
  version: string;
  workspace: string;
  model: string;
  mode: string;
  palette: Palette;
  glyphs?: GlyphSet;
  angle?: number;
};

type Point = [number, number, number];

/** Nested tetrahedra joined at their vertices: a triangular analogue of a hypercube. */
export function renderGeometry(angle = 0, ascii = false): string[] {
  const width = 23;
  const height = 11;
  const cells = Array.from({ length: height }, () => Array<string>(width).fill(" "));
  const vertices: Point[] = [[0, 1.15, 0], [-1, -0.7, 0.65], [1, -0.7, 0.65], [0, -0.7, -1]];
  const project = ([x, y, z]: Point, scale: number): [number, number] => {
    const yaw = angle + 0.25;
    const rx = (x * Math.cos(yaw) + z * Math.sin(yaw)) * scale;
    const rz = (-x * Math.sin(yaw) + z * Math.cos(yaw)) * scale;
    const tilt = 0.3 + Math.sin(angle) * 0.18;
    const ry = y * scale * Math.cos(tilt) - rz * Math.sin(tilt);
    const depth = y * scale * Math.sin(tilt) + rz * Math.cos(tilt);
    const perspective = 3.8 / (3.8 + depth);
    return [Math.max(0, Math.min(22, Math.round(11 + rx * perspective * 8))), Math.max(0, Math.min(10, Math.round(5 - ry * perspective * 3.8)))];
  };
  const outer = vertices.map((point) => project(point, 1));
  const inner = vertices.map((point) => project(point, 0.43));
  const line = (a: number[], b: number[], faint = false) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const steps = Math.max(Math.abs(dx), Math.abs(dy));
    const glyph = faint ? "." : Math.abs(dx) > Math.abs(dy) * 2 ? "-" : dx === 0 ? "|" : dx * dy > 0 ? "\\" : "/";
    for (let step = 1; step < steps; step++) {
      const x = Math.round(a[0] + dx * step / steps);
      const y = Math.round(a[1] + dy * step / steps);
      if (cells[y]?.[x] !== undefined && (!faint || cells[y][x] === " ")) cells[y][x] = glyph;
    }
  };
  // Draw hidden edges first, leaving the silhouette crisp as the solid turns.
  for (let i = 0; i < 4; i++) line(outer[i], inner[i], true);
  for (const points of [outer, inner]) {
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) line(points[i], points[j], j === 3);
  }
  for (const [x, y] of [...outer, ...inner]) cells[y][x] = ascii ? "+" : "◇";
  return cells.map((row) => row.join(""));
}

/** A brief opening rotation, completed before the prompt owns the cursor. */
export async function writeIdentity(
  options: IdentityOptions,
  output: { write(text: string): unknown },
  motion: { enabled: boolean; size: () => { width: number; rows: number }; signal?: AbortSignal },
): Promise<void> {
  output.write(`${renderIdentity(options)}\n`);
  if (!motion.enabled || motion.signal?.aborted || options.width < 64 || options.rows < 24) return;
  const frames = 28;
  for (let frame = 1; frame <= frames; frame++) {
    await new Promise((resolve) => setTimeout(resolve, 18));
    if (motion.signal?.aborted) return;
    const size = motion.size();
    if (size.width !== options.width || size.rows !== options.rows) return;
    const progress = frame / frames;
    const eased = progress < 0.5
      ? 4 * progress * progress * progress
      : 1 - Math.pow(-2 * progress + 2, 3) / 2;
    const rendered = renderIdentity({ ...options, angle: frame === frames ? 0 : eased * Math.PI * 2 });
    output.write(`${BEGIN_SYNC}\x1b[11F${rendered.split("\n").map((line) => `\x1b[2K${line}`).join("\n")}\n${END_SYNC}`);
  }
}

/** Static, theme-aware identity. Metadata stays readable without delaying the prompt. */
export function renderIdentity(options: IdentityOptions): string {
  const { palette } = options;
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const width = Math.max(1, Math.floor(options.width));
  const ascii = glyphs.boxHorizontal === ASCII_GLYPHS.boxHorizontal;
  const mark = ascii ? "/\\" : "△";
  const text = [
    `ARCHYMEDES  ${options.version}`,
    "A place to think. The tools to build.",
    "",
    `${options.mode} ${glyphs.middot} ${options.workspace}`,
    options.model,
    `/help ${glyphs.middot} /guide ${glyphs.middot} /workspace`,
    "",
  ];
  const codes = [palette.primary + BOLD, palette.text, "", palette.secondary, palette.muted, palette.primary];
  const clean = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
  if (width < 64 || options.rows < 20) {
    const lines = [`${mark} ${text[0]}`, text[3], text[4]];
    return lines.map((line, index) => paint(clipTo(clean(line), width, glyphs), index === 0 ? codes[0] : palette.muted, palette.depth)).join("\n");
  }
  const geometry = renderGeometry(options.angle, ascii);
  const artWidth = Math.max(...geometry.map(visibleWidth));
  const gap = 3;
  const margin = 2;
  // The rainbow theme's one animated surface: the solid sweeps the colour wheel as it turns, the
  // spin itself driving the hue instead of a separate clock, so the two motions read as one thing.
  const rainbow = palette.theme === "rainbow";
  const phase = (options.angle ?? 0) / (Math.PI * 2);
  const paintDrawing = (drawing: string) => rainbow ? rainbowText(drawing, palette.depth, phase) : paint(drawing, palette.primary, palette.depth);
  return geometry.map((line, index) => {
    const drawing = line + " ".repeat(artWidth - visibleWidth(line));
    return " ".repeat(margin) + paintDrawing(drawing)
      + " ".repeat(gap) + paint(clipTo(clean(text[index] ?? ""), width - margin - artWidth - gap, glyphs), codes[index] ?? "", palette.depth);
  }).join("\n");
}
