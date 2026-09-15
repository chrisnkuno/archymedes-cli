import { GUTTER, heading, note, rule, type SectionStyle } from "../render/sections";
import { replayLines } from "../terminal/output";
import type { WatchRegistry } from "../terminal/job-stream";
import type { GlyphSet } from "../text/glyphs";

type Paint = (text: string) => string;

export type WatchCommandContext = {
  watched: Pick<WatchRegistry, "size" | "all" | "get" | "stop" | "stopAll">;
  getJob(id: string): Promise<{ objective: string } | undefined | null>;
  startWatching(id: string, objective: string): Promise<unknown>;
  write(text: string): void;
  paint: { dim: Paint; yellow: Paint; cyan: Paint };
  style: SectionStyle;
  glyphs: GlyphSet;
};

/** `/watch [<id> | show <id> | stop <id|all>]`: stream a background job into the session without taking the prompt. */
export async function runWatchCommand(argument: string, context: WatchCommandContext): Promise<void> {
  const { watched, paint, write, style, glyphs } = context;
  const rest = argument.trim().replace(/\s+/g, " ");
  if (!rest) {
    if (watched.size === 0) { write(paint.dim("  watching nothing — /watch <job id>, or /jobs to see what exists\n")); return; }
    write(`${heading("watching", 2, style)}\n`);
    for (const job of watched.all) {
      const status = job.stream.done ? job.stream.status : "live";
      write(`${GUTTER}${paint.cyan(job.stream.id)} ${paint.dim(`${status} ${glyphs.middot} ${job.sink.log.size} lines`)}  ${job.objective}\n`);
    }
    write(`${note("/watch show <id> to read it · /watch stop <id> to stop", style)}\n`);
    return;
  }
  const [verb, ...words] = rest.split(" ");
  const target = words.join(" ").trim();
  if (verb === "stop") {
    if (target === "all") { watched.stopAll(); write(paint.dim("  stopped watching everything\n")); return; }
    write(watched.stop(target) ? paint.dim(`  stopped watching ${target}\n`) : paint.yellow(`  not watching ${target}\n`));
    return;
  }
  if (verb === "show") {
    const job = watched.get(target);
    if (!job) { write(paint.yellow(`  not watching ${target}\n`)); return; }
    // What the stream has received, which is the thing being asked about, not a fresh read of the log.
    const replay = replayLines(job.sink.log, 200);
    write(`${rule(style, { label: `job ${target}`, tone: "accent", ...(replay.omitted > 0 ? { trailing: `${replay.omitted} earlier lines` } : {}) })}\n`);
    if (replay.lines.length === 0) write(`${note("nothing yet", style)}\n`);
    for (const line of replay.lines) write(`${line}\n`);
    return;
  }
  const job = await context.getJob(verb);
  if (!job) { write(paint.yellow(`  No job ${verb}. /jobs lists what exists.\n`)); return; }
  await context.startWatching(verb, job.objective);
  write(paint.dim(`  watching ${verb} — it keeps running while you work; /watch show ${verb} to read it\n`));
}
