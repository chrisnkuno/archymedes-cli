/**
 * Micro-benchmarks for code that runs per streamed chunk: the agent's human-readable output.
 *
 *   bun run bench:render
 *
 * Inputs are sized like a long real session: 120-column lines and a markdown answer streamed a line
 * at a time. Record before/after numbers in the tracker.
 */
import { renderMarkdownLine, newMarkdownState } from "../../packages/friday-cli/src/render/markdown";
import { highlightCode } from "../../packages/friday-cli/src/render/code-view";
import { visibleWidth } from "../../packages/friday-cli/src/text/text-width";
import { buildPalette, findBuiltinTheme } from "../../packages/friday-cli/src/theme/theme";
import { UNICODE_GLYPHS } from "../../packages/friday-cli/src/text/glyphs";

const palette = buildPalette(findBuiltinTheme("archymedes")!, "truecolor");
const styled = (i: number) => `\x1b[38;2;231;187;120m  ${i.toString().padStart(4)} │\x1b[0m const value = await load("item-${i}"); // 界 emoji 👩‍💻 ${"x".repeat(i % 90)}`;
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

bench("visibleWidth: one styled 120-col line", () => { visibleWidth(styled(80)); }, 500);
bench("highlightCode: one code line", () => { highlightCode('const value = await load("item"); // comment', "truecolor", palette); }, 500);
bench("renderMarkdownLine: 400-line answer, streamed", () => {
  const state = newMarkdownState();
  for (const line of markdown) renderMarkdownLine(line, state, { width: 118, depth: "truecolor", glyphs: UNICODE_GLYPHS, palette });
});

const width = Math.max(...results.map((r) => r.name.length));
for (const r of results) console.log(`${r.name.padEnd(width)}  ${r.msPerOp.toFixed(3).padStart(9)} ms/op  ${Math.round(r.opsPerSec).toLocaleString().padStart(10)} ops/s`);
