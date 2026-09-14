import { panel, type SectionStyle } from "./sections";

export type CompletionCardInput = {
  status: string;
  files: readonly string[];
  lineDelta?: { added: number; removed: number };
  checks: readonly { kind: string; passed: boolean }[];
  toolCalls: number;
  iterations: number;
  elapsed: string;
  cost: string;
};

const CHECK_LABELS: Record<string, string> = {
  tests: "tests",
  typecheck: "typecheck",
  lint: "lint",
  build: "build",
};

/** One compact, predictable handoff instead of several unrelated turn footers. */
export function renderCompletionCard(input: CompletionCardInput, style: SectionStyle): string {
  const mark = input.status === "completed" ? "completed" : input.status.replaceAll("_", " ");
  const files = input.files.length === 0
    ? "no files changed"
    : `${input.files.length} file${input.files.length === 1 ? "" : "s"} changed${input.lineDelta ? ` · +${input.lineDelta.added} −${input.lineDelta.removed}` : ""}`;
  const checks = input.checks.length === 0
    ? "not run"
    : input.checks.map((check) => `${CHECK_LABELS[check.kind] ?? check.kind} ${check.passed ? "passed" : "failed"}`).join(" · ");
  const work = `${input.iterations} model turn${input.iterations === 1 ? "" : "s"} · ${input.toolCalls} tool${input.toolCalls === 1 ? "" : "s"}`;
  const lines = [
    `status       ${mark}`,
    `files        ${files}`,
    `verification ${checks}`,
    `work         ${work}`,
    `time / cost  ${input.elapsed} · ${input.cost}`,
  ];
  if (input.files.length > 0 && input.files.length <= 4) lines.push(...input.files.map((file) => `             ${file}`));
  const failedCheck = input.checks.some((check) => !check.passed);
  const failed = input.status === "failed" || failedCheck;
  const verified = input.status === "completed" && input.checks.length > 0 && !failedCheck;
  const title = failed ? "needs attention"
    : input.status === "completed" ? "turn complete"
    : input.status === "needs_verification" ? "verification needed"
    : `turn ${mark}`;
  if (input.files.length > 0) lines.push("review       /diff · /undo");
  return panel(lines, style, { title, tone: failed ? "bad" : verified ? "good" : "warn" });
}
