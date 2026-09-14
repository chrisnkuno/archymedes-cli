import { detectColorDepth } from "../../packages/archymedes-cli/src/text/color-depth";
import { renderCompletionCard } from "../../packages/archymedes-cli/src/render/completion-card";
import { ASCII_GLYPHS, UNICODE_GLYPHS } from "../../packages/archymedes-cli/src/text/glyphs";
import { writeIdentity } from "../../packages/archymedes-cli/src/render/identity";
import { buildPalette, DEFAULT_THEME_NAME, findBuiltinTheme } from "../../packages/archymedes-cli/src/theme/theme";
import { renderPromptBox } from "../../packages/archymedes-cli/src/render/tui";

// Offline preview with synthetic data: no configuration, tools, or model requests.
const themeName = process.argv[2] ?? DEFAULT_THEME_NAME;
const theme = findBuiltinTheme(themeName);
if (!theme) throw new Error(`Unknown theme: ${themeName}`);
const depth = detectColorDepth(process.env, Boolean(process.stdout.isTTY));
const palette = buildPalette(theme, depth);
const glyphs = process.argv.includes("--ascii") ? ASCII_GLYPHS : UNICODE_GLYPHS;
const width = process.stdout.columns ?? 80;
await writeIdentity({ width, rows: process.stdout.rows ?? 24, palette, glyphs, version: "preview", workspace: "example-project", model: "Your selected provider / model", mode: "build" }, process.stdout, { enabled: process.argv.includes("--animate") && Boolean(process.stdout.isTTY), size: () => ({ width: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }) });
console.log("\n  Preview: an example change and its verification.\n");
console.log(renderCompletionCard({ status: "completed", files: ["src/parser.ts"], lineDelta: { added: 12, removed: 3 }, checks: [{ kind: "tests", passed: true }], iterations: 2, toolCalls: 4, elapsed: "8s", cost: "$0.012" }, { width, depth, palette, glyphs }));
const prompt = renderPromptBox({ mode: "build", workspace: "example-project", width, depth, palette, glyphs });
console.log(`\n${prompt.top}\n${prompt.prefix}\n${prompt.bottom}`);
