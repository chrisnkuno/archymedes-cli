import type { ToolEffect, VerificationEvidence, VerificationKind } from "./agent-runtime";

/**
 * What a run must show before it may call workspace changes done, and, when building test first,
 * the order it showed them in.
 *
 * The runtime asks this at two moments: after every tool result (`record`), and when the model
 * says it has finished (`beforeFinish`). Every request it makes of the model is asked at most once,
 * because each one has an honest "no" (nothing to assert, no checker in this project), and a gate
 * that cannot be satisfied honestly is a gate that gets worked around.
 *
 * Test first (on by default while building; `ARCHYMEDES_TEST_FIRST=off`) is the order Friday works
 * in: tests that define done (invariants, behaviour, one functional test of the assembled thing),
 * seen failing; then the code that makes them pass; then light static analysis. What the gate can
 * see is which files changed and which commands passed or failed, so that is what it holds the
 * run to: a test file written for a code change, tests passing after the last code edit, and a
 * static check passing after it too.
 */

/** Evidence strength as a ladder; see `VerificationKind` in agent-runtime.ts for each rung. */
export const EVIDENCE_RANK: Record<VerificationKind, number> = { check: 1, tests: 2, smoke: 3, behavior: 4 };

/** Where a test-first run is, for an interface to show. */
export type TestFirstState = {
  /** Test files written or edited this run. */
  tests: string[];
  /** Code files (not tests) changed this run. */
  code: string[];
  /** A test run failed after tests were written and before the code changed: the tests were seen to bite. */
  red: boolean;
  /** Tests passed since the last code change. */
  green: boolean;
  /** A static check (typecheck, lint, vet) passed since the last code change. */
  checked: boolean;
};

const MAX_VERIFICATION_NUDGES = 1;

const VERIFICATION_NUDGE =
  "You changed the workspace but ended the turn without running anything that verifies it. Run the smallest relevant existing test, check, or smoke command and report the real result. Add a regression test only when the change would otherwise be unprotected. If this project genuinely has nothing relevant to run, say so explicitly instead of stopping silently.";

/**
 * Sent when the only evidence was a build, typecheck or lint.
 *
 * A passing compile is real but says nothing about behaviour, and accepting it as proof is how an
 * agent reports success for code that type-checks and does the wrong thing. This asks once for
 * executed tests; it does not hard-fail, because a compile *is* evidence and some changes have no
 * behaviour to assert.
 */
const TEST_EVIDENCE_NUDGE =
  "That build/typecheck passing shows the code compiles, not that it behaves correctly. Run the smallest relevant existing test or smoke command for the changed behaviour and report the real result. Add a regression test only when the change would otherwise be unprotected. If the change genuinely has no behaviour to assert (documentation, formatting, configuration), say so explicitly and stop.";

/** Test first: code changed and no test was written for it. Existing tests that already pin it are an answer. */
const TESTS_FIRST_NUDGE =
  "You changed code without writing a test for it, and this project builds test first. Write clean tests for the change now: invariants that hold for every valid input, one behavioural test per requested rule, one functional test of the assembled thing. Run them and make them pass. If existing tests already pin this behaviour, name them and run them; if the change truly has nothing to assert, say why in one line and stop.";

/** Test first, last step: tests are green but nothing static has looked at the code. */
const STATIC_ANALYSIS_NUDGE =
  "Finish with light static analysis: run the project's own typecheck, linter or vet (tsc --noEmit, go vet ./..., ruff check, cargo clippy: whatever it already uses) on what you changed, and fix what it reports in your code. Do not install new tools for this. If the project has none, say so in one line and stop.";

/** Appended once to the result of the first code edit that came before any test. */
const CODE_BEFORE_TESTS_NOTE =
  "[Test first: this changed code before any test was written in this turn. Next, write the tests that define this change (or run the existing ones that cover it) and see them fail for the right reason, then continue with the code.]";

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|go|py|rs|java|kt|kts|scala|rb|php|cs|swift|c|cc|cpp|cxx|h|hpp|m|mm|dart|ex|exs|erl|clj|hs|ml|lua|r|jl|zig|nim|vue|svelte|sh)$/i;
const TEST_PATH = [
  /(?:^|\/)(?:tests?|__tests__|specs?|testing|e2e)\//i,
  /\.(?:test|spec|e2e)\.[a-z]+$/i,
  /_test\.[a-z]+$/i,
  /(?:^|\/)test_[^/]+\.py$/i,
  /_spec\.rb$/i,
  /Tests?\.(?:java|kt|cs|swift|scala)$/,
];

/** A test file, a code file, or anything else (docs, config, styles), by its path alone. */
export function classifyPath(path: string): "test" | "code" | "other" {
  const normalized = path.replace(/\\/g, "/");
  if (TEST_PATH.some((pattern) => pattern.test(normalized))) return "test";
  return CODE_EXTENSIONS.test(normalized) ? "code" : "other";
}

/** `ARCHYMEDES_TEST_FIRST`: on unless it says off. */
export function testFirstFromEnvironment(environment: Record<string, string | undefined>): boolean {
  return !/^(?:off|false|0|no)$/i.test(environment.ARCHYMEDES_TEST_FIRST?.trim() ?? "");
}

