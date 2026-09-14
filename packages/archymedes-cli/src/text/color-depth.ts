export type ColorDepth = "truecolor" | "ansi256" | "none";

/** What the terminal can actually render, from the environment rather than from hope. */
export function detectColorDepth(environment: Record<string, string | undefined>, isTTY: boolean): ColorDepth {
  if (!isTTY || environment.NO_COLOR !== undefined || environment.TERM === "dumb") return "none";
  if (environment.COLORTERM === "truecolor" || environment.COLORTERM === "24bit") return "truecolor";
  return "ansi256";
}
