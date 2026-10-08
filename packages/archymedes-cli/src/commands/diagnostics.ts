import type { WorkspaceDiagnostics } from "@archymedes/core/lsp/collect";
import { renderDiagnostics } from "../render/diagnostics";
import type { GlyphSet } from "../text/glyphs";
import type { ColorDepth } from "../text/color-depth";

type Paint = (text: string) => string;

export type DiagnosticsContext = {
  /** Collects for the whole workspace, or only the files matching `include` when one is given. */
  collect(include?: string): Promise<WorkspaceDiagnostics>;
  write(text: string): void;
  paint: { dim: Paint; green: Paint; yellow: Paint; red: Paint; cyan: Paint };
  glyphs: GlyphSet;
  depth: ColorDepth;
  width: number;
};

/** `/diagnostics [glob]`. Reads what the installed language servers report; runs no model and changes nothing. */
export async function runDiagnosticsCommand(include: string | undefined, context: DiagnosticsContext): Promise<void> {
  const { paint, write } = context;
  write(paint.dim("  collecting language server diagnostics…\n"));
  try {
    write(renderDiagnostics(await context.collect(include), context));
  } catch (error) {
    write(paint.yellow(`  Could not collect diagnostics — ${error instanceof Error ? error.message : String(error)}\n`));
  }
}
