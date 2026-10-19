import type { ColorDepth } from "../text/color-depth";
import { UNICODE_GLYPHS, type GlyphSet } from "../text/glyphs";
import { visibleWidth } from "../text/text-width";
import { padToWidth, progressBar, sliceToWidth } from "./tui";
import { BrailleCanvas, dotRowFor, seriesBounds } from "./canvas";
import type { Rgb } from "../theme/theme";

/**
 * Charts, in the terminal — Archymedes's answer to ntcharts.
 *
 * Everything here returns an array of finished lines and writes to nothing, the same contract the
 * full-screen surfaces are built on: a chart is a fixed-size block of text, so it can be printed
 * into the transcript, dropped into a `box()`, or painted onto reserved rows without any of those
 * callers knowing how it was drawn.
 *
 * The size is always an *input*. Nothing here grows a chart to fit its data — it fits the data to
 * the space it was given, because a block whose height depends on its contents is exactly the thing
 * that cannot be safely redrawn in place.
 */

/** One labelled measurement in a bar chart. */
export type BarDatum = { label: string; value: number };

export type BarChartOptions = {
  /** Total columns the chart may occupy, labels and value column included. */
  width: number;
  depth: ColorDepth;
  glyphs?: GlyphSet;
  /** How a value is written beside its bar. Defaults to a rounded number. */
  format?: (value: number) => string;
  /** Gradient ends for the bars, as `progressBar` takes them. */
  from?: Rgb;
  to?: Rgb;
  /** Ceiling for the bars. Defaults to the largest value present. */
  max?: number;
};

/**
 * A horizontal bar per row: label, bar, value.
 *
 * Horizontal rather than vertical because the labels are words. A vertical chart has one column per
 * bar and nowhere to write "read_file" except sideways, which is why every terminal tool that
 * charts named things — `du`, `duf`, GitHub's language bars — draws them lying down.
 *
 * Bars are drawn by `progressBar`, so they inherit its gradient, its eighth-of-a-cell precision and
 * its ASCII fallback rather than growing a second, worse implementation of all three.
 */
export function barChart(data: readonly BarDatum[], options: BarChartOptions): string[] {
  if (data.length === 0) return [];
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const format = options.format ?? ((value: number) => `${Math.round(value)}`);
  const width = Math.max(20, Math.floor(options.width));

  const labels = data.map((datum) => datum.label);
  const values = data.map((datum) => format(datum.value));
  // Both side columns are sized to their own widest entry, then the bar takes whatever is left —
  // the same "clip the thing with room to lose" rule `table()` follows.
  const labelWidth = Math.min(Math.max(...labels.map(visibleWidth)), Math.floor(width * 0.35));
  const valueWidth = Math.min(Math.max(...values.map(visibleWidth)), Math.floor(width * 0.2));
  // Two single-space separators, one either side of the bar — so the row comes to exactly
  // `labelWidth + 1 + barWidth + 1 + valueWidth`.
  const barWidth = Math.max(1, width - labelWidth - valueWidth - 2);

  const ceiling = options.max ?? Math.max(...data.map((datum) => datum.value));
  return data.map((datum, index) => {
    // A ceiling of zero means every value is zero; an empty track is the honest picture, and it
    // also keeps the division below defined.
    const fraction = ceiling > 0 ? datum.value / ceiling : 0;
    const bar = progressBar(fraction, barWidth, {
      depth: options.depth,
      glyphs,
      ...(options.from === undefined ? {} : { from: options.from }),
      ...(options.to === undefined ? {} : { to: options.to }),
    });
    // The value column is right-aligned: a column of figures is read by comparing them down its
    // length, and left-aligning puts the digit that means "hundreds" in a different place on every
    // row, which is exactly what makes a table of numbers unreadable.
    return `${padToWidth(sliceToWidth(labels[index], labelWidth), labelWidth)} ${bar} ${padToWidth(values[index], valueWidth, "right")}`;
  });
}

/**
 * Braille dot bits, by column then row — the 2x4 grid one braille cell addresses.
 *
 * The ordering is not sequential and cannot be computed: Unicode numbered dots 1-6 first, for the
 * original six-dot alphabet, then bolted 7 and 8 onto the bottom row when eight-dot braille arrived.
 * So the low bits run down the first three rows and the fourth row lives up at 0x40/0x80.
 */
