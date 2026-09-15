/**
 * Micro-benchmarks for code that runs per keystroke, per streamed chunk or per redraw.
 *
 *   bun run bench:render
 *
 * Inputs are sized like a long real session: a 5,000-line tab log (the retention limit), 120-column
 * frames, and a markdown answer streamed a line at a time. Record before/after numbers in the tracker.
 */
import { renderMarkdownLine, newMarkdownState } from "../../packages/archymedes-cli/src/render/markdown";
import { highlightCode } from "../../packages/archymedes-cli/src/render/code-view";
import { transcriptRows } from "../../packages/archymedes-cli/src/terminal/transcript-rows";
import { LineLog } from "../../packages/archymedes-cli/src/terminal/output";
import { visibleWidth } from "../../packages/archymedes-cli/src/text/text-width";
import { buildPalette, findBuiltinTheme } from "../../packages/archymedes-cli/src/theme/theme";
import { UNICODE_GLYPHS } from "../../packages/archymedes-cli/src/text/glyphs";
import { frameText, WorkspaceFrame } from "../../packages/archymedes-cli/src/ui/workspace-frame";

const palette = buildPalette(findBuiltinTheme("archymedes")!, "truecolor");
const styled = (i: number) => `\x1b[38;2;231;187;120m  ${i.toString().padStart(4)} │\x1b[0m const value = await load("item-${i}"); // 界 emoji 👩‍💻 ${"x".repeat(i % 90)}`;
const logText = Array.from({ length: 5_000 }, (_, i) => styled(i)).join("\n");
const markdown = Array.from({ length: 400 }, (_, i) => i % 7 === 0 ? `## Section ${i}` : i % 5 === 0 ? `- item with \`code ${i}\` and **bold**` : `Plain prose line ${i} explaining what changed and why it matters for the reader.`);

type Result = { name: string; opsPerSec: number; msPerOp: number };
const results: Result[] = [];

function bench(name: string, fn: () => void, minMs = 1_000): void {
  for (let i = 0; i < 3; i++) fn();
  let ops = 0;
  const started = performance.now();
  while (performance.now() - started < minMs) { fn(); ops++; }
  const elapsed = performance.now() - started;
  results.push({ name, opsPerSec: (ops / elapsed) * 1_000, msPerOp: elapsed / ops });
}

bench("transcriptRows: 5,000-line log at 119 cols (history projection)", () => { transcriptRows(logText, 119); });
bench("visibleWidth: one styled 120-col line", () => { visibleWidth(styled(80)); }, 500);
bench("frameText: one styled line clipped to 119 cols", () => { frameText(styled(80), 119); }, 500);
bench("highlightCode: one code line", () => { highlightCode('const value = await load("item"); // comment', "truecolor", palette); }, 500);
bench("renderMarkdownLine: 400-line answer, streamed", () => {
  const state = newMarkdownState();
  for (const line of markdown) renderMarkdownLine(line, state, { width: 118, depth: "truecolor", glyphs: UNICODE_GLYPHS, palette });
});

{
  const stream = { columns: 120, rows: 40, write: () => true };
  const log = new LineLog();
  log.write(`${logText}\n`);
  const frame = new WorkspaceFrame(stream, () => ({ version: "bench", workspace: "w", model: "m", mode: "build", palette, glyphs: UNICODE_GLYPHS, busy: false }), () => log, { motion: false });
  frame.enter();
  log.write("retire intro\n");
  frame.scroll({ kind: "pageUp" });
  bench("WorkspaceFrame.scroll: one line up while reading 5,000-line history", () => {
    frame.scroll({ kind: "up", rows: 1 });
    frame.scroll({ kind: "down", rows: 1 });
  });
  bench("WorkspaceFrame.refresh: reading history while output arrives", () => {
    log.write("new line\n");
    frame.refresh();
  });
  frame.scroll({ kind: "live" });
  bench("WorkspaceFrame.refresh: live, 5,000-line log, output arriving", () => {
    log.write("new line\n");
    frame.refresh();
  });
  frame.exit();
}

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.msPerOp.toFixed(3).padStart(9)} ms/op  ${Math.round(r.opsPerSec).toLocaleString().padStart(10)} ops/s`);
