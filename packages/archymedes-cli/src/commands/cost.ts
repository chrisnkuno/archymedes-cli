import type { TurnCost } from "@archymedes/core/cli/cost";
import { convertTo, formatMoney, type Currency, type FxRate } from "@archymedes/core/money";
import { barChart, lineChart } from "../render/charts";
import { progressBar, ReplaceableBlock, SpringAnimator } from "../render/tui";
import type { OutputStream } from "../terminal/output";
import type { ColorDepth } from "../text/color-depth";
import type { GlyphSet } from "../text/glyphs";
import { parseColor, type Palette, type Rgb } from "../theme/theme";
import { INITIAL_TABLE_STATE, renderTable, type TablePaint } from "../ui/table";
import { buildCostTable } from "../ui/tables";

export type CostReportContext = {
  /** The ledger's own totals report. */
  report: string;
  history: readonly TurnCost[];
  display: Currency;
  rates: readonly FxRate[];
  paint: TablePaint;
  glyphs: GlyphSet;
  depth: ColorDepth;
  width: number;
};

/**
 * `/cost`: the totals, then the turns as a table, spend per turn as bars (the last dozen, since a
 * chart taller than a screen is not a chart) and tokens per second once there are enough turns for
 * its shape to mean anything.
 */
export function renderCostReport(context: CostReportContext): string {
  const { history, paint, glyphs, depth } = context;
  const width = Math.min(72, context.width);
  const lines = [context.report];
  if (history.length > 1) {
    const spend = buildCostTable(history, {
      money: (cost) => (cost ? formatMoney(convertTo(cost, context.display, context.rates as FxRate[]) ?? cost) : ""),
      paint,
    });
    lines.push(renderTable(spend.columns, spend.rows, INITIAL_TABLE_STATE, { paint, width: context.width, glyphs, legend: "", cursor: false }));
    const recent = history.slice(-12);
    const currency = recent.find((turn) => turn.cost)?.cost?.currency ?? "USD";
    lines.push(paint.dim(`  spend per turn${history.length > recent.length ? ` (last ${recent.length} of ${history.length})` : ""}`));
    for (const line of barChart(
      recent.map((turn) => ({ label: `turn ${turn.turnNumber}`, value: turn.cost?.micros ?? 0 })),
      { width, depth, glyphs, format: (value) => formatMoney({ micros: value, currency }) },
    )) lines.push(`  ${line}`);
  }
  const throughput = history.filter((turn) => turn.elapsedMs > 0).map((turn) => (turn.usage.totalTokens / turn.elapsedMs) * 1_000);
  if (throughput.length > 2) {
    lines.push(paint.dim("\n  tokens/sec per turn"));
    for (const line of lineChart(throughput, { width, height: 5, depth, glyphs })) lines.push(`  ${paint.dim(line)}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * The budget meter, easing from empty to where spend actually is. The gradient runs the theme's
 * success colour toward its error colour, so a nearly spent budget shows almost the whole run toward
 * the warning end without a separate threshold. Named ANSI colours are not RGB and fall back to the
 * bar's own default.
 */
export function animateBudgetMeter(fraction: number, context: { out: OutputStream; palette: Palette; depth: ColorDepth; glyphs: GlyphSet; dim(text: string): string }): Promise<void> {
  const rgb = (value: string): Rgb | undefined => {
    const parsed = parseColor(value);
    return typeof parsed === "object" ? parsed : undefined;
  };
  const from = rgb(context.palette.tokens.success);
  const to = rgb(context.palette.tokens.error);
  const meterLine = (value: number) => `  ${context.dim("budget")} [${progressBar(value, 24, { depth: context.depth, glyphs: context.glyphs, from, to })}] ${context.dim(`${Math.round(Math.min(1, value) * 100)}%`)}`;
  const meter = new ReplaceableBlock(context.out);
  const handle = meter.append(meterLine(0));
  return new Promise<void>((resolve) => {
    const animator: SpringAnimator = new SpringAnimator(0, (value) => {
      meter.update(handle, meterLine(value));
      if (animator.settled) resolve();
    });
    animator.retarget(fraction);
  });
}
