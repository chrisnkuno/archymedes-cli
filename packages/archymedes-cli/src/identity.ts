import { BOLD, paint } from "./ansi";
import { clipTo } from "./chooser";
import { ASCII_GLYPHS, type GlyphSet, UNICODE_GLYPHS } from "./glyphs";
import { visibleWidth } from "./markdown";
import type { Palette } from "./theme";

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
    const ry = y * scale;
    return [Math.round(11 + rx * 9), Math.round(5 - (ry * 0.94 - rz * 0.34) * 4)];
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
  const frames = 12;
  for (let frame = 1; frame <= frames; frame++) {
    await new Promise((resolve) => setTimeout(resolve, 45));
    if (motion.signal?.aborted) return;
    const size = motion.size();
    if (size.width !== options.width || size.rows !== options.rows) return;
    const rendered = renderIdentity({ ...options, angle: Math.sin(frame / frames * Math.PI) * 0.65 });
    output.write(`\x1b[11F${rendered.split("\n").map((line) => `\x1b[2K${line}`).join("\n")}\n`);
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
  return geometry.map((line, index) => {
    const drawing = line + " ".repeat(artWidth - visibleWidth(line));
    return " ".repeat(margin) + paint(drawing, palette.primary, palette.depth)
      + " ".repeat(gap) + paint(clipTo(clean(text[index] ?? ""), width - margin - artWidth - gap, glyphs), codes[index] ?? "", palette.depth);
  }).join("\n");
}