/**
 * The same order of work, for an engine that keeps its own prompt and loop (Claude Code): appended
 * to its instructions, since no gate of ours runs inside it.
 */
export const TEST_FIRST_BRIEF = [
  "Build test first. For every code change: (1) before the code, write clean tests that define done in the project's own runner: invariants over edge inputs, one behavioural test per requested rule, one functional test of the assembled thing; run them and see them fail for the right reason (a bug fix starts with the test that reproduces it).",
  "(2) Write the smallest code that makes them pass; never weaken, skip or delete a test to get green. (3) Finish with light static analysis: the project's own typecheck, linter or vet on what you changed, fixing what it reports; install nothing for it.",
  "Report the tests written, that they failed then passed, and the check's result. Docs, configuration and changes with nothing to assert skip the tests and the check: say so in one line.",
].join(" ");

/** One tool result, as the gate needs it. */
export type GateRecord = {
  toolName: string;
  arguments: unknown;
  effect: ToolEffect;
  isError: boolean;
  verification?: VerificationEvidence;
  /** The tool's `data`: a failed run's `verificationKind` says a test run failed, which no `verification` records. */
  data?: Record<string, unknown>;
};

export class VerificationGate {
  private needsVerification = false;
  private verificationNudges = 0;
  private strongestEvidence = 0;
  private askedForTestEvidence = false;
  private askedForTests = false;
  private askedForStaticAnalysis = false;
  private notedCodeBeforeTests = false;
  private readonly tests = new Set<string>();
  private readonly code = new Set<string>();
  private red = false;
  private green = false;
  private checked = false;
  private lastShown = "";

  constructor(private readonly testFirst: boolean) {}

  /** Workspace changes not yet followed by passing evidence. */
  get unverified(): boolean {
    return this.needsVerification;
  }

  /** Folds in one tool result. Returns a note for the model to read with that result, if any. */
  record(entry: GateRecord): string | undefined {
    if (entry.isError) {
      // A failing test run after tests were written and before any code changed: red, as intended.
      const kind = entry.data?.verificationKind;
      if (this.tests.size > 0 && this.code.size === 0 && (kind === "tests" || kind === "smoke" || kind === "behavior")) this.red = true;
      return undefined;
    }
    let note: string | undefined;
    if (entry.effect === "workspace") {
      this.needsVerification = true;
      const path = pathOf(entry.arguments);
      const kind = path ? classifyPath(path) : "other";
      if (kind === "test") this.tests.add(path!);
      if (kind === "code") {
        if (this.testFirst && this.tests.size === 0 && !this.notedCodeBeforeTests) {
          this.notedCodeBeforeTests = true;
          note = CODE_BEFORE_TESTS_NOTE;
        }
        this.code.add(path!);
        this.green = false;
        this.checked = false;
      }
    }
    const evidence = entry.verification;
    if (evidence?.passed) {
      this.needsVerification = false;
      // Unclassified evidence reads as `check`: the weaker claim is the safe one to infer. Kept as
      // a maximum so a later weak check cannot demote what a stronger run established.
      this.strongestEvidence = Math.max(this.strongestEvidence, EVIDENCE_RANK[evidence.kind ?? "check"]);
      if ((evidence.kind ?? "check") === "check") this.checked = true;
      else this.green = true;
    }
    return note;
  }

  /**
   * At the model's stop: what to ask of it before the run may end, or undefined to let it end.
   * Test-first's own requests only apply when code changed; a docs or config change is held to
   * the ordinary evidence rules alone.
   */
  beforeFinish(): string | undefined {
    const building = this.testFirst && this.code.size > 0;
    if (building && this.tests.size === 0 && !this.askedForTests) {
      this.askedForTests = true;
      return TESTS_FIRST_NUDGE;
    }
    if (this.needsVerification && this.verificationNudges < MAX_VERIFICATION_NUDGES) {
      this.verificationNudges += 1;
      return VERIFICATION_NUDGE;
    }
    // One rung at a time up `EVIDENCE_RANK`: compile-only evidence is accepted in the end, but not
    // before asking once for executed tests.
    if (this.strongestEvidence === EVIDENCE_RANK.check && !this.askedForTestEvidence) {
      this.askedForTestEvidence = true;
      return TEST_EVIDENCE_NUDGE;
    }
    if (building && !this.checked && !this.askedForStaticAnalysis) {
      this.askedForStaticAnalysis = true;
      return STATIC_ANALYSIS_NUDGE;
    }
    return undefined;
  }

  /** Where a test-first run is, when that changed since the last call; undefined otherwise or when off. */
  takeState(): TestFirstState | undefined {
    if (!this.testFirst || (this.tests.size === 0 && this.code.size === 0)) return undefined;
    const state: TestFirstState = { tests: [...this.tests], code: [...this.code], red: this.red, green: this.green, checked: this.checked };
    const shown = JSON.stringify(state);
    if (shown === this.lastShown) return undefined;
    this.lastShown = shown;
    return state;
  }
}

function pathOf(argumentsValue: unknown): string | undefined {
  const path = (argumentsValue as { path?: unknown } | null)?.path;
  return typeof path === "string" && path.trim() ? path.trim() : undefined;
}
