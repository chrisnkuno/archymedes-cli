import { spawn } from "node:child_process";
import { transcriptText } from "../terminal/fixed-layout";
import { openInPager, type PagerSpawn } from "../terminal/fixed-screen";
import { sanitizeTranscript } from "../terminal/transcript-rows";

/** Runs the pager with the transcript on its stdin, and the terminal as its display. */
export const spawnPager: PagerSpawn = (command, args, input) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"] });
  child.on("error", reject);
  child.on("close", (code) => resolve(code ?? 0));
  // Quitting the pager before it has read everything closes the pipe; that is not a failure.
  child.stdin.on("error", () => undefined);
  child.stdin.end(input);
});

/**
 * `/pager`: the active tab's retained transcript in `$PAGER` (default `less -R`), where the
 * terminal's own search, selection and saving work. Colour survives; cursor movement does not,
 * because a pager would print it as noise.
 */
export async function runPager(
  log: { lines: readonly string[]; pending: string; dropped: number },
  environment: Record<string, string | undefined>,
  spawnFn: PagerSpawn = spawnPager,
  options: {
    /** The built-in pager. Used on Windows when no `$PAGER` is set, and whenever `less` will not start. */
    internal?: (text: string) => Promise<void>;
    platform?: string;
  } = {},
): Promise<{ opened: boolean; reason?: string; internal?: boolean }> {
  const buffer = [...log.lines, ...(log.pending ? [log.pending] : [])];
  const text = sanitizeTranscript(transcriptText({ buffer, dropped: log.dropped }));
  const configured = Boolean(environment.PAGER?.trim());
  // Windows ships no `less`; asking for one there is a failure the user then has to read about.
  if (options.internal && !configured && (options.platform ?? process.platform) === "win32") {
    await options.internal(text);
    return { opened: true, internal: true };
  }
  const result = await openInPager(text, { environment, spawn: spawnFn });
  // `less` missing elsewhere: same fallback, rather than an error in place of the transcript.
  if (!result.opened && options.internal && !configured && /^Could not run /.test(result.reason ?? "")) {
    await options.internal(text);
    return { opened: true, internal: true };
  }
  return result;
}