export type LineChartOptions = {
  width: number;
  height: number;
  depth: ColorDepth;
  glyphs?: GlyphSet;
  /** Written at the top and bottom of the y axis. Defaults to the rounded bounds of the series. */
  format?: (value: number) => string;
  /** Drop the y-axis labels and gutter, for a caller that has its own. */
  bare?: boolean;
};

/**
 * An XY line plot, drawn with braille so one character cell carries a 2x4 grid of points.
 *
 * That resolution is the whole reason to use braille: a block-character plot has one point per
 * cell, so a 40x8 chart holds 320 positions, where the same cells in braille hold 2,560 — enough
 * that a latency series reads as a *curve* rather than as a staircase. ntcharts reaches for the
 * same trick — its `BrailleGrid` (canvas/graph) scales a plot to the "4 high and 2 wide" dot grid
 * a braille rune addresses, then draws the finished patterns onto its ordinary one-rune-per-cell
 * canvas, which is exactly the two-layer arrangement below.
 *
 * A terminal that cannot draw braille gets a coarse one-point-per-cell plot instead, which is worse
 * but is a chart; braille rendered as question marks is not.
 */
export function lineChart(values: readonly number[], options: LineChartOptions): string[] {
  return plotSeries([{ values }], options);
}

/** One named series in a multi-line plot. */
export type Series = { values: readonly number[]; label?: string };

/**
 * Several series on one pair of axes, scaled together.
 *
 * Together, deliberately: two series drawn to their own bounds look comparable and are not, which
 * is the single most misleading thing a small chart can do. A caller that genuinely wants
 * independent scales is asking for two charts, and should draw two.
 *
 * Braille cannot carry per-series colour inside a shared cell — one rune is one colour, and two
 * series crossing in the same cell would have to pick a winner. So this stays monochrome and the
 * separation comes from shape, which is also what survives a colour-blind reader and a `NO_COLOR`
 * terminal.
 */
export function plotSeries(series: readonly Series[], options: LineChartOptions): string[] {
  const glyphs = options.glyphs ?? UNICODE_GLYPHS;
  const height = Math.max(1, Math.floor(options.height));
  const format = options.format ?? ((value: number) => `${Math.round(value)}`);
  const all = series.flatMap((entry) => entry.values.filter((value) => Number.isFinite(value)));
  if (all.length === 0) return Array.from({ length: height }, () => "");

  const { low, high, span } = seriesBounds(all);
  const gutter = options.bare ? 0 : Math.max(visibleWidth(format(high)), visibleWidth(format(low))) + 1;
  const plotWidth = Math.max(1, Math.floor(options.width) - gutter);
  const canvas = new BrailleCanvas({ columns: plotWidth, rows: height, glyphs });

  for (const entry of series) {
    const finite = entry.values.filter((value) => Number.isFinite(value));
    if (finite.length === 0) continue;
    let previous: { x: number; y: number } | undefined;
    // Column x samples the series at the position it represents, so a series longer than the chart
    // is decimated and one shorter is held — either way the plot spans the full width instead of
    // stopping short or running off the end.
    for (let x = 0; x < canvas.width; x += 1) {
      const position = canvas.width === 1 ? 0 : (x / (canvas.width - 1)) * (finite.length - 1);
      const left = Math.floor(position);
      const right = Math.min(finite.length - 1, left + 1);
      const value = finite[left] + (finite[right] - finite[left]) * (position - left);
      const y = dotRowFor(value, low, span, canvas.height);
      // Joined to the previous sample rather than dotted: a series that climbs faster than one dot
      // per column is otherwise drawn as a dashed line that reads as missing data.
      if (previous) canvas.line(previous.x, previous.y, x, y);
      else canvas.set(x, y);
      previous = { x, y };
    }
  }

  return canvas.render().map((drawn, index) => {
    if (options.bare) return drawn;
    // Only the bounds are labelled. A terminal chart this small has no room for a tick every row,
    // and the two numbers that answer "how big does this get" are the top and the bottom.
    const label = index === 0 ? format(high) : index === height - 1 ? format(low) : "";
    return `${padToWidth(label, gutter - 1)} ${drawn}`;
  });
}
