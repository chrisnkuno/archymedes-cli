import { promises as fs } from "node:fs";
import { DEFAULT_WORKSPACE_LIMITS, displayPath, realPathWithin, WorkspaceViolation, type WorkspaceLimits } from "../workspace";
import type { SymbolIndex } from "./symbols";

/**
 * What the extra tools need: a local directory. They read the disk directly (and run `git`), so
 * they are only offered for a local workspace — the same "only real capabilities get a tool" rule
 * tools.ts follows for search and delegation.
 */
export type ExtraToolOptions = {
  /** Absolute workspace root. Every path argument is confined to it. */
  root: string;
  limits?: WorkspaceLimits;
  /** Ceiling for one git invocation. Default 10 s. */
  gitTimeoutMs?: number;
  /** `rg` binary for find_symbol references; `null` forces the JS search, undefined looks it up. */
  ripgrep?: string | null;
  /** Shared, session-scoped symbol cache. Created when absent. */
  symbolIndex?: SymbolIndex;
};

export function resolvedLimits(options: ExtraToolOptions): WorkspaceLimits {
  return options.limits ?? DEFAULT_WORKSPACE_LIMITS;
}

export function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value;
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be a string`);
  return value.trim() ? value : undefined;
}

/** A bounded integer: absent → fallback, otherwise clamped into [min, max]. */
export function boundedInteger(value: unknown, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value)) throw new Error(`${name} must be an integer`);
  return Math.max(min, Math.min(max, value as number));
}

export function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T): T {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !allowed.includes(value as T)) throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
  return value as T;
}

/**
 * A workspace-relative directory prefix ("" for the root), confined to the root (symlinks
 * included) and required to exist as a directory.
 */
export async function directoryPrefix(root: string, candidate: string | undefined): Promise<string> {
  if (!candidate || candidate === "." || candidate === "./") return "";
  const absolute = await realPathWithin(root, candidate);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat) throw new WorkspaceViolation(`${displayPath(root, absolute)} does not exist`);
  if (!stat.isDirectory()) throw new WorkspaceViolation(`${displayPath(root, absolute)} is not a directory`);
  const relative = displayPath(root, absolute);
  return relative === "." ? "" : relative;
}

/** Cuts `text` to `maxChars`, at a line boundary when one is close, and says so. */
export function truncateText(text: string, maxChars: number, hint: string): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  let cut = text.slice(0, maxChars);
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > maxChars * 0.8) cut = cut.slice(0, lastNewline);
  return { text: `${cut}\n[truncated: showed ${cut.length} of ${text.length} chars. ${hint}]`, truncated: true };
}
