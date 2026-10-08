/**
 * The input box while the agent is working.
 *
 * A coding agent's composer and its transcript are two different things. Pressing Enter moves the
 * message out of the box and into the transcript; the box is empty and ready again at once. Typing
 * while a turn runs is drafting the *next* message — it must never be printed into the answer that
 * is streaming, which is what happened when readline, still listening, echoed keystrokes at
 * whatever row the cursor was on. And Enter on that draft queues it as the next turn rather than
 * losing it or interrupting.
 *
 * Readline is muted rather than detached: its keypress listener keeps running, so the draft keeps
 * all of its line editing and Ctrl+C still reaches the interrupt handler. Only its echo is sent to
 * a sink, by pointing the interface's `output` at one for the duration — the documented field both
 * Node and Bun write through. A question asked mid-turn (an approval) gets the real output back for
 * exactly as long as it is pending, with the draft set aside so it does not prefill the answer.
 */
import type { Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { KeypressEvent } from "../terminal/keybindings";

export type TurnComposerOptions = {
  readline: Interface;
  input: NodeJS.ReadStream;
  /** Messages to run next, as though typed at the prompt; the session loop drains it. */
  queued: string[];
  /** Repaints the input row with the draft (or a hint when it is empty). Absent without a pinned input row. */
  paint?: (draft: string, queued: readonly string[]) => void;
  /** Stops the running turn — the same path Ctrl+C takes. */
  interrupt: () => void;
  /** True while Escape belongs to something else on screen, such as scrolled-back history. */
  escapeTaken?: () => boolean;
};

type MutableInterface = Interface & { output: NodeJS.WritableStream; line: string; question: Interface["question"] };

export function createTurnComposer(options: TurnComposerOptions): { begin(): void; end(): void; readonly active: boolean } {
  const rl = options.readline as MutableInterface;
  let active = false;
  let realOutput: NodeJS.WritableStream | undefined;
  let realQuestion: Interface["question"] | undefined;
  let asking = false;

  const sink = (): NodeJS.WritableStream => {
    const writable = new Writable({ write(_chunk, _encoding, done) { done(); } });
    // Readline sizes its line editing from the output's width; the sink reports the real one.
    Object.defineProperty(writable, "columns", { get: () => (realOutput as { columns?: number } | undefined)?.columns ?? 80 });
    return writable as unknown as NodeJS.WritableStream;
  };

  const repaint = () => {
    if (!active || asking) return;
    options.paint?.(rl.line ?? "", options.queued);
  };

  const clearDraft = () => {
    rl.write(null, { ctrl: true, name: "u" } as never);
    rl.write(null, { ctrl: true, name: "k" } as never);
  };

  const onKeypress = (_str: string | undefined, key: KeypressEvent | undefined) => {
    if (!active || asking) return;
    // A lone Escape arrives flagged `meta` (it is the meta prefix byte with nothing after it), so
    // the flag is not a reason to ignore it; Alt+letter chords never carry the name "escape".
    if (key?.name === "escape" && !key.ctrl && !options.escapeTaken?.()) {
      // Escape undoes the innermost thing first, as everywhere else: a draft is cleared before the
      // turn itself is interrupted.
      if ((rl.line ?? "") !== "") clearDraft();
      else options.interrupt();
    }
    // After readline has applied the key to its line.
    setImmediate(repaint);
  };

  const onLine = (line: string) => {
    if (!active || asking) return;
    if (line.trim() !== "") options.queued.push(line);
    setImmediate(repaint);
  };

  return {
    get active() { return active; },
    begin() {
      if (active) return;
      active = true;
      realOutput = rl.output;
      rl.output = sink();
      realQuestion = rl.question;
      const original = realQuestion.bind(rl) as (query: string, options?: { signal?: AbortSignal }) => Promise<string>;
      rl.question = ((query: string, questionOptions?: { signal?: AbortSignal }) => {
        // An approval or confirmation mid-turn: the real output back, the draft set aside.
        asking = true;
        const draft = rl.line ?? "";
        if (draft) clearDraft();
        rl.output = realOutput!;
        return original(query, questionOptions).finally(() => {
          asking = false;
          if (!active) return;
          rl.output = sink();
          if (draft) rl.write(draft);
          repaint();
        });
      }) as Interface["question"];
      options.input.on("keypress", onKeypress);
      rl.on("line", onLine);
      repaint();
    },
    end() {
      if (!active) return;
      active = false;
      options.input.off("keypress", onKeypress);
      rl.off("line", onLine);
      if (realQuestion) rl.question = realQuestion;
      if (realOutput) rl.output = realOutput;
      realOutput = undefined;
      realQuestion = undefined;
    },
  };
}

/** The hint an empty input row shows while a turn runs. */
export function turnComposerHint(queued: readonly string[]): string {
  const waiting = queued.length === 0 ? "" : ` · ${queued.length} queued`;
  return `type your next message · Enter queues it · Esc interrupts${waiting}`;
}
