import { note, type SectionStyle } from "../render/sections";
import type { GlyphSet } from "../text/glyphs";
import { addMemory, clearMemories, describeAdded, forgetMemory, loadMemories, memoryFile, memoryPromptBlock, recallMemories, renderMemories, replaceMemory, type MemoryCommand, type MemoryEntry } from "./memory";

type Paint = (text: string) => string;

export type MemoryCommandContext = {
  root: string;
  environment: Record<string, string | undefined>;
  memories: readonly MemoryEntry[];
  /** Receives the reloaded memories after any change. */
  setMemories(entries: MemoryEntry[]): void;
  /** Asks a yes/no question; true only for an explicit yes. */
  confirm(question: string): Promise<boolean>;
  write(text: string): void;
  paint: { dim: Paint; yellow: Paint; green: Paint };
  style: SectionStyle;
  glyphs: GlyphSet;
};

/** `/memory [add|replace|recall|forget|clear|where]`: bounded facts carried between sessions. */
export async function runMemoryCommand(command: MemoryCommand, context: MemoryCommandContext): Promise<void> {
  const { root, environment, paint, write, style, glyphs } = context;
  const files = { project: memoryFile("project", root, environment), user: memoryFile("user", root, environment) };
  const reload = async () => context.setMemories(await loadMemories(root, environment));
  try {
    switch (command.kind) {
      case "invalid":
        write(paint.yellow(`  ${command.reason}\n`));
        return;
      case "where":
        write(`${note(`project ${glyphs.middot} ${files.project}`, style)}\n${note(`you     ${glyphs.middot} ${files.user}`, style)}\n`);
        return;
      case "list":
        write(`${renderMemories(context.memories as MemoryEntry[], style, files)}\n`);
        return;
      case "add": {
        const result = await addMemory(command.scope, command.text, root, environment, { kind: command.memoryKind, pinned: command.pinned });
        await reload();
        write(result.changed ? `${describeAdded({ scope: command.scope, text: command.text }, style)}\n` : paint.dim("  already remembered\n"));
        return;
      }
      case "replace":
        await replaceMemory(command.scope, command.oldText, command.newText, root, environment);
        await reload();
        write(paint.green(`  memory updated: ${command.newText}\n`));
        return;
      case "recall": {
        const recalled = recallMemories(context.memories as MemoryEntry[], command.query);
        write(recalled.entries.length
          ? `${memoryPromptBlock(recalled.entries)}${paint.dim(`  ${recalled.usedChars} chars recalled${recalled.omitted ? ` ${glyphs.middot} ${recalled.omitted} omitted by budget` : ""}\n`)}`
          : paint.dim(`  no memory matched “${command.query}”\n`));
        return;
      }
      case "forget": {
        const result = await forgetMemory(command.scope, command.index, root, environment);
        await reload();
        write(result.removed
          ? paint.green(`  forgot: ${result.removed.text}\n`)
          : paint.yellow(`  there is no ${command.scope} memory ${command.index} — /memory lists them\n`));
        return;
      }
      case "clear":
        if (!(await context.confirm(`Forget every ${command.scope} memory?`))) { write(paint.dim("  kept\n")); return; }
        await clearMemories(command.scope, root, environment);
        await reload();
        write(paint.dim(`  ${command.scope} memory cleared\n`));
        return;
    }
  } catch (error) {
    write(paint.yellow(`  ${error instanceof Error ? error.message : String(error)}\n`));
  }
}
