import type { ReadResult } from "@archymedes/core/cli/workspace";
import { fenceHeader, languageOf, renderCode, type RenderedBlock } from "../render/code-view";
import { IMAGE_PATH, renderImageView, type ImagePreference } from "../render/image-view";
import { renderMarkdown } from "../render/markdown";
import { note, rule, type SectionStyle } from "../render/sections";

export type CatContext = {
  readFile(path: string): Promise<ReadResult>;
  /** Raw bytes, when the workspace can provide them (local only); images need it. */
  readBytes?: (path: string) => Promise<{ path: string; bytes: Uint8Array }>;
  write(text: string): void;
  /** A one-line problem report, already styled by the caller. */
  warn(text: string): void;
  writeFoldable(label: string, block: RenderedBlock): void;
  style: SectionStyle;
  width: number;
  foldAfterLines: number;
  images: ImagePreference;
  /** Rows an image may use; the transcript should still show the prompt afterwards. */
  imageRows: number;
  /** Called with each Kitty image placed, so `/clear` can remove it. */
  onKittyImage(id: number): void;
  nextImageId(): number;
};

/**
 * `/cat <path>`: a file printed into the transcript. Markdown is prose meant to be read, so it is
 * rendered whole; images are drawn; everything else gets the numbered, folded code view, because a
 * 3,000-line log dumped whole would push the prompt that asked for it off the screen.
 */
export async function runCat(target: string, context: CatContext): Promise<void> {
  if (!target) { context.warn("Usage: /cat <path>"); return; }
  const style = context.style;
  try {
    if (IMAGE_PATH.test(target)) {
      if (!context.readBytes) { context.warn(`"${target}" is an image; images can be shown from a local workspace only`); return; }
      const { path, bytes } = await context.readBytes(target);
      const id = context.nextImageId();
      const view = renderImageView(bytes, { columns: context.width, maxRows: context.imageRows, depth: style.depth, preference: context.images, id });
      if (view.kind === "unsupported") { context.warn(`Could not show "${target}": ${view.reason}`); return; }
      context.write(`${rule(style, { label: path, tone: "accent", trailing: `${view.width}×${view.height}` })}\n`);
      context.write(view.output);
      if (view.mode === "kitty") context.onKittyImage(id);
      if (context.images.hint) context.write(`${note(context.images.hint, style)}\n`);
      return;
    }
    const file = await context.readFile(target);
    context.write(`${rule(style, { label: target, tone: "accent" })}\n`);
    if (/\.(md|markdown)$/i.test(target)) {
      context.write(`${renderMarkdown(file.content, { width: context.width, depth: style.depth, glyphs: style.glyphs, palette: style.palette })}\n`);
    } else {
      const language = languageOf(target);
      context.write(`${fenceHeader(language, style)}\n`);
      context.writeFoldable(target, renderCode(file.content, style, { maxLines: context.foldAfterLines, language }));
    }
    if (file.truncated) context.write(`${note(`… ${file.totalLines} lines total, longer than a session cares to hold at once`, style)}\n`);
  } catch (error) {
    context.warn(`Could not read "${target}": ${error instanceof Error ? error.message : String(error)}`);
  }
}
