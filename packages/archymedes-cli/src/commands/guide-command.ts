import { expandHint } from "../render/expandable";
import { findTopic, renderGuideIndex, renderGuideTopic, renderWholeGuide, searchTopics, type GuideCommand } from "../render/guide";
import { GUTTER, heading, type SectionStyle } from "../render/sections";
import type { ColorDepth } from "../text/color-depth";
import type { GlyphSet } from "../text/glyphs";

type Paint = (text: string) => string;

export type GuideCommandContext = {
  /** Opens the guide as a full screen; false when this terminal cannot draw one. */
  openScreen(): Promise<boolean>;
  /** Stores folded text for `/expand` and returns its handle. */
  fold(label: string, text: string, hiddenLines: number): number;
  foldAfterLines: number;
  write(text: string): void;
  paint: { dim: Paint; yellow: Paint; cyan: Paint };
  style: SectionStyle;
  glyphs: GlyphSet;
  depth: ColorDepth;
};

/**
 * `/guide [topic | search <text> | all]`. A bare `/guide` is a browsing job, so it opens the screen
 * (printing the index where a screen cannot be drawn). A named topic prints, so it can be scrolled
 * back to and copied; the whole guide prints folded, because it is longer than a screen.
 */
export async function runGuideCommand(command: GuideCommand, context: GuideCommandContext): Promise<void> {
  const { style, paint, write, glyphs } = context;
  switch (command.kind) {
    case "index":
      if (!(await context.openScreen())) write(`${renderGuideIndex(style)}\n`);
      return;
    case "all": {
      const whole = renderWholeGuide(style);
      const lines = whole.split("\n");
      const shown = context.foldAfterLines * 3;
      write(`${lines.slice(0, shown).join("\n")}\n`);
      const hidden = Math.max(0, lines.length - shown);
      if (hidden > 0) write(`${GUTTER}${expandHint(context.fold("guide", whole, hidden), hidden, context.depth, glyphs)}\n`);
      return;
    }
    case "search": {
      const found = searchTopics(command.query);
      if (found.length === 0) { write(paint.yellow(`  Nothing in the guide mentions "${command.query}".\n`)); return; }
      write(`${heading(`guide ${glyphs.middot} "${command.query}"`, 2, style)}\n`);
      for (const topic of found) write(`${GUTTER}${paint.cyan(topic.id)}  ${paint.dim(topic.summary)}\n`);
      return;
    }
    case "unknown":
      write(paint.yellow(`  No guide topic called "${command.id}".\n`));
      write(paint.dim("  /guide lists them · /guide search <text> finds one\n"));
      return;
    case "topic": {
      const topic = findTopic(command.id);
      if (topic) write(`${renderGuideTopic(topic, style)}\n`);
      return;
    }
  }
}
