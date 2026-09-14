import type { WheelInputSource } from "../terminal/wheel-input";
import type { WorkspaceFrameOptions } from "./workspace-frame";

export type LayoutName = "fixed" | "scrollback";
type Environment = Record<string, string | undefined>;

/** `--pin` or `ARCHYMEDES_PIN` (any value but empty or 0): hold a footer over the scrollback log. */
export function wantsPinnedFooter(pin: boolean | undefined, environment: Environment): boolean {
  return Boolean(pin) || ((environment.ARCHYMEDES_PIN ?? "") !== "" && environment.ARCHYMEDES_PIN !== "0");
}

/**
 * Which terminal layout a session starts in: the fixed workspace unless `--layout`/`ARCHYMEDES_LAYOUT`
 * asks for scrollback, a pinned footer is requested (a scrollback feature), or the terminal cannot
 * address the cursor. An explicit `--layout` always wins.
 */
export function resolveLayout(args: { layout?: LayoutName; pin?: boolean }, environment: Environment): LayoutName {
  if (args.layout) return args.layout;
  if (environment.TERM === "dumb" || wantsPinnedFooter(args.pin, environment)) return "scrollback";
  return environment.ARCHYMEDES_LAYOUT?.trim().toLowerCase() === "scrollback" ? "scrollback" : "fixed";
}

/** Motion follows the usual opt-outs; wheel scrolling costs plain drag-to-select, so `ARCHYMEDES_MOUSE=0` keeps the terminal's. */
export function workspaceFrameOptions(environment: Environment, input: WheelInputSource): WorkspaceFrameOptions {
  return {
    motion: environment.ARCHYMEDES_NO_MOTION !== "1" && environment.NO_COLOR === undefined && environment.TERM !== "dumb",
    input: environment.ARCHYMEDES_MOUSE === "0" ? undefined : input,
  };
}

/** `/layout [fixed|scrollback]`; a bare `/layout` toggles away from `current`. Null for any other input. */
export function parseLayoutCommand(input: string, current: LayoutName): { layout: LayoutName } | { error: string } | null {
  if (input !== "/layout" && !input.startsWith("/layout ")) return null;
  const choice = input.slice("/layout".length).trim();
  if (!choice) return { layout: current === "fixed" ? "scrollback" : "fixed" };
  return choice === "fixed" || choice === "scrollback" ? { layout: choice } : { error: "  Use /layout fixed or /layout scrollback.\n" };
}

export function layoutNotice(layout: LayoutName): string {
  return layout === "fixed"
    ? "  Fixed workspace — mode rail and composer stay put. PgUp or the wheel reads history; /layout scrollback returns to the log.\n"
    : "  Scrollback layout — the terminal keeps a normal log. /layout fixed restores the workspace.\n";
}
